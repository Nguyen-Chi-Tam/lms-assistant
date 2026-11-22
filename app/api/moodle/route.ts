import { NextResponse } from 'next/server';
import { runtimeEnv } from '../../../db/runtime';
import { getStudentFeedback } from '@/lib/feedback-store';
import { fetchWithCache, invalidateCache } from '@/lib/server-cache';
import { supabaseAdmin } from '@/lib/supabase';
import type { MoodleActivityItem } from '@/app/types';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  const authorization = request.headers.get('authorization');
  const clientToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  let moodleToken: string = clientToken || MOODLE_TOKEN || '';
  if (!MOODLE_URL || !moodleToken) {
    return NextResponse.json({
      mode: 'demo',
      courses: [],
      deadlines: [],
      resources: [],
      examResults: [],
      latestResult: null,
      syncedAt: new Date().toISOString(),
      message: 'Đăng nhập Moodle để tải các khóa học của bạn.',
    });
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get('force') === 'true' || request.headers.get('x-force-sync') === 'true';
  const cacheKey = `moodle_full_data_${moodleToken.slice(0, 12)}`;

  if (force) {
    invalidateCache(cacheKey);
  }

  try {
    const payload = await fetchWithCache(cacheKey, 60 * 1000, async () => {
      const base = `${MOODLE_URL.replace(/\/$/,'')}/webservice/rest/server.php`;
      const call = async <T>(fn:string, extra:Record<string,string>={}, tokenOverride?: string) => {
        const params=new URLSearchParams({wstoken:tokenOverride || moodleToken,wsfunction:fn,moodlewsrestformat:'json',...extra});
        const response=await fetch(`${base}?${params}`,{headers:{Accept:'application/json'}});
        if(!response.ok)throw new Error(`Moodle ${response.status}`);
        const data=await response.json() as T & {exception?:string;errorcode?:string;message?:string};
        if(data&&typeof data==='object'&&('exception' in data || 'errorcode' in data)) {
          const err = new Error(data.message ?? 'Moodle API error');
          if (data.errorcode === 'invalidtoken' || data.message?.toLowerCase().includes('token')) {
            (err as any).code = 'INVALID_TOKEN';
          }
          throw err;
        }
        return data;
      };
      let clientTokenExpired = false;
      let site: {userid:number;fullname:string;username?:string;userpictureurl?:string;userissiteadmin?:boolean};
      try {
        site = await call<{userid:number;fullname:string;username?:string;userpictureurl?:string;userissiteadmin?:boolean}>('core_webservice_get_site_info');
      } catch (firstErr: any) {
        if (clientToken && MOODLE_TOKEN && clientToken !== MOODLE_TOKEN && (firstErr?.code === 'INVALID_TOKEN' || firstErr?.message?.toLowerCase().includes('token'))) {
          moodleToken = MOODLE_TOKEN || '';
          clientTokenExpired = true;
          site = await call<{userid:number;fullname:string;username?:string;userpictureurl?:string;userissiteadmin?:boolean}>('core_webservice_get_site_info');
        } else {
          throw firstErr;
        }
      }

      // LMS Assistant is student-only: every Moodle account is treated as a
      // student, so no role resolution or per-course role lookup is needed.
      const courses=await call<Array<{id:number;shortname:string;fullname:string;progress?:number;startdate?:number;lastaccess?:number}>>('core_enrol_get_users_courses',{userid:String(site.userid)});
      const courseIdsParam = courses.slice(0, 50).reduce<Record<string, string>>((acc, c, i) => ({ ...acc, [`courseids[${i}]`]: String(c.id) }), {});
      const calendarCourseIdsParam = courses.slice(0, 50).reduce<Record<string, string>>((acc, c, i) => ({ ...acc, [`events[courseids][${i}]`]: String(c.id) }), {});
      const maxCalTime = String(Math.floor(Date.now() / 1000) + 180 * 86400);

      const [upcoming, courseCalendarRes, assignsRes, quizzesRes, gradeResults, moodleUrlsRes, moodlePagesRes, ...contents] = await Promise.all([
        call<{events?:Array<{id:number;name:string;description?:string;timestart:number;timeduration?:number;url?:string;course?:{id?:number;fullname?:string};modulename?:string;eventtype?:string;instance?:number}>}>('core_calendar_get_calendar_upcoming_view').catch(() => ({ events: [] })),
        (courses.length > 0
          ? call<{events?:Array<{id:number;name:string;description?:string;courseid?:number;modulename?:string;eventtype?:string;instance?:number;timestart:number;timeduration?:number;url?:string}>}>(
              'core_calendar_get_calendar_events',
              { ...calendarCourseIdsParam, 'options[timestart]': '0', 'options[timeend]': maxCalTime }
            ).catch(() =>
              MOODLE_TOKEN && MOODLE_TOKEN !== moodleToken
                ? call<{events?:Array<{id:number;name:string;description?:string;courseid?:number;modulename?:string;eventtype?:string;instance?:number;timestart:number;timeduration?:number;url?:string}>}>(
                    'core_calendar_get_calendar_events',
                    { ...calendarCourseIdsParam, 'options[timestart]': '0', 'options[timeend]': maxCalTime },
                    MOODLE_TOKEN
                  ).catch(() => ({ events: [] }))
                : ({ events: [] })
            )
          : Promise.resolve({ events: [] })),
        (courses.length > 0
          ? call<{courses?:Array<{id:number;shortname?:string;fullname?:string;assignments?:Array<{id:number;cmid?:number;course?:number;name:string;duedate?:number;allowsubmissionsfromdate?:number;intro?:string}>}>}>(
              'mod_assign_get_assignments',
              courseIdsParam
            ).catch(() => ({ courses: [] }))
          : Promise.resolve({ courses: [] })),
        (courses.length > 0
          ? call<{quizzes?:Array<{id:number;course:number;coursemodule?:number;name:string;timeopen?:number;timeclose?:number;intro?:string}>}>(
              'mod_quiz_get_quizzes_by_courses',
              courseIdsParam
            ).catch(() => ({ quizzes: [] }))
          : Promise.resolve({ quizzes: [] })),
        Promise.allSettled(
          courses.slice(0, 50).map(course =>
            call<{

            usergrades?: Array<{
              courseid: number;
              courseidnumber?: string;
              userid: number;
              userfullname?: string;
              gradeitems: Array<{
                id: number;
                itemname: string | null;
                itemtype: string;
                itemmodule: string | null;
                iteminstance?: number | null;
                cmid?: number | null;
                graderaw?: number | null;
                grademin?: number;
                grademax?: number;
                gradepass?: number;
                gradeformatted?: string;
                percentageformatted?: string;
                gradedategraded?: number | null;
                gradedatesubmitted?: number | null;
                feedback?: string;
              }>;
            }>;
          }>('gradereport_user_get_grade_items', {
            courseid: String(course.id),
            userid: String(site.userid),
          })
        )
      ),
      call<{ urls?: Array<{ id: number; coursemodule: number; course: number; name: string; externalurl: string }> }>(
        'mod_url_get_urls_by_courses',
        courseIdsParam
      ).catch(() => ({ urls: [] })),
      call<{ pages?: Array<{ id: number; coursemodule: number; course: number; name: string; content?: string }> }>(
        'mod_page_get_pages_by_courses',
        courseIdsParam
      ).catch(() => ({ pages: [] })),
      ...courses.slice(0,50).map(course=>call<Array<{id?:number;name?:string;section?:number;modules?:Array<{id:number;instance?:number;name:string;modname:string;contents?:Array<{filename:string;fileurl:string}>}>}>>('core_course_get_contents',{courseid:String(course.id)}).catch(()=>[])),
    ]);

    const externalUrlMap = new Map<number, string>();
    if (moodleUrlsRes && typeof moodleUrlsRes === 'object' && 'urls' in moodleUrlsRes && Array.isArray(moodleUrlsRes.urls)) {
      moodleUrlsRes.urls.forEach(u => {
        if (u.coursemodule && u.externalurl) {
          externalUrlMap.set(u.coursemodule, u.externalurl);
        }
      });
    }

    const pageContentMap = new Map<number, string>();
    if (moodlePagesRes && typeof moodlePagesRes === 'object' && 'pages' in moodlePagesRes && Array.isArray(moodlePagesRes.pages)) {
      moodlePagesRes.pages.forEach(p => {
        if (p.coursemodule && p.content) {
          pageContentMap.set(p.coursemodule, p.content);
        }
      });
    }

    const excludedMods = new Set(['forum', 'quiz', 'assign', 'assignment', 'feedback', 'survey', 'choice', 'chat', 'attendance']);
    const allowedExtensions = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt']);

    const resources = contents.flatMap((sections, index) =>
      sections.flatMap(section =>
        (section.modules ?? []).flatMap(module => {
          const modType = (module.modname || '').toLowerCase();
          if (excludedMods.has(modType)) return [];

          const files = (module.contents ?? [])
            .filter(file => {
              const ext = file.filename.split('.').pop()?.toLowerCase() || '';
              return allowedExtensions.has(ext);
            })
            .map(file => ({
              courseId: courses[index]?.id,
              courseCode: courses[index]?.shortname,
              courseName: courses[index]?.fullname,
              module: module.name,
              moduleId: module.id,
              fileId: (file as any).fileid ? Number((file as any).fileid) : Number(module.id),
              sectionId: section.id,
              sectionName: section.name,
              type: file.filename.split('.').pop()?.toUpperCase() || 'FILE',
              name: file.filename,
              url: file.fileurl ? `${file.fileurl}${file.fileurl.includes('?') ? '&' : '?'}token=${encodeURIComponent(moodleToken)}` : '',
            }));

          if (files.length > 0) return files;

          // If it is a web link / URL resource
          if (modType === 'url' || modType === 'page') {
            const externalUrl = externalUrlMap.get(module.id);
            const directUrl = module.contents?.[0]?.fileurl || '';
            const fallbackUrl = `${MOODLE_URL.replace(/\/$/, '')}/mod/${module.modname}/view.php?id=${module.id}`;
            const targetUrl = externalUrl || (directUrl ? (directUrl.startsWith('http') ? directUrl : `${directUrl}&token=${encodeURIComponent(moodleToken)}`) : fallbackUrl);

            return [
              {
                courseId: courses[index]?.id,
                courseCode: courses[index]?.shortname,
                courseName: courses[index]?.fullname,
                module: module.name,
                moduleId: module.id,
                fileId: Number(module.id),
                sectionId: section.id,
                sectionName: section.name,
                type: 'LINK',
                name: module.name,
                url: targetUrl,
              },
            ];
          }

          return [];
        })
      )
    );

    const cleanMoodleUrl = MOODLE_URL.replace(/\/$/, '');
    const courseById = new Map(courses.map(c => [Number(c.id), c]));

    // Map course modules (attendance, assign, quiz) from core_course_get_contents
    const attendanceCmidByCourse = new Map<number, number>();
    const moduleCmidMap = new Map<string, { cmid: number; name: string; instance?: number }>();
    contents.forEach((sections, idx) => {
      const cid = courses[idx]?.id;
      if (!cid || !Array.isArray(sections)) return;
      for (const sec of sections) {
        for (const mod of sec.modules ?? []) {
          const modType = (mod.modname || '').toLowerCase();
          if (modType === 'attendance' && mod.id) {
            attendanceCmidByCourse.set(cid, mod.id);
          }
          if (mod.id) {
            if (mod.instance) {
              moduleCmidMap.set(`${cid}:${modType}:inst:${mod.instance}`, { cmid: mod.id, name: mod.name, instance: mod.instance });
            }
            moduleCmidMap.set(`${cid}:${modType}:name:${(mod.name || '').toLowerCase().trim()}`, { cmid: mod.id, name: mod.name, instance: mod.instance });
          }
        }
      }
    });

    const stripHtml = (raw?: string) =>
      raw
        ? raw
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .trim()
        : undefined;

    const now = Date.now();
    const rawCalendarEvents = [
      ...(courseCalendarRes?.events ?? []).map(ev => ({
        id: ev.id,
        name: ev.name,
        courseId: ev.courseid,
        courseName: (ev.courseid && courseById.get(Number(ev.courseid))?.fullname) || 'Moodle',
        timestart: ev.timestart,
        timeduration: ev.timeduration,
        url: ev.url,
        modulename: ev.modulename,
        eventtype: ev.eventtype,
        instance: ev.instance,
        description: ev.description,
      })),
      ...(upcoming.events ?? []).map(ev => ({
        id: ev.id,
        name: ev.name,
        courseId: ev.course?.id,
        courseName: ev.course?.fullname ?? (ev.course?.id ? courseById.get(Number(ev.course.id))?.fullname : undefined) ?? 'Moodle',
        timestart: ev.timestart,
        timeduration: ev.timeduration,
        url: ev.url,
        modulename: ev.modulename,
        eventtype: ev.eventtype,
        instance: ev.instance,
        description: ev.description,
      })),
    ];

    const seenCalIds = new Set<number>();
    const deadlines = rawCalendarEvents
      .filter(ev => {
        if (!ev.id || seenCalIds.has(ev.id)) return false;
        seenCalIds.add(ev.id);
        return true;
      })
      .map(event => {
        const mod = (event.modulename || '').toLowerCase();
        const cid = Number(event.courseId || 0);
        let fallbackUrl = event.url;
        if (!fallbackUrl && cid) {
          if (mod === 'attendance' && attendanceCmidByCourse.has(cid)) {
            fallbackUrl = `${cleanMoodleUrl}/mod/attendance/view.php?id=${attendanceCmidByCourse.get(cid)}`;
          } else if (event.instance && moduleCmidMap.has(`${cid}:${mod}:inst:${event.instance}`)) {
            fallbackUrl = `${cleanMoodleUrl}/mod/${mod}/view.php?id=${moduleCmidMap.get(`${cid}:${mod}:inst:${event.instance}`)!.cmid}`;
          } else {
            fallbackUrl = `${cleanMoodleUrl}/course/view.php?id=${cid}`;
          }
        }
        return {
          id: event.id,
          name: event.name,
          courseId: cid || undefined,
          courseName: event.courseName || 'Moodle',
          timestamp: event.timestart * 1000,
          url: fallbackUrl,
          modulename: event.modulename,
          eventtype: event.eventtype,
          description: stripHtml(event.description),
        };
      });
    const avatarUrl = moodleToken
      ? `/api/moodle/avatar?token=${encodeURIComponent(moodleToken)}&id=${site.userid}`
      : site.userpictureurl || null;

    const examResults: Array<{
      id: number;
      courseId: number;
      courseName: string;
      courseCode: string;
      name: string;
      itemModule: string;
      quizId?: number;
      cmid?: number;
      attemptId?: number;
      studentUserId?: number;
      score: number;
      maxScore: number;
      minScore: number;
      percentage: string;
      gradedAt: number;
      feedback: string;
      passed: boolean;
      url: string;
    }> = [];

    gradeResults.forEach((res, idx) => {
      if (res.status !== 'fulfilled' || !res.value?.usergrades) return;
      const course = courses[idx];
      if (!course) return;

      for (const ug of res.value.usergrades) {
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
          // Exclude attendance items from gradebook/examResults
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

          // Round grade to at most one decimal place (e.g. 6.16667 -> 6.2)
          const roundedScore = Math.round(rawScore * 10) / 10;

          let maxScore = Number(item.grademax ?? 10);
          const minScore = Number(item.grademin ?? 0);
          // If grade is on standard 10-point scale but Moodle grademax was left at 100
          if (maxScore === 100 && roundedScore <= 10) {
            maxScore = 10;
          }

          const passGrade = item.gradepass && item.gradepass > 0 ? item.gradepass : (maxScore / 2);
          const passed = roundedScore >= passGrade;

          let percentage = '';
          if (maxScore > 0) {
            percentage = `${Math.round((roundedScore / maxScore) * 100)}%`;
          }

          const timestamp = (item.gradedategraded || item.gradedatesubmitted || 0) * 1000;
          const url = item.cmid
            ? `${MOODLE_URL.replace(/\/$/, '')}/mod/${item.itemmodule || 'quiz'}/view.php?id=${item.cmid}`
            : `${MOODLE_URL.replace(/\/$/, '')}/course/view.php?id=${course.id}`;

          let feedback = item.feedback?.replace(/<[^>]*>/g, '').trim() || '';
          if (!feedback) {
            const stored =
              getStudentFeedback(site.userid, course.id, item.itemname) ||
              (site.username ? getStudentFeedback(site.username, course.id, item.itemname) : null);
            if (stored && stored.feedback) {
              feedback = stored.feedback.trim();
            }
          }

          examResults.push({
            id: item.id,
            courseId: course.id,
            courseName: course.fullname,
            courseCode: course.shortname,
            name: item.itemname,
            itemModule: item.itemmodule || 'manual',
            quizId: item.iteminstance ? Number(item.iteminstance) : undefined,
            cmid: item.cmid ? Number(item.cmid) : undefined,
            studentUserId: ug.userid ? Number(ug.userid) : site.userid,
            score: roundedScore,
            maxScore,
            minScore,
            percentage,
            gradedAt: timestamp || Date.now(),
            feedback,
            passed,
            url,
          });
        }
      }
    });

    // Fetch attemptId for quiz items in parallel
    const quizFetchList: Array<{ quizId: number; userId: number; itemRef: (typeof examResults)[number] }> = [];
    examResults.forEach(resItem => {
      if (resItem.itemModule === 'quiz' && resItem.quizId) {
        quizFetchList.push({
          quizId: resItem.quizId,
          userId: resItem.studentUserId || site.userid,
          itemRef: resItem,
        });
      }
    });

    if (quizFetchList.length > 0) {
      await Promise.allSettled(
        quizFetchList.map(async ({ quizId, userId, itemRef }) => {
          try {
            const attData = await call<{
              attempts?: Array<{ id: number; state: string; timemodified: number }>;
            }>('mod_quiz_get_user_attempts', {
              quizid: String(quizId),
              userid: String(userId),
              status: 'all',
              includepreviews: '1',
            });
            if (attData?.attempts && attData.attempts.length > 0) {
              const sorted = [...attData.attempts].sort((a, b) => (b.timemodified || 0) - (a.timemodified || 0));
              const finished = sorted.find(a => a.state === 'finished') || sorted[0];
              if (finished) {
                itemRef.attemptId = finished.id;
              }
            }
          } catch {
            // Ignore attempt fetch error
          }
        })
      );
    }

    // Deduplicate by courseId + exam name/id to prevent duplicate cards/records
    const seenExamKeys = new Set<string>();
    const deduplicatedExamResults = examResults.filter(r => {
      const key = `${r.courseId}-${r.name || r.id}`;
      if (seenExamKeys.has(key)) return false;
      seenExamKeys.add(key);
      return true;
    });

    deduplicatedExamResults.sort((a, b) => (b.gradedAt || 0) - (a.gradedAt || 0));
    const latestResult = deduplicatedExamResults[0] || null;

    // ── Build comprehensive activities (Homework, Attendance, Quiz — past & upcoming) ──
    const activities: MoodleActivityItem[] = [];
    const seenActivityKeys = new Set<string>();

    // Index grade items by courseId + module + instance/name to know submission & score status
    type GradeItemSnap = {
      id: number;
      name: string;
      mod: string;
      instance?: number | null;
      cmid?: number | null;
      rawScore: number | null;
      maxScore: number;
      submittedAt: number | null;
      gradedAt: number | null;
    };
    const gradeItemSnaps: GradeItemSnap[] = [];
    gradeResults.forEach((res, idx) => {
      if (res.status !== 'fulfilled' || !res.value?.usergrades) return;
      const course = courses[idx];
      if (!course) return;
      for (const ug of res.value.usergrades) {
        for (const item of ug.gradeitems || []) {
          if (item.itemtype === 'course' || !item.itemname?.trim()) continue;
          const raw = item.graderaw !== null && item.graderaw !== undefined && !isNaN(Number(item.graderaw))
            ? Math.round(Number(item.graderaw) * 10) / 10
            : null;
          let max = Number(item.grademax ?? 10);
          if (max === 100 && raw !== null && raw <= 10) max = 10;
          gradeItemSnaps.push({
            id: item.id,
            name: item.itemname.trim(),
            mod: (item.itemmodule || '').toLowerCase(),
            instance: item.iteminstance,
            cmid: item.cmid,
            rawScore: raw,
            maxScore: max,
            submittedAt: item.gradedatesubmitted ? item.gradedatesubmitted * 1000 : null,
            gradedAt: item.gradedategraded ? item.gradedategraded * 1000 : null,
          });
        }
      }
    });

    // Collect all assignment IDs across courses to batch-check submission status
    const allAssignMeta = new Map<string, {
      courseId: number;
      assignId: number;
      cmid?: number;
      name: string;
      duedate?: number;
      openDate?: number;
      description?: string;
    }>();

    for (const c of assignsRes?.courses ?? []) {
      const cid = Number(c.id);
      if (!courseById.has(cid)) continue;
      for (const a of c.assignments ?? []) {
        allAssignMeta.set(`${cid}:${a.id}`, {
          courseId: cid,
          assignId: Number(a.id),
          cmid: a.cmid ? Number(a.cmid) : moduleCmidMap.get(`${cid}:assign:inst:${a.id}`)?.cmid,
          name: a.name,
          duedate: a.duedate ? a.duedate * 1000 : undefined,
          openDate: a.allowsubmissionsfromdate ? a.allowsubmissionsfromdate * 1000 : undefined,
          description: stripHtml(a.intro),
        });
      }
    }

    // Also include assignments discovered from grade items or calendar events
    gradeResults.forEach((res, idx) => {
      if (res.status !== 'fulfilled' || !res.value?.usergrades) return;
      const course = courses[idx];
      if (!course) return;
      for (const ug of res.value.usergrades) {
        for (const item of ug.gradeitems || []) {
          if ((item.itemmodule || '').toLowerCase() === 'assign' && item.iteminstance && item.itemname) {
            const key = `${course.id}:${item.iteminstance}`;
            if (!allAssignMeta.has(key)) {
              allAssignMeta.set(key, {
                courseId: course.id,
                assignId: Number(item.iteminstance),
                cmid: item.cmid ? Number(item.cmid) : moduleCmidMap.get(`${course.id}:assign:inst:${item.iteminstance}`)?.cmid,
                name: item.itemname.trim(),
              });
            }
          }
        }
      }
    });

    for (const ev of rawCalendarEvents) {
      if ((ev.modulename || '').toLowerCase() === 'assign' && ev.courseId && ev.instance) {
        const cid = Number(ev.courseId);
        if (!courseById.has(cid)) continue;
        const key = `${cid}:${ev.instance}`;
        const cleanName = (ev.name || 'Bài tập')
          .replace(/\s+(?:is due|due|tới hạn|đến hạn|hạn chót|opens?|closes?|bắt đầu|kết thúc).*$/i, '')
          .trim();
        const existing = allAssignMeta.get(key);
        if (existing) {
          if (!existing.duedate && ev.timestart) existing.duedate = ev.timestart * 1000;
          if (!existing.description && ev.description) existing.description = stripHtml(ev.description);
        } else {
          allAssignMeta.set(key, {
            courseId: cid,
            assignId: Number(ev.instance),
            cmid: moduleCmidMap.get(`${cid}:assign:inst:${ev.instance}`)?.cmid,
            name: cleanName || ev.name,
            duedate: ev.timestart ? ev.timestart * 1000 : undefined,
            description: stripHtml(ev.description),
          });
        }
      }
    }

    // Batch-check submissions via mod_assign_get_submissions
    const assignSubmittedByUser = new Map<number, number>(); // assignId -> submittedAt ms
    const allAssignIds = Array.from(new Set(Array.from(allAssignMeta.values()).map(a => a.assignId).filter(Boolean)));
    if (allAssignIds.length > 0) {
      try {
        const subParams = allAssignIds.reduce<Record<string, string>>(
          (acc, id, i) => ({ ...acc, [`assignmentids[${i}]`]: String(id) }),
          {}
        );
        const subData = await call<{
          assignments?: Array<{
            assignmentid: number;
            submissions?: Array<{
              userid: number;
              status: string;
              timemodified?: number;
              plugins?: Array<{
                type?: string;
                editorfields?: Array<{ text?: string }>;
                fileareas?: Array<{ files?: unknown[] }>;
              }>;
            }>;
          }>;
        }>('mod_assign_get_submissions', subParams, MOODLE_TOKEN || moodleToken).catch(() => ({ assignments: [] }));

        for (const a of subData?.assignments ?? []) {
          for (const sub of a.submissions ?? []) {
            if (Number(sub.userid) !== Number(site.userid)) continue;
            const plugins = sub.plugins ?? [];
            const hasText = plugins.some(
              p => p.type === 'onlinetext' && p.editorfields?.some(f => f.text && f.text.trim() !== '' && f.text !== '<p></p>')
            );
            const hasFile = plugins.some(
              p => p.type === 'file' && p.fileareas?.some(fa => Array.isArray(fa.files) && fa.files.length > 0)
            );
            if (sub.status === 'submitted' || hasText || hasFile) {
              assignSubmittedByUser.set(Number(a.assignmentid), (sub.timemodified || Math.floor(now / 1000)) * 1000);
            }
          }
        }
      } catch {
        // Ignore batch submission error
      }
    }

    // 1. Add Homework (assign) activities
    for (const meta of allAssignMeta.values()) {
      const course = courseById.get(meta.courseId);
      if (!course) continue;
      const gradeSnap = gradeItemSnaps.find(
        g => g.mod === 'assign' && (Number(g.instance) === meta.assignId || (meta.cmid && Number(g.cmid) === meta.cmid))
      );
      const submittedAt =
        assignSubmittedByUser.get(meta.assignId) ||
        gradeSnap?.submittedAt ||
        gradeSnap?.gradedAt ||
        null;
      const score = gradeSnap?.rawScore ?? null;
      const maxScore = gradeSnap?.maxScore ?? 100;
      const isSubmitted = Boolean(submittedAt || score !== null);
      const dueMs = meta.duedate || 0;

      let status: MoodleActivityItem['status'] = 'pending';
      if (isSubmitted) {
        status = 'completed';
      } else if (dueMs > 0 && dueMs < now) {
        status = 'missed';
      } else if (meta.openDate && meta.openDate <= now && (!dueMs || dueMs >= now)) {
        status = 'open_now';
      }

      const cmid = meta.cmid || gradeSnap?.cmid || undefined;
      const url = cmid
        ? `${cleanMoodleUrl}/mod/assign/view.php?id=${cmid}`
        : `${cleanMoodleUrl}/course/view.php?id=${course.id}`;

      const actKey = `homework:${course.id}:${meta.assignId}`;
      if (seenActivityKeys.has(actKey)) continue;
      seenActivityKeys.add(actKey);

      activities.push({
        id: actKey,
        moodleId: meta.assignId,
        courseId: course.id,
        courseCode: course.shortname,
        courseName: course.fullname,
        name: meta.name,
        type: 'homework',
        timestamp: dueMs || meta.openDate || now,
        openTimestamp: meta.openDate,
        closeTimestamp: dueMs || undefined,
        status,
        submittedAt,
        score,
        maxScore,
        url,
        cmid: cmid ?? undefined,
        instanceId: meta.assignId,
        description: meta.description,
      });
    }

    // 2. Add Attendance session activities from calendar events
    for (const ev of rawCalendarEvents) {
      const mod = (ev.modulename || '').toLowerCase();
      const evType = (ev.eventtype || '').toLowerCase();
      if (mod !== 'attendance' && evType !== 'attendance') continue;
      const cid = Number(ev.courseId || 0);
      const course = courseById.get(cid);
      if (!course) continue;

      const openMs = ev.timestart * 1000;
      const durSec = Number(ev.timeduration || 600);
      const closeMs = openMs + durSec * 1000;
      const actKey = `attendance:${cid}:${ev.id || ev.timestart}`;
      if (seenActivityKeys.has(actKey)) continue;
      seenActivityKeys.add(actKey);

      const attCmid = attendanceCmidByCourse.get(cid);
      const url = attCmid
        ? `${cleanMoodleUrl}/mod/attendance/view.php?id=${attCmid}`
        : `${cleanMoodleUrl}/course/view.php?id=${cid}`;

      let status: MoodleActivityItem['status'] = 'pending';
      if (now >= openMs && now <= closeMs) {
        status = 'open_now';
      } else if (now > closeMs) {
        status = 'missed';
      }

      activities.push({
        id: actKey,
        moodleId: ev.id,
        courseId: course.id,
        courseCode: course.shortname,
        courseName: course.fullname,
        name: ev.name && ev.name.toLowerCase() !== 'attendance' ? ev.name : 'Điểm danh buổi học',
        type: 'attendance',
        timestamp: openMs,
        openTimestamp: openMs,
        closeTimestamp: closeMs,
        durationSeconds: durSec,
        status,
        url,
        cmid: attCmid,
        instanceId: ev.instance,
        description: stripHtml(ev.description),
      });
    }

    // 3. Add Quiz activities
    const quizMetaMap = new Map<string, {
      courseId: number;
      quizId: number;
      cmid?: number;
      name: string;
      openMs?: number;
      closeMs?: number;
    }>();

    for (const q of quizzesRes?.quizzes ?? []) {
      const cid = Number(q.course);
      if (!courseById.has(cid)) continue;
      quizMetaMap.set(`${cid}:${q.id}`, {
        courseId: cid,
        quizId: Number(q.id),
        cmid: q.coursemodule ? Number(q.coursemodule) : moduleCmidMap.get(`${cid}:quiz:inst:${q.id}`)?.cmid,
        name: q.name,
        openMs: q.timeopen ? q.timeopen * 1000 : undefined,
        closeMs: q.timeclose ? q.timeclose * 1000 : undefined,
      });
    }

    for (const ev of rawCalendarEvents) {
      if ((ev.modulename || '').toLowerCase() === 'quiz' && ev.courseId && ev.instance) {
        const cid = Number(ev.courseId);
        if (!courseById.has(cid)) continue;
        const key = `${cid}:${ev.instance}`;
        const cleanName = (ev.name || 'Kiểm tra')
          .replace(/\s+(?:opens?|closes?|is due|due|bắt đầu|kết thúc|mở|đóng).*$/i, '')
          .trim();
        const existing = quizMetaMap.get(key) || {
          courseId: cid,
          quizId: Number(ev.instance),
          cmid: moduleCmidMap.get(`${cid}:quiz:inst:${ev.instance}`)?.cmid,
          name: cleanName || ev.name,
        };
        if (ev.eventtype === 'open' && ev.timestart) existing.openMs = ev.timestart * 1000;
        if (ev.eventtype === 'close' && ev.timestart) existing.closeMs = ev.timestart * 1000;
        if (!existing.openMs && ev.timestart) existing.openMs = ev.timestart * 1000;
        quizMetaMap.set(key, existing);
      }
    }

    for (const meta of quizMetaMap.values()) {
      const course = courseById.get(meta.courseId);
      if (!course) continue;
      const actKey = `quiz:${course.id}:${meta.quizId}`;
      if (seenActivityKeys.has(actKey)) continue;
      seenActivityKeys.add(actKey);

      const examMatch = deduplicatedExamResults.find(
        r => r.courseId === course.id && (Number(r.quizId) === meta.quizId || r.name.toLowerCase().trim() === meta.name.toLowerCase().trim())
      );
      const isCompleted = Boolean(examMatch);
      const closeMs = meta.closeMs || 0;
      const openMs = meta.openMs || 0;

      let status: MoodleActivityItem['status'] = 'pending';
      if (isCompleted) {
        status = 'completed';
      } else if (closeMs > 0 && closeMs < now) {
        status = 'missed';
      } else if (openMs > 0 && openMs <= now && (!closeMs || closeMs >= now)) {
        status = 'open_now';
      }

      const cmid = meta.cmid || examMatch?.cmid || undefined;
      const url = cmid
        ? `${cleanMoodleUrl}/mod/quiz/view.php?id=${cmid}`
        : `${cleanMoodleUrl}/course/view.php?id=${course.id}`;

      activities.push({
        id: actKey,
        moodleId: meta.quizId,
        courseId: course.id,
        courseCode: course.shortname,
        courseName: course.fullname,
        name: meta.name,
        type: 'quiz',
        timestamp: closeMs || openMs || examMatch?.gradedAt || now,
        openTimestamp: openMs || undefined,
        closeTimestamp: closeMs || undefined,
        status,
        submittedAt: examMatch?.gradedAt ?? null,
        score: examMatch?.score ?? null,
        maxScore: examMatch?.maxScore ?? 10,
        url,
        cmid,
        instanceId: meta.quizId,
      });
    }

    activities.sort((a, b) => {
      const aPending = (a.status === 'pending' || a.status === 'open_now') && (!a.closeTimestamp || a.closeTimestamp >= now);
      const bPending = (b.status === 'pending' || b.status === 'open_now') && (!b.closeTimestamp || b.closeTimestamp >= now);
      if (aPending !== bPending) return aPending ? -1 : 1;
      const aTime = a.status === 'completed' && a.submittedAt ? a.submittedAt : (a.closeTimestamp || a.timestamp || a.openTimestamp || 0);
      const bTime = b.status === 'completed' && b.submittedAt ? b.submittedAt : (b.closeTimestamp || b.timestamp || b.openTimestamp || 0);
      return bTime - aTime;
    });

    // NOTE: LMS Assistant is student-only; keep the users table in sync with
    // the single student role.
    if (supabaseAdmin) {
      try {
        await supabaseAdmin.from('users').upsert(
          {
            moodle_user_id: site.userid,
            role: 'student',
            name: site.fullname || site.username,
          },
          { onConflict: 'moodle_user_id' }
        );
      } catch (sbErr) {
        console.warn('Supabase user sync warning in moodle route:', sbErr);
      }
    }

      return {
        mode: 'live',
        user: {
          id: site.userid,
          name: site.fullname,
          username: site.username,
          avatarUrl,
        },
        courses,
        deadlines,
        activities,
        resources,
        examResults: deduplicatedExamResults,
        latestResult,
        syncedAt: new Date().toISOString(),
        moodleUrl: MOODLE_URL ? MOODLE_URL.replace(/\/$/, '') : 'http://moodle.test',
        clientTokenExpired,
      };
    });

    return NextResponse.json(payload);
  } catch (error: any) {
    const isTokenErr = error?.code === 'INVALID_TOKEN' || error?.message?.toLowerCase().includes('token');
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Không thể đồng bộ Moodle.',
        code: isTokenErr ? 'INVALID_TOKEN' : 'MOODLE_SYNC_ERROR',
        tokenExpired: isTokenErr,
      },
      { status: isTokenErr ? 401 : 502 }
    );
  }
}
