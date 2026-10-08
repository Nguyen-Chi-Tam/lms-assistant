import { NextResponse } from 'next/server';
import { runtimeEnv } from '../../../db/runtime';
import { getStudentFeedback } from '@/lib/feedback-store';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  const authorization = request.headers.get('authorization');
  const clientToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  let moodleToken = clientToken || MOODLE_TOKEN;
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
  const base = `${MOODLE_URL.replace(/\/$/,'')}/webservice/rest/server.php`;
  const call = async <T>(fn:string, extra:Record<string,string>={}) => {
    const params=new URLSearchParams({wstoken:moodleToken,wsfunction:fn,moodlewsrestformat:'json',...extra});
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
  try {
    let site: {userid:number;fullname:string;username?:string;userpictureurl?:string;userissiteadmin?:boolean};
    try {
      site = await call<{userid:number;fullname:string;username?:string;userpictureurl?:string;userissiteadmin?:boolean}>('core_webservice_get_site_info');
    } catch (firstErr: any) {
      if (clientToken && MOODLE_TOKEN && clientToken !== MOODLE_TOKEN && (firstErr?.code === 'INVALID_TOKEN' || firstErr?.message?.toLowerCase().includes('token'))) {
        moodleToken = MOODLE_TOKEN;
        clientTokenExpired = true;
        site = await call<{userid:number;fullname:string;username?:string;userpictureurl?:string;userissiteadmin?:boolean}>('core_webservice_get_site_info');
      } else {
        throw firstErr;
      }
    }
    const courses=await call<Array<{id:number;shortname:string;fullname:string;progress?:number;startdate?:number;lastaccess?:number}>>('core_enrol_get_users_courses',{userid:String(site.userid)});
    const [upcoming, gradeResults, courseEnrolledUsers, moodleUrlsRes, moodlePagesRes, ...contents] = await Promise.all([
      call<{events?:Array<{id:number;name:string;description?:string;timestart:number;url?:string;course?:{fullname?:string};modulename?:string;eventtype?:string}>}>('core_calendar_get_calendar_upcoming_view'),
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
      Promise.allSettled(
        courses.slice(0, 50).map(course =>
          call<Array<{ id: number; roles?: Array<{ roleid: number; shortname: string }> }>>('core_enrol_get_enrolled_users', {
            courseid: String(course.id),
          })
        )
      ),
      call<{ urls?: Array<{ id: number; coursemodule: number; course: number; name: string; externalurl: string }> }>(
        'mod_url_get_urls_by_courses',
        courses.slice(0, 50).reduce((acc, c, i) => ({ ...acc, [`courseids[${i}]`]: String(c.id) }), {})
      ).catch(() => ({ urls: [] })),
      call<{ pages?: Array<{ id: number; coursemodule: number; course: number; name: string; content?: string }> }>(
        'mod_page_get_pages_by_courses',
        courses.slice(0, 50).reduce((acc, c, i) => ({ ...acc, [`courseids[${i}]`]: String(c.id) }), {})
      ).catch(() => ({ pages: [] })),
      ...courses.slice(0,50).map(course=>call<Array<{id?:number;name?:string;section?:number;modules?:Array<{id:number;name:string;modname:string;contents?:Array<{filename:string;fileurl:string}>}>}>>('core_course_get_contents',{courseid:String(course.id)}).catch(()=>[])),
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

    const now = Date.now();
    const deadlines = (upcoming.events ?? [])
      .filter(event => (event.timestart * 1000) > now)
      .map(event => ({
        id: event.id,
        name: event.name,
        courseName: event.course?.fullname ?? 'Moodle',
        timestamp: event.timestart * 1000,
        url: event.url,
        modulename: event.modulename,
        eventtype: event.eventtype,
        description: event.description
          ? event.description.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ').trim()
          : undefined,
      }));
    const avatarUrl = moodleToken
      ? `/api/moodle/avatar?token=${encodeURIComponent(moodleToken)}&v=${site.userid}`
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

    const mappedCourses = courses.map((course, idx) => {
      let role = 'student';
      let isTeacher = false;

      if (site.userid === 2 || Boolean(site.userissiteadmin)) {
        isTeacher = true;
        role = 'editingteacher';
      } else {
        const enrolledRes = courseEnrolledUsers[idx];
        if (enrolledRes && enrolledRes.status === 'fulfilled' && Array.isArray(enrolledRes.value)) {
          const me = enrolledRes.value.find(u => u.id === site.userid);
          if (me?.roles && me.roles.length > 0) {
            const teacherRole = me.roles.find(r =>
              ['editingteacher', 'teacher'].includes(r.shortname)
            );
            if (teacherRole) {
              isTeacher = true;
              role = teacherRole.shortname;
            } else if (me.roles.some(r => ['manager', 'coursecreator', 'admin'].includes(r.shortname))) {
              isTeacher = true;
              role = 'editingteacher';
            } else {
              role = 'student';
              isTeacher = false;
            }
          }
        }
      }

      return {
        ...course,
        role,
        isTeacher,
      };
    });

    return NextResponse.json({
      mode: 'live',
      user: {
        id: site.userid,
        name: site.fullname,
        username: site.username,
        avatarUrl,
      },
      courses: mappedCourses,
      deadlines,
      resources,
      examResults: deduplicatedExamResults,
      latestResult,
      syncedAt: new Date().toISOString(),
      moodleUrl: MOODLE_URL ? MOODLE_URL.replace(/\/$/, '') : 'http://moodle.test',
      clientTokenExpired,
    });
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
