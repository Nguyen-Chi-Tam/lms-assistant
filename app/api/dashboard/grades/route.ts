import { NextResponse } from 'next/server';
import { runtimeEnv } from '@/db/runtime';
import { fetchWithCache, invalidateCache } from '@/lib/server-cache';
import { supabaseAdmin } from '@/lib/supabase';
import type {
  CourseAnalyticsItem,
  CourseGradeSummary,
  DashboardGradesResponse,
  GradeItemAnalytics,
} from '@/app/types';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  const authorization = request.headers.get('authorization');
  const clientToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const { searchParams } = new URL(request.url);
  const paramToken = searchParams.get('token')?.trim() || '';

  const moodleToken = clientToken || paramToken || MOODLE_TOKEN || '';
  if (!MOODLE_URL || !moodleToken) {
    return NextResponse.json<DashboardGradesResponse>({
      mode: 'demo',
      overall_average_pct: null,
      overall_gpa_10: null,
      courses: [],
      syncedAt: new Date().toISOString(),
      error: 'Vui lòng đăng nhập Moodle để đồng bộ bảng điểm và phân tích.',
    });
  }

  const force = searchParams.get('force') === 'true' || request.headers.get('x-force-sync') === 'true';
  const cacheKey = `moodle_dashboard_grades_${moodleToken.slice(0, 12)}`;

  if (force) {
    invalidateCache(cacheKey);
  }

  try {
    const payload = await fetchWithCache(cacheKey, 60 * 1000, async () => {
      const base = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;

      const call = async <T>(fn: string, extra: Record<string, string> = {}) => {
        const params = new URLSearchParams({
          wstoken: moodleToken,
          wsfunction: fn,
          moodlewsrestformat: 'json',
          ...extra,
        });
        const res = await fetch(`${base}?${params}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Moodle API ${res.status}`);
        const data = (await res.json()) as T & { exception?: string; errorcode?: string; message?: string };
        if (data && typeof data === 'object' && ('exception' in data || 'errorcode' in data)) {
          const err = new Error(data.message ?? 'Moodle API error');
          if (data.errorcode === 'invalidtoken' || data.message?.toLowerCase().includes('token')) {
            (err as any).code = 'INVALID_TOKEN';
          }
          throw err;
        }
        return data;
      };

      // 1. Get current student info
      const site = await call<{ userid: number; fullname: string; username?: string }>('core_webservice_get_site_info');

      // Sync user to Supabase users table (anchor reference)
      if (supabaseAdmin) {
        try {
          await supabaseAdmin.from('users').upsert(
            {
              moodle_user_id: site.userid,
              role: 'student',
              name: site.fullname || site.username || `User ${site.userid}`,
            },
            { onConflict: 'moodle_user_id' }
          );
        } catch (sbErr) {
          console.warn('Supabase user upsert notice in dashboard grades:', sbErr);
        }
      }

      // 2. Fetch enrolled courses
      const courses = await call<Array<{ id: number; shortname: string; fullname: string }>>(
        'core_enrol_get_users_courses',
        { userid: String(site.userid) }
      );

      const activeCourseList = Array.isArray(courses) ? courses : [];
      const activeCourseIds = activeCourseList.map(c => Number(c.id)).filter(id => !isNaN(id) && id > 0);

      // 3. Fetch grade items for all enrolled courses in parallel
      const gradeResults = await Promise.allSettled(
        activeCourseList.map(c =>
          call<{
            usergrades?: Array<{
              courseid: number;
              gradeitems?: Array<{
                id: number;
                itemname: string | null;
                itemtype: string;
                itemmodule: string | null;
                graderaw?: number | null;
                grademin?: number;
                grademax?: number;
                gradedategraded?: number | null;
                gradedatesubmitted?: number | null;
                feedback?: string;
              }>;
            }>;
          }>('gradereport_user_get_grade_items', {
            courseid: String(c.id),
            userid: String(site.userid),
          })
        )
      );

      const courseAnalyticsList: CourseAnalyticsItem[] = [];

      // 5. Calculate statistics and build grade_summary per course
      activeCourseList.forEach((course, idx) => {
        const gradeRes = gradeResults[idx];
        const rawItems: GradeItemAnalytics[] = [];

        if (gradeRes.status === 'fulfilled' && gradeRes.value?.usergrades) {
          for (const ug of gradeRes.value.usergrades) {
            for (const item of ug.gradeitems || []) {
              if (
                item.itemtype === 'course' ||
                !item.itemname ||
                item.itemname.trim() === '' ||
                item.graderaw === null ||
                item.graderaw === undefined
              ) {
                continue;
              }

              const itemModule = (item.itemmodule || '').toLowerCase();
              const itemName = (item.itemname || '').toLowerCase();
              if (
                itemModule === 'attendance' ||
                itemModule.includes('attendance') ||
                itemName.includes('attendance') ||
                itemName.includes('điểm danh')
              ) {
                continue;
              }

              const rawScore = Number(item.graderaw);
              if (isNaN(rawScore)) continue;

              let maxScore = Number(item.grademax ?? 10);
              // Handle Moodle scale quirks (e.g. maxScore=100 for a 10-point quiz)
              if (maxScore === 100 && rawScore <= 10) {
                maxScore = 10;
              }

              const pct = maxScore > 0 ? Number(((rawScore / maxScore) * 100).toFixed(1)) : 0;
              const dateVal = (item.gradedategraded || item.gradedatesubmitted || 0) * 1000;
              const updatedAtStr = dateVal > 0 ? new Date(dateVal).toISOString() : new Date().toISOString();

              rawItems.push({
                name: item.itemname.trim(),
                rawScore: Math.round(rawScore * 10) / 10,
                maxScore,
                pct,
                updated_at: updatedAtStr,
              });
            }
          }
        }

        // Calculate average_pct
        const average_pct = rawItems.length > 0
          ? Number((rawItems.reduce((sum, item) => sum + item.pct, 0) / rawItems.length).toFixed(1))
          : null;

        // Identify Strengths (>= 80%) & Weaknesses (< 65%)
        const strengths = rawItems
          .filter(it => it.pct >= 80)
          .map(it => `${it.name} (${Math.round(it.pct)}%)`);

        const weaknesses = rawItems
          .filter(it => it.pct < 65)
          .map(it => `${it.name} (${Math.round(it.pct)}%)`);

        // Bảng user_course_analytics đã bị gỡ: xu hướng được suy từ chính các đầu điểm theo thời gian.
        const previous_average_pct: number | null = null;
        let delta: number | null = null;
        let trend: 'improving' | 'declining' | 'stable' | 'insufficient_data' = 'insufficient_data';

        if (rawItems.length >= 2) {
          const dated = [...rawItems].sort(
            (a, b) => Date.parse(a.updated_at ?? '') - Date.parse(b.updated_at ?? '')
          );
          const first = dated[0];
          const latest = dated[dated.length - 1];
          if (first.updated_at !== latest.updated_at) {
            delta = Number((latest.pct - first.pct).toFixed(1));
            trend = delta >= 5.0 ? 'improving' : delta <= -5.0 ? 'declining' : 'stable';
          }
        }

        const newGradeSummary: CourseGradeSummary = {
          average_pct,
          previous_average_pct,
          delta,
          trend,
          strengths,
          weaknesses,
          items: rawItems,
        };

        courseAnalyticsList.push({
          courseId: course.id,
          courseName: course.fullname,
          courseCode: course.shortname,
          grade_summary: newGradeSummary,
          feedback_history: [],
        });
      });

      // 6. Lazy cleanup: chỉ dọn semantic_query_cache (bảng user_course_analytics đã bị gỡ).
      if (supabaseAdmin && activeCourseIds.length > 0) {
        const activeIdsTuple = `(${activeCourseIds.join(',')})`;
        void Promise.allSettled([
          supabaseAdmin
            .from('semantic_query_cache')
            .delete()
            .not('course_id', 'in', activeIdsTuple),
        ]).catch(() => {});
      }

      // 7. Overall GPA and metrics calculation
      const scoredCourses = courseAnalyticsList.filter(c => c.grade_summary.average_pct !== null);
      const overallAveragePct = scoredCourses.length > 0
        ? Number((scoredCourses.reduce((sum, c) => sum + (c.grade_summary.average_pct || 0), 0) / scoredCourses.length).toFixed(1))
        : null;

      const overallGpa10 = overallAveragePct !== null
        ? Number((overallAveragePct / 10).toFixed(1))
        : null;

      const responsePayload: DashboardGradesResponse = {
        mode: 'live',
        overall_average_pct: overallAveragePct,
        overall_gpa_10: overallGpa10,
        courses: courseAnalyticsList,
        syncedAt: new Date().toISOString(),
      };

      return responsePayload;
    });

    return NextResponse.json(payload);
  } catch (error: any) {
    const isTokenErr = error?.code === 'INVALID_TOKEN' || error?.message?.toLowerCase().includes('token');
    return NextResponse.json<DashboardGradesResponse>(
      {
        mode: 'demo',
        overall_average_pct: null,
        overall_gpa_10: null,
        courses: [],
        syncedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Không thể đồng bộ bảng điểm từ Moodle.',
      },
      { status: isTokenErr ? 401 : 502 }
    );
  }
}
