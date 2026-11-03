import { NextResponse } from 'next/server';
import { runtimeEnv } from '@/db/runtime';
import { supabaseAdmin } from '@/lib/supabase';
import { getMoodlePool, isMoodleDbAvailable, getSubmittedUserIdsForEvent } from '@/lib/moodle-db';
import { deleteCompletedEvent } from '@/lib/event-completion';
import { sweepOrphanedCourseEmbeddings } from '@/lib/pinecone-vector';
import { purgeExpiredSemanticCache } from '@/lib/semantic-cache';

export const maxDuration = 60; // Nới lỏng thời gian chạy tối đa lên 60 giây (tối đa của Vercel Hobby)
export const dynamic = 'force-dynamic';

interface MoodleCalendarEvent {
  id: number;
  name: string;
  modulename?: string;
  eventtype?: string;
  timestart: number;
  timesort?: number;
  timeduration?: number;
  instance?: number;
  sessionId?: number;
  course?: {
    id?: number;
    fullname?: string;
    shortname?: string;
  };
  action?: {
    actionable?: boolean;
    name?: string;
  };
}

interface MoodleCourse {
  id: number;
  shortname: string;
  fullname: string;
}

/**
 * Reconcile the pending reminder list against the current deadline.
 *
 * This runs on every sync, not only when the deadline changes, because
 * `sent_reminders` may be stale/incomplete (e.g. it was recalculated by an
 * older version of the code, or the deadline moved in Moodle while this job
 * was offline):
 * - configured milestones whose trigger time is still in the future are always
 *   (re)added. `notify` only consumes a milestone once its trigger time has
 *   passed, so this can never re-send an already delivered reminder.
 * - when the deadline actually changed, `prunePast` also removes pending
 *   milestones whose trigger time is already in the past, because they belong
 *   to the old (earlier) deadline.
 *
 * A small grace window keeps a milestone that became due a few seconds before
 * this sync run, so a normal cron delay does not silently drop it.
 */
function adjustRemindersForNewDeliverTime(
  currentReminders: number[],
  configuredReminders: number[],
  deliverTimeMs: number,
  nowMs = Date.now(),
  graceMs = 60_000,
  prunePast = false
): number[] {
  const adjusted = new Set<number>();
  const triggerTime = (reminder: number) => deliverTimeMs - reminder * 60_000;

  // Keep existing pending reminders. Only drop past ones after a real deadline
  // change; otherwise notify may still be about to deliver them.
  for (const reminder of currentReminders) {
    if (!Number.isFinite(reminder)) continue;
    if (!prunePast || triggerTime(reminder) >= nowMs - graceMs) {
      adjusted.add(reminder);
    }
  }

  // Always add configured milestones that are (again) in the future.
  for (const reminder of configuredReminders) {
    if (!Number.isFinite(reminder)) continue;
    if (triggerTime(reminder) > nowMs) {
      adjusted.add(reminder);
    }
  }

  // If the deadline was pulled so close that every normal milestone is already
  // overdue, keep the nearest one so the next notify run still sends a final
  // "deadline is almost here" reminder instead of staying silent.
  if (adjusted.size === 0 && deliverTimeMs > nowMs) {
    const smallestMilestone = Math.min(...configuredReminders.filter(Number.isFinite));
    if (Number.isFinite(smallestMilestone)) {
      adjusted.add(smallestMilestone);
    }
  }

  return Array.from(adjusted).sort((a, b) => b - a);
}

/**
 * Helper gọi fetch tới Moodle Web Service với cơ chế tự động thử lại (Retry)
 * và kiểm soát thời gian chờ (Timeout) để chống gián đoạn mạng DuckDNS/ISP.
 *
 * 개선 사항:
 * - Tăng timeout từ 8s lên 15s để Moodle có thời gian phản hồi hơn khi đang bận
 * - Tăng maxRetries từ 2 lên 3 (4 lượt thử toàn bộ)
 * - Sử dụng exponential backoff (1s, 2s, 4s) thay vì linaire để tránh trùng lấn server
 * - Thêm jitter (ngẫu nhiên nhỏ) để tránh đồng thời nhiều request cùng lúc
 */
async function fetchMoodleWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 3,
  timeoutMs = 15000
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < maxRetries) {
        // Exponential backoff: 1000ms, 2000ms, 4000ms kèm jitter ±20%
        const baseDelay = 1000 * Math.pow(2, attempt);
        const jitter = Math.random() * 200; // 0-200ms ngẫu nhiên
        const delay = baseDelay + jitter;
        console.warn(`[sync-moodle] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export async function GET(request: Request) {
  try {
    const { MOODLE_URL, MOODLE_TOKEN, CRON_SECRET } = runtimeEnv();

    const authHeader = request.headers.get('authorization');
    const { searchParams } = new URL(request.url);
    const querySecret = searchParams.get('secret') || searchParams.get('key');
    const isAuthorized =
      !CRON_SECRET ||
      authHeader === `Bearer ${CRON_SECRET}` ||
      querySecret === CRON_SECRET;

    if (!isAuthorized) {
      return NextResponse.json(
        { error: 'Unauthorized: Thiếu hoặc sai CRON_SECRET. Gắn header Authorization: Bearer <CRON_SECRET> hoặc param ?secret=<CRON_SECRET>' },
        { status: 401 }
      );
    }

    if (!MOODLE_URL || !MOODLE_TOKEN) {
      return NextResponse.json(
        { success: false, error: 'Chưa cấu hình MOODLE_URL hoặc MOODLE_TOKEN' },
        { status: 500 }
      );
    }

    const moodleBase = `${MOODLE_URL.replace(/\/+$/, '')}/webservice/rest/server.php`;
    const SCAN_DAYS = 7;
    // Bài tập vừa mở trong khoảng này vẫn được tạo event "đã mở" (tránh bỏ lỡ khi cron/app vừa bật)
    const ASSIGN_OPEN_GRACE_MINUTES = 30;
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const maxFutureTimestamp = nowTimestamp + SCAN_DAYS * 24 * 60 * 60;

    // 0. Xác thực Token & Kiểm tra quyền truy cập Web Service Moodle
    const siteParams = new URLSearchParams({
      wstoken: MOODLE_TOKEN,
      wsfunction: 'core_webservice_get_site_info',
      moodlewsrestformat: 'json',
    });

    let siteRes: Response;
    try {
      siteRes = await fetchMoodleWithRetry(`${moodleBase}?${siteParams.toString()}`, {}, 2, 8000);
    } catch (fetchErr: any) {
      const isTimeout =
        fetchErr?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        fetchErr?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        fetchErr?.name === 'AbortError' ||
        fetchErr?.message?.includes('timeout') ||
        fetchErr?.message?.includes('fetch failed');
      return NextResponse.json(
        {
          success: false,
          error: isTimeout
            ? 'Không thể kết nối tới máy chủ Moodle (Connect Timeout). Máy chủ Moodle (moodletvk.duckdns.org) có thể đang bận hoặc gián đoạn mạng tạm thời. Hệ thống sẽ tự động thử lại ở chu kỳ tiếp theo.'
            : `Lỗi kết nối tới Moodle: ${fetchErr?.message || String(fetchErr)}`,
          code: isTimeout ? 'MOODLE_CONNECT_TIMEOUT' : 'MOODLE_CONNECTION_FAILED',
          host: MOODLE_URL,
        },
        { status: 504 }
      );
    }
    if (!siteRes.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `Không thể kết nối tới Moodle server: HTTP ${siteRes.status}`,
          code: 'MOODLE_HTTP_ERROR',
        },
        { status: 502 }
      );
    }

    const siteData = (await siteRes.json()) as {
      userid?: number;
      fullname?: string;
      sitename?: string;
      exception?: string;
      errorcode?: string;
      message?: string;
    };

    if (siteData.exception || siteData.errorcode === 'invalidtoken') {
      return NextResponse.json(
        {
          success: false,
          error: `MOODLE_TOKEN không hợp lệ hoặc chưa được tạo trên Moodle (${siteData.message || siteData.exception || 'invalidtoken'}). Vui lòng tạo token mới trên ${MOODLE_URL.replace(/\/+$/, '')} (Site administration -> Server -> Web services -> Manage tokens) và cập nhật vào .env.local / .dev.vars.`,
          code: 'INVALID_MOODLE_TOKEN',
          moodleError: siteData.message || siteData.exception,
        },
        { status: 502 }
      );
    }

    // 1. Kéo các sự kiện lịch / bài tập tương lai từ Moodle
    let rawEvents: MoodleCalendarEvent[] = [];
    try {
      const calParams = new URLSearchParams({
        wstoken: MOODLE_TOKEN,
        wsfunction: 'core_calendar_get_action_events_by_timesort',
        moodlewsrestformat: 'json',
        timesortfrom: String(nowTimestamp),
        timesortto: String(maxFutureTimestamp),
        limitnum: '50',
      });

      const moodleRes = await fetchMoodleWithRetry(`${moodleBase}?${calParams.toString()}`);
      if (moodleRes.ok) {
        const calData = (await moodleRes.json()) as {
          events?: MoodleCalendarEvent[];
          exception?: string;
          message?: string;
        };

        if (!calData.exception && Array.isArray(calData.events)) {
          rawEvents = calData.events;
        } else if (calData.exception) {
          console.warn('[sync-moodle] core_calendar_get_action_events_by_timesort warning:', calData.message || calData.exception);
        }
      }
    } catch (calErr) {
      console.warn('[sync-moodle] Lỗi khi gọi core_calendar_get_action_events_by_timesort:', calErr);
    }

    // Fallback: Tra cứu sự kiện qua core_calendar_get_calendar_upcoming_view nếu hàm trên chưa được add vào Service
    if (rawEvents.length === 0) {
      try {
        const upcomingParams = new URLSearchParams({
          wstoken: MOODLE_TOKEN,
          wsfunction: 'core_calendar_get_calendar_upcoming_view',
          moodlewsrestformat: 'json',
        });
        const upcomingRes = await fetchMoodleWithRetry(`${moodleBase}?${upcomingParams.toString()}`);
        if (upcomingRes.ok) {
          const upcomingData = (await upcomingRes.json()) as {
            events?: Array<{
              id: number;
              name: string;
              timestart: number;
              timeduration?: number;
              modulename?: string;
              eventtype?: string;
              course?: { id?: number; fullname?: string; shortname?: string };
            }>;
            exception?: string;
          };
          if (!upcomingData.exception && Array.isArray(upcomingData.events)) {
            rawEvents = upcomingData.events.map((ev) => ({
              id: ev.id,
              name: ev.name,
              modulename: ev.modulename,
              eventtype: ev.eventtype,
              timestart: ev.timestart,
              timesort: ev.timestart,
              timeduration: ev.timeduration,
              course: ev.course,
            }));
          }
        }
      } catch (upcomingErr) {
        console.warn('[sync-moodle] Lỗi fallback core_calendar_get_calendar_upcoming_view:', upcomingErr);
      }
    }

    // Lọc sự kiện tương lai của học viên (bỏ qua sự kiện chấm điểm của giáo viên)
    const futureEvents = rawEvents.filter((ev) => {
      const time = ev.timesort || ev.timestart;
      const isWithinWindow = time > nowTimestamp && time <= maxFutureTimestamp;
      const isTeacherGrading =
        ev.eventtype === 'gradingdue' ||
        ev.action?.name === 'Grade' ||
        ev.name.toLowerCase().includes('due to be graded');
      return isWithinWindow && !isTeacherGrading;
    });

    // 2. Lấy danh sách SINH VIÊN từ bảng users.
    // Giáo viên không được đưa vào user_courses để cron nhắc nhở chỉ phục vụ sinh viên.
    let targetUserIds: number[] = [];
    if (supabaseAdmin) {
      const { data: userRows } = await supabaseAdmin
        .from('users')
        .select('moodle_user_id')
        .eq('role', 'student');
      if (userRows && userRows.length > 0) {
        targetUserIds = userRows.map((u) => u.moodle_user_id).filter(Boolean);
      }
    }

    // Chỉ được phép kết luận "cả lớp đã xong" khi biết chắc danh sách sinh viên.
    const hasKnownStudentRoster = targetUserIds.length > 0;

    // Nếu bảng users trên Supabase chưa có ai, mặc định lấy userId của chủ Token Moodle
    if (targetUserIds.length === 0) {
      const adminId = siteData?.userid ? Number(siteData.userid) : 2;
      targetUserIds = [adminId];
    }

    // 3. Đồng bộ ánh xạ môn học của từng sinh viên (user_courses)
    const allEnrolledCourseIds = new Set<number>();
    const courseMap = new Map<number, string>();
    const userCoursesRecords: Array<{ user_id: number; moodle_course_id: number }> = [];
    // Nếu một lần tra cứu ghi danh thất bại, danh sách sinh viên của môn có thể
    // thiếu người -> không được tự động xóa sự kiện vì tưởng "cả lớp đã xong".
    let enrollmentLookupComplete = hasKnownStudentRoster;

    for (const userId of targetUserIds) {
      try {
        const enrolParams = new URLSearchParams({
          wstoken: MOODLE_TOKEN,
          wsfunction: 'core_enrol_get_users_courses',
          moodlewsrestformat: 'json',
          userid: String(userId),
        });
        const enrolRes = await fetchMoodleWithRetry(`${moodleBase}?${enrolParams.toString()}`);
        if (enrolRes.ok) {
          const enrolData = (await enrolRes.json()) as MoodleCourse[];
          if (Array.isArray(enrolData)) {
            for (const c of enrolData) {
              allEnrolledCourseIds.add(c.id);
              courseMap.set(c.id, c.fullname || c.shortname);
              userCoursesRecords.push({ user_id: userId, moodle_course_id: c.id });
            }
          } else {
            enrollmentLookupComplete = false;
          }
        } else {
          enrollmentLookupComplete = false;
        }
      } catch (enrolErr) {
        enrollmentLookupComplete = false;
        console.warn(`Lỗi khi lấy danh sách môn học của user ${userId}:`, enrolErr);
      }
    }

    // Danh sách sinh viên đã biết của từng môn, dùng để kiểm tra "cả lớp đã
    // nộp bài / đã điểm danh" trước khi quyết định xóa sớm sự kiện.
    const courseStudentIds = new Map<number, number[]>();
    for (const record of userCoursesRecords) {
      const list = courseStudentIds.get(record.moodle_course_id) || [];
      if (!list.includes(record.user_id)) list.push(record.user_id);
      courseStudentIds.set(record.moodle_course_id, list);
    }

    // Nếu bảng user_courses có sẵn trên Supabase, upsert vào bảng này
    if (userCoursesRecords.length > 0 && supabaseAdmin) {
      try {
        await supabaseAdmin.from('user_courses').upsert(userCoursesRecords, {
          onConflict: 'user_id,moodle_course_id',
          ignoreDuplicates: true,
        });
      } catch {
        // bỏ qua nếu bảng chưa tạo trên Supabase
      }
    }

    // 3b. Kéo các buổi điểm danh (attendance sessions) từ Moodle
    const attendanceEvents: MoodleCalendarEvent[] = [];
    if (isMoodleDbAvailable()) {
      try {
        const pool = getMoodlePool();
        // Quét các buổi điểm danh đang diễn ra hoặc mở trong SCAN_DAYS
        const [attRows] = await pool.query(
          `SELECT 
             COALESCE(e.id, sess.id + 100000) AS id,
             sess.id AS session_id,
             a.name AS attendance_name,
             sess.description AS session_desc,
             sess.sessdate AS timestart,
             sess.duration AS timeduration,
             sess.attendanceid AS instance,
             a.course AS courseid,
             c.fullname AS course_fullname,
             c.shortname AS course_shortname
           FROM mdl_attendance_sessions sess
           JOIN mdl_attendance a ON a.id = sess.attendanceid
           JOIN mdl_course c ON c.id = a.course
           LEFT JOIN mdl_event e ON (e.id = sess.caleventid OR (e.instance = a.id AND e.modulename = 'attendance' AND e.timestart = sess.sessdate))
           WHERE (sess.sessdate + sess.duration) >= ? AND sess.sessdate <= ?`,
          [nowTimestamp, maxFutureTimestamp]
        );

        if (Array.isArray(attRows)) {
          for (const row of attRows as any[]) {
            const courseId = Number(row.courseid);
            if (!allEnrolledCourseIds.has(courseId)) continue;

            const attName = row.attendance_name || 'Điểm danh';
            const sessDesc = (row.session_desc || '').trim();
            const cleanName = sessDesc && sessDesc !== 'Regular class session'
              ? `${attName} - ${sessDesc}`
              : attName;

            attendanceEvents.push({
              id: Number(row.id),
              name: cleanName,
              modulename: 'attendance',
              eventtype: 'attendance',
              timestart: Number(row.timestart),
              timesort: Number(row.timestart),
              timeduration: Number(row.timeduration || 600),
              instance: Number(row.instance),
              sessionId: row.session_id ? Number(row.session_id) : undefined,
              course: {
                id: courseId,
                fullname: row.course_fullname || courseMap.get(courseId) || '',
                shortname: row.course_shortname || '',
              },
            });
          }
        }
      } catch (attDbErr) {
        console.warn('[sync-moodle] Tra cứu điểm danh qua MySQL thất bại, thử qua REST API:', attDbErr);
      }
    }

    // 3b-2. Kéo sự kiện lịch của các môn học sinh viên tham gia (bài tập, bài thi, điểm danh)
    // core_calendar_get_action_events_by_timesort chỉ trả về sự kiện của chủ Token,
    // nên bắt buộc phải quét theo từng môn học của sinh viên để không bỏ sót bài tập/bài thi!
    const courseCalendarEvents: MoodleCalendarEvent[] = [];
    if (allEnrolledCourseIds.size > 0 && MOODLE_URL && MOODLE_TOKEN) {
      try {
        for (const cid of allEnrolledCourseIds) {
          const calEventParams = new URLSearchParams({
            wstoken: MOODLE_TOKEN,
            wsfunction: 'core_calendar_get_calendar_events',
            moodlewsrestformat: 'json',
            'events[courseids][0]': String(cid),
            'options[timestart]': String(nowTimestamp - 3600),
            'options[timeend]': String(maxFutureTimestamp),
          });
          const cRes = await fetchMoodleWithRetry(`${moodleBase}?${calEventParams.toString()}`);
          if (cRes.ok) {
            const cData = (await cRes.json()) as any;
            const evList = cData?.events || [];
            for (const ev of evList) {
              const time = Number(ev.timestart || ev.timesort || 0);
              const duration = Number(ev.timeduration || 600);
              const isAtt = ev.modulename === 'attendance' || ev.eventtype === 'attendance';

              // Điểm danh: còn mở nếu chưa kết thúc phiên
              // Bài tập/Quiz: còn hạn nếu timestart nằm trong tương lai
              const isValid = isAtt
                ? (time + duration) >= nowTimestamp
                : (time > nowTimestamp && time <= maxFutureTimestamp);

              if (isValid && Number(ev.id) > 0) {
                const targetList = isAtt ? attendanceEvents : courseCalendarEvents;
                targetList.push({
                  id: Number(ev.id),
                  name: ev.name,
                  modulename: ev.modulename,
                  eventtype: ev.eventtype,
                  timestart: time,
                  timesort: time,
                  timeduration: duration,
                  instance: Number(ev.instance),
                  course: {
                    id: cid,
                    fullname: courseMap.get(cid) || '',
                    shortname: '',
                  },
                });
              }
            }
          }
        }
      } catch (calErr) {
        console.warn('[sync-moodle] Tra cứu sự kiện lịch môn học qua REST API thất bại:', calErr);
      }
    }

    // 3c. TẤT CẢ bài tập có hạn chót trong tương lai: Moodle calendar không nhất quán tạo event
    // cho hạn chót, nên lấy trực tiếp từ mod_assign_get_assignments để đảm bảo không bỏ sót
    const assignmentDueEvents: MoodleCalendarEvent[] = [];
    const ASSIGN_DUE_SCAN_DAYS = 30; // quét 30 ngày tới hạn chót
    const maxDueTimestamp = nowTimestamp + ASSIGN_DUE_SCAN_DAYS * 24 * 60 * 60;
    if (allEnrolledCourseIds.size > 0) {
      try {
        const courseIds = Array.from(allEnrolledCourseIds);
        for (let i = 0; i < courseIds.length; i += 20) {
          const chunk = courseIds.slice(i, i + 20);
          const assignParams = new URLSearchParams({
            wstoken: MOODLE_TOKEN,
            wsfunction: 'mod_assign_get_assignments',
            moodlewsrestformat: 'json',
          });
          chunk.forEach((cid, idx) => assignParams.append(`courseids[${idx}]`, String(cid)));

          const assignRes = await fetchMoodleWithRetry(`${moodleBase}?${assignParams.toString()}`);
          if (!assignRes.ok) continue;
          const assignData = (await assignRes.json()) as {
            courses?: Array<{
              id: number;
              fullname?: string;
              shortname?: string;
              assignments?: Array<{
                id: number;
                name?: string;
                course?: number;
                allowsubmissionsfromdate?: number;
                duedate?: number;
              }>;
            }>;
            exception?: string;
            message?: string;
          };
          if (assignData.exception || !Array.isArray(assignData.courses)) continue;

          for (const course of assignData.courses) {
            const cid = Number(course.id);
            if (!allEnrolledCourseIds.has(cid)) continue;
            for (const assignment of course.assignments || []) {
              const dueAt = Number(assignment.duedate || 0);
              const assignId = Number(assignment.id);
              if (!assignId || !dueAt) continue;
              const isFutureDue = dueAt > nowTimestamp && dueAt <= maxDueTimestamp;
              if (!isFutureDue) continue;

              assignmentDueEvents.push({
                // Use a positive synthetic ID so the event survives the
                // normal Moodle-ID validation and cleanup passes. The real
                // assignment ID remains in `instance`/event_details.
                id: 1000000000 + assignId,
                name: assignment.name || 'Bài tập',
                modulename: 'assign',
                eventtype: 'due',
                timestart: dueAt,
                timesort: dueAt,
                timeduration: 0,
                instance: assignId,
                course: {
                  id: cid,
                  fullname: course.fullname || courseMap.get(cid) || '',
                  shortname: course.shortname || '',
                },
              });
            }
          }
        }
      } catch (assignDueErr) {
        console.warn('[sync-moodle] Lỗi lấy danh sách bài tập hạn chót:', assignDueErr);
      }
    }

    // 4. Lọc & Khử trùng lặp
    const allCombinedEvents = [
      ...futureEvents,
      ...attendanceEvents,
      ...courseCalendarEvents,
      ...assignmentDueEvents,
    ];
    const deduplicatedEventsMap = new Map<string, MoodleCalendarEvent>();
    for (const ev of allCombinedEvents) {
      // Persist only positive Moodle IDs and positive synthetic assignment IDs.
      if (!Number.isInteger(Number(ev.id)) || Number(ev.id) <= 0) continue;

      const courseId = ev.course?.id ? Number(ev.course.id) : null;
      if (!courseId || !allEnrolledCourseIds.has(courseId)) continue;

      const cleanTitle = ev.name
        .replace(/\s+(?:is due|tới hạn|đến hạn).*$/i, '')
        .replace(/\s+(?:opens?|closes?|bắt đầu|kết thúc)\s*$/i, '')
        .trim()
        .toLowerCase();
      
      const isAtt = ev.modulename === 'attendance' || ev.eventtype === 'attendance';
      const isAssignOpen = ev.modulename === 'assign' && ev.eventtype === 'open';
      // Điểm danh có thể có nhiều ca trong cùng môn học -> gom nhóm kèm mốc timestart.
      // Bài tập "sắp mở" phải tách khỏi bài tập "hạn chót" để không bị gộp mất.
      const dedupKey = isAtt
        ? `${courseId}::attendance::${cleanTitle}::${ev.timestart}`
        : isAssignOpen
          ? `${courseId}::assign-open::${ev.instance ?? ev.id}::${cleanTitle}`
          : `${courseId}::${cleanTitle}`;
      const existing = deduplicatedEventsMap.get(dedupKey);

      if (!existing) {
        deduplicatedEventsMap.set(dedupKey, ev);
      } else {
        const existingTime = existing.timesort || existing.timestart;
        const curTime = ev.timesort || ev.timestart;
        // Nếu là quiz, ưu tiên mốc 'open' (bắt đầu làm bài) hơn 'close', hoặc mốc thời gian sớm nhất
        if (ev.eventtype === 'open' && existing.eventtype !== 'open') {
          deduplicatedEventsMap.set(dedupKey, ev);
        } else if (existing.eventtype === 'open' && ev.eventtype !== 'open') {
          // Giữ lại 'open'
        } else if (curTime < existingTime) {
          deduplicatedEventsMap.set(dedupKey, ev);
        }
      }
    }

    const eligibleEvents = Array.from(deduplicatedEventsMap.values());

    let insertedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;
    const syncedDetails: Array<{
      id: number;
      title: string;
      courseName?: string;
      deliverTime: string;
      status: string;
    }> = [];

    // Remove legacy rows created from the old negative synthetic IDs before
    // processing the current sync.
    if (supabaseAdmin) {
      const { data: invalidEvents, error: invalidEventsError } = await supabaseAdmin
        .from('events')
        .select('id')
        .lte('moodle_event_id', 0);

      if (invalidEventsError) {
        console.error('[sync-moodle] Lỗi tìm sự kiện có moodle_event_id không hợp lệ:', invalidEventsError.message);
      } else if (invalidEvents && invalidEvents.length > 0) {
        const invalidEventIds = invalidEvents.map(event => event.id);
        const { error: deleteInvalidError } = await supabaseAdmin
          .from('events')
          .delete()
          .in('id', invalidEventIds);

        if (deleteInvalidError) {
          console.error('[sync-moodle] Lỗi xóa sự kiện có moodle_event_id không hợp lệ:', deleteInvalidError.message);
        } else {
          deletedCount += invalidEventIds.length;
        }
      }
    }

    // Mốc thời gian nhắc nhở mặc định cho bài tập (assignment): 60, 30, 15, 10, 5 phút trước hạn chót
    const defaultReminders = [60, 30, 15, 10, 5];
    // Bài tập SẮP MỞ: nhắc trước giờ mở 15 và 5 phút
    const assignOpenReminders = [15, 5];

    // 5. Upsert các sự kiện vào bảng events (mỗi bài tập/bài thi của lớp là DUY NHẤT 1 event)
    for (const ev of eligibleEvents) {
      let time = ev.timesort || ev.timestart;
      let targetMoodleEventId = ev.id;

      const cleanTitle = ev.name
        .replace(/\s+(?:is due|tới hạn|đến hạn).*$/i, '')
        .replace(/\s+(?:opens?|closes?|bắt đầu|kết thúc)\s*$/i, '')
        .trim();

      const isAttendance =
        ev.modulename === 'attendance' ||
        ev.eventtype === 'attendance' ||
        /attendance|điểm danh/i.test(ev.name);

      // Bài tập "sắp mở" lấy từ mod_assign_get_assignments (id âm, eventtype 'open')
      const isAssignOpen =
        !isAttendance && ev.modulename === 'assign' && ev.eventtype === 'open';

      const isQuiz = !isAttendance && !isAssignOpen && (
        ev.modulename === 'quiz' ||
        ev.eventtype === 'quiz' ||
        ev.eventtype === 'open' ||
        ev.eventtype === 'close' ||
        /quiz|trắc nghiệm/i.test(cleanTitle)
      );

      const eventType = isAttendance
        ? 'attendance'
        : isAssignOpen
          ? 'assign_open'
          : (isQuiz ? 'quiz' : (ev.modulename || ev.eventtype || 'assign'));
      const moodleCourseId = ev.course?.id ? Number(ev.course.id) : null;
      const courseName = ev.course?.fullname || (moodleCourseId ? courseMap.get(moodleCourseId) : '') || ev.course?.shortname || '';

      // Tên hiển thị chuẩn hóa: <Tên môn>: <Tên bài tập/bài thi/buổi điểm danh>
      const displayTitle = courseName ? `${courseName}: ${cleanTitle}` : cleanTitle;

      if (isQuiz) {
        // Đối với Quiz: Thời gian delivered_time PHẢI là giờ mở đề (opens), KHÔNG PHẢI giờ đóng (closes)
        let quizResolved = false;
        if (isMoodleDbAvailable()) {
          try {
            const pool = getMoodlePool();
            const [quizRows] = await pool.query(
              `SELECT e.id as open_event_id, e.timestart as open_time, q.id as quiz_id, q.timeopen, q.timeclose
               FROM mdl_event e_orig
               JOIN mdl_quiz q ON q.id = e_orig.instance
               LEFT JOIN mdl_event e ON e.instance = q.id AND e.modulename = 'quiz' AND e.eventtype = 'open'
               WHERE e_orig.id = ?`,
              [ev.id]
            );
            const r = Array.isArray(quizRows) && (quizRows[0] as any);
            if (r) {
              const openTimestamp = Number(r.open_time || r.timeopen || 0);
              if (openTimestamp > 0) {
                time = openTimestamp;
                if (r.open_event_id) {
                  targetMoodleEventId = Number(r.open_event_id);
                }
                quizResolved = true;
              }
            }
          } catch {
            // MySQL error, proceed to REST fallback
          }
        }

        if (!quizResolved) {
          // Fallback: Tra cứu qua Moodle REST API nếu MySQL không trực tiếp khả dụng
          try {
            if (moodleCourseId && MOODLE_URL && MOODLE_TOKEN) {
              const qParams = new URLSearchParams({
                wstoken: MOODLE_TOKEN,
                wsfunction: 'mod_quiz_get_quizzes_by_courses',
                moodlewsrestformat: 'json',
                'courseids[0]': String(moodleCourseId),
              });
              const qRes = await fetchMoodleWithRetry(`${moodleBase}?${qParams.toString()}`);
              if (qRes.ok) {
                const qData = (await qRes.json()) as any;
                const quizzes = qData?.quizzes || [];
                const targetQ = quizzes.find((q: any) =>
                  (ev.instance && q.id === ev.instance) ||
                  q.name?.toLowerCase().trim() === cleanTitle.toLowerCase().trim()
                );
                if (targetQ && Number(targetQ.timeopen) > 0) {
                  time = Number(targetQ.timeopen);
                }
              }
            }
          } catch {
            // Giữ time hiện tại nếu fallback không tìm thấy
          }
        }
      }

      const deliverTime = new Date(time * 1000);
      const isStillOpenAttendance = isAttendance && (time + (ev.timeduration || 600)) > nowTimestamp;

      if (!Number.isInteger(Number(targetMoodleEventId)) || Number(targetMoodleEventId) <= 0) {
        continue;
      }

      // Bỏ qua sự kiện đã quá hạn (đối với điểm danh, chỉ bỏ qua khi thời lượng buổi điểm danh đã kết thúc)
// Giữ lại bài tập (assign) dù đã quá hạn để tham khảo trong bảng events
      const isAssignEvent = isAssignOpen || eventType === 'assign';
      if (!isAssignEvent && deliverTime.getTime() <= Date.now() && !isStillOpenAttendance) continue;

      // Nếu cả lớp đã nộp bài / đã điểm danh thì notify sẽ xóa sự kiện sớm.
      // Kiểm tra lại ở đây để sync không tạo lại (insert) sự kiện vừa bị xóa.
      // Chỉ kết luận khi danh sách sinh viên của môn là đầy đủ.
      const knownCourseStudents = moodleCourseId ? courseStudentIds.get(moodleCourseId) : undefined;
      let allStudentsCompleted = false;
      if (
        supabaseAdmin &&
        enrollmentLookupComplete &&
        knownCourseStudents &&
        knownCourseStudents.length > 0 &&
        !isAssignOpen
      ) {
        const nowMs = Date.now();
        if (!isAttendance && (eventType === 'assign' || eventType === 'due')) {
          const submittedUserIds = await getSubmittedUserIdsForEvent(
            targetMoodleEventId,
            knownCourseStudents,
            moodleCourseId,
            cleanTitle,
            null,
            null,
            deliverTime.getTime(),
            ev.instance ?? null
          );
          allStudentsCompleted = knownCourseStudents.every(id => submittedUserIds.has(id));
        } else if (isAttendance) {
          const sessionEndMs = time * 1000 + (ev.timeduration || 600) * 1000;
          if (sessionEndMs - nowMs <= 5 * 60_000) {
            const attendedUserIds = await getSubmittedUserIdsForEvent(
              targetMoodleEventId,
              knownCourseStudents,
              moodleCourseId,
              cleanTitle,
              ev.instance ?? null,
              ev.sessionId ?? null,
              time * 1000
            );
            allStudentsCompleted = knownCourseStudents.every(id => attendedUserIds.has(id));
          }
        }
      }

      if (supabaseAdmin) {
        // Kiểm tra xem moodle_event_id này đã có trong bảng events chưa (tìm cả id sự kiện open và close)
        const idsToMatch = Array.from(new Set([ev.id, targetMoodleEventId])).filter(Boolean);
        const { data: existingRows } = await supabaseAdmin
          .from('events')
          .select('id, title, event_type, moodle_course_id, event_details, sent_reminders, moodle_event_id, deliver_time')
          .in('moodle_event_id', idsToMatch)
          .limit(1);

        if (allStudentsCompleted) {
          // Mark completed events as expired and let the database cleanup
          // function remove them; direct deletion is blocked for future rows.
          if (existingRows && existingRows.length > 0) {
            if (await deleteCompletedEvent(existingRows[0].id)) {
              deletedCount++;
            }
          }
          syncedDetails.push({
            id: targetMoodleEventId,
            title: displayTitle,
            courseName,
            deliverTime: deliverTime.toISOString(),
            status: existingRows && existingRows.length > 0
              ? 'deleted-completed'
              : 'skipped-completed',
          });
          continue;
        }

        const diffMinutes = Math.floor((deliverTime.getTime() - Date.now()) / 60000);

        // Tính toán cấu hình mốc điểm danh chuẩn theo kế hoạch:
        // - Lần 1: Báo ngay khi mở (mốc 0)
        // - Lần 2: 3 phút trước khi đóng (mốc âm = -(durationMinutes - 3), bỏ qua nếu duration <= 3 phút)
        const durationMinutes = Math.floor((ev.timeduration || 600) / 60);
        const attendanceReminders = [0];
        if (durationMinutes > 3) {
          const reminderBeforeEnd = -(durationMinutes - 3);
          attendanceReminders.push(reminderBeforeEnd);
        }

        if (existingRows && existingRows.length > 0) {
          let currentReminders: number[] = [];

          if (isAttendance) {
            // `notify` là nơi duy nhất tiêu thụ sent_reminders. Giữ cả mốc đã đến
            // hạn để notify vẫn có thể xử lý nếu hai cron chạy lệch nhau.
            currentReminders = (existingRows[0].sent_reminders || [])
              .map(Number)
              .filter((n: number) => !isNaN(n) && (n === 0 || n < 0));
          } else if (isAssignOpen) {
            // Không xóa mốc theo thời gian ở đây; notify sẽ xóa mốc sau khi xử lý.
            currentReminders = (existingRows[0].sent_reminders || [])
              .map(Number)
              .filter((n: number) => !isNaN(n));
          } else if (isQuiz) {
            // Đối với Quiz: CHỈ gửi thông báo đúng 5 phút trước khi bắt đầu
            currentReminders = (existingRows[0].sent_reminders || [])
              .map(Number)
              .filter((n: number) => !isNaN(n) && n === 5);
          } else {
            // Assignment: bảo lưu các mốc đã cấu hình; notify sẽ loại mốc sau khi
            // kiểm tra sinh viên đã nộp bài và gửi thông báo.
            currentReminders = (existingRows[0].sent_reminders || []).map(Number).filter((n: number) => !isNaN(n) && n !== 1440);
          }

          // Luôn đối chiếu lại danh sách mốc nhắc với hạn chót hiện tại, kể cả
          // khi deliver_time không đổi: có thể sent_reminders đang thiếu mốc do
          // dữ liệu cũ. Khi hạn chót thực sự đổi, prunePast=true để bỏ các mốc
          // đã trôi qua của hạn cũ.
          const previousDeliverMs = existingRows[0].deliver_time
            ? new Date(existingRows[0].deliver_time).getTime()
            : null;
          const deliverTimeChanged =
            previousDeliverMs !== null &&
            !Number.isNaN(previousDeliverMs) &&
            previousDeliverMs !== deliverTime.getTime();

          const configuredReminders = isAttendance
            ? attendanceReminders
            : isAssignOpen
              ? assignOpenReminders
              : isQuiz
                ? [5]
                : defaultReminders;

          currentReminders = adjustRemindersForNewDeliverTime(
            currentReminders,
            configuredReminders,
            deliverTime.getTime(),
            Date.now(),
            60_000,
            deliverTimeChanged
          );

          const nextEventDetails = isAttendance
            ? JSON.stringify({
                type: 'attendance',
                durationMinutes,
                attendanceId: ev.instance ?? null,
                sessionId: ev.sessionId ?? null,
              })
            : (isAssignEvent || eventType === 'assign' || eventType === 'due')
              ? JSON.stringify({
                  type: 'assign',
                  assignId: ev.instance ?? null,
                  duedate: time,
                })
              : isQuiz
                ? JSON.stringify({
                    type: 'quiz',
                    quizId: ev.instance ?? null,
                  })
                : null;
          const existing = existingRows[0];
          const remindersChanged =
            JSON.stringify(existing.sent_reminders || []) !== JSON.stringify(currentReminders);
          const eventChanged =
            existing.moodle_event_id !== targetMoodleEventId ||
            existing.title !== displayTitle ||
            existing.event_type !== eventType ||
            existing.moodle_course_id !== moodleCourseId ||
            new Date(existing.deliver_time).getTime() !== deliverTime.getTime() ||
            remindersChanged ||
            existing.event_details !== nextEventDetails;

          const { error: updErr } = await supabaseAdmin
            .from('events')
            .update({
              moodle_event_id: targetMoodleEventId,
              title: displayTitle,
              deliver_time: deliverTime.toISOString(),
              event_type: eventType,
              moodle_course_id: moodleCourseId,
              sent_reminders: currentReminders,
              event_details: nextEventDetails,
            })
            .eq('id', existingRows[0].id);

          if (!updErr) {
            if (eventChanged) updatedCount++;
            syncedDetails.push({
              id: targetMoodleEventId,
              title: displayTitle,
              courseName,
              deliverTime: deliverTime.toISOString(),
              status: eventChanged ? 'updated' : 'unchanged',
            });
          }
        } else {
          // Thêm mới sự kiện
          let initialReminders: number[] = [];
          if (isAttendance) {
            initialReminders = attendanceReminders.filter((r: number) => {
              if (r === 0) return diffMinutes >= 0 || isStillOpenAttendance;
              return diffMinutes >= r;
            });
          } else if (isAssignOpen) {
            // Nhắc ngay (mốc 15/5) nếu lần sync đầu tiên đã sát giờ mở.
            initialReminders = diffMinutes >= 0 ? [...assignOpenReminders] : [];
          } else if (isQuiz) {
            initialReminders = diffMinutes >= 5 ? [5] : [];
          } else {
            initialReminders = defaultReminders.filter((r: number) => diffMinutes >= r);
          }

          const { error: insErr } = await supabaseAdmin.from('events').insert({
            moodle_event_id: targetMoodleEventId,
            event_type: eventType,
            title: displayTitle,
            deliver_time: deliverTime.toISOString(),
            moodle_course_id: moodleCourseId,
            sent_reminders: initialReminders,
            event_details: isAttendance
              ? JSON.stringify({
                  type: 'attendance',
                  durationMinutes,
                  attendanceId: ev.instance ?? null,
                  sessionId: ev.sessionId ?? null,
                })
              : (isAssignEvent || eventType === 'assign' || eventType === 'due')
                ? JSON.stringify({
                    type: 'assign',
                    assignId: ev.instance ?? null,
                    duedate: time,
                  })
                : isQuiz
                  ? JSON.stringify({
                      type: 'quiz',
                      quizId: ev.instance ?? null,
                    })
                  : null,
          });

          if (!insErr) {
            insertedCount++;
            syncedDetails.push({
              id: targetMoodleEventId,
              title: displayTitle,
              courseName,
              deliverTime: deliverTime.toISOString(),
              status: 'inserted',
            });
          } else {
            console.error(`[DB INSERT ERROR] Event ${targetMoodleEventId}:`, insErr.message);
          }
        }
      }
    }

    // 6. Dọn dẹp sự kiện quá hạn
    let expiredDeletedCount = 0;
    if (supabaseAdmin) {
      try {
const { data: expiredEvents } = await supabaseAdmin
        .from('events')
        .select('id, title, deliver_time, event_type, sent_reminders, event_details')
        .lt('deliver_time', new Date().toISOString());

      // Điểm danh có mốc âm (ví dụ -7: 3 phút trước khi đóng), KHÔNG xóa khi còn mốc nhắc
      // KHÔNG xóa sự kiện điểm danh nếu buổi học vẫn đang diễn ra (isStillOpenAttendance)
      const trulyExpired = (expiredEvents || []).filter(e => {
        // KHÔNG xóa bài tập (assign và assign_open) - giữ lại trong bảng để tham khảo sau khi hết hạn
        if (e.event_type === 'assign' || e.event_type === 'assign_open') return false;
        if (e.event_type === 'attendance') {
          const rems = (e.sent_reminders || []).map(Number).filter((n: number) => !isNaN(n));
          // Nếu còn mốc nhắc chưa gửi -> không xóa
          if (rems.length > 0) return false;
          // Nếu đã gửi hết mốc nhắc nhưng buổi học vẫn đang mở -> không xóa (tránh re-insert + notify lại)
          try {
            const details = e.event_details ? JSON.parse(e.event_details) : null;
            const durationMinutes = details?.durationMinutes || 60;
            const deliverMs = new Date(e.deliver_time).getTime();
            const isStillOpen = deliverMs + durationMinutes * 60 * 1000 > Date.now();
            if (isStillOpen) return false;
          } catch {
            // Nếu parse lỗi, xóa bình thường
          }
          return true;
        }
        return true;
      });

        if (trulyExpired.length > 0) {
          const toDelIds = trulyExpired.map(e => e.id);
          await supabaseAdmin.from('events').delete().in('id', toDelIds);
          expiredDeletedCount = toDelIds.length;
        }
      } catch (err) {
        console.warn('Lỗi dọn dẹp sự kiện quá hạn trong sync-moodle:', err);
      }
    }

    // 7. Dọn dẹp các sự kiện trùng lặp hoặc không còn trong danh sách Moodle hợp lệ
    const validMoodleIds = Array.from(
      new Set([
        ...eligibleEvents.map(e => e.id),
        ...syncedDetails.map(e => e.id),
      ])
    );
    if (supabaseAdmin) {
      const { data: dbEvents } = await supabaseAdmin
        .from('events')
        .select('id, moodle_event_id, deliver_time, event_type, event_details')
        .not('moodle_event_id', 'is', null);

      if (dbEvents && dbEvents.length > 0) {
        const toDeleteIds: string[] = [];
        for (const r of dbEvents) {
          // Always remove invalid legacy IDs, including assign rows that are
          // otherwise intentionally retained after their due time.
          if (r.moodle_event_id !== null && r.moodle_event_id <= 0) {
            toDeleteIds.push(r.id);
            continue;
          }

          // Bỏ qua sự kiện thủ công của giáo viên (manual)
          if (r.event_type === 'manual') continue;

          // Assignment events are retained after their due time only while the
          // assignment still exists in Moodle. If it was deleted from the LMS
          // (or this is a stale duplicate), its ID is absent from the current
          // sync and the event must be removed.
          if (r.event_type === 'assign' || r.event_type === 'assign_open') {
            if (r.moodle_event_id === null || !validMoodleIds.includes(r.moodle_event_id)) {
              toDeleteIds.push(r.id);
            }
            continue;
          }

          // KHÔNG xóa phiên điểm danh đang mở dù lần sync này bỏ sót nó (API lỗi tạm thời):
          // xóa row rồi sync sau insert lại sẽ khiến cron notify bắn lặp thông báo mở/đóng.
          if (r.event_type === 'attendance') {
            try {
              const details = r.event_details ? JSON.parse(r.event_details) : null;
              const durationMinutes = Number(details?.durationMinutes) || 60;
              const deliverMs = new Date(r.deliver_time).getTime();
              if (!Number.isNaN(deliverMs) && deliverMs + durationMinutes * 60000 > Date.now()) {
                continue;
              }
            } catch {
              // Parse lỗi -> xử lý như sự kiện thường
            }
          }
          // Nếu sự kiện trong DB không nằm trong danh sách eligibleEvents (đã khử trùng)
          if (r.moodle_event_id && !validMoodleIds.includes(r.moodle_event_id)) {
            toDeleteIds.push(r.id);
          }
        }

        if (toDeleteIds.length > 0) {
          const { error: delErr } = await supabaseAdmin.from('events').delete().in('id', toDeleteIds);
          if (!delErr) {
            deletedCount += toDeleteIds.length;
          }
        }
      }
    }

    // 8. Garbage Collection: Dọn rác vector Pinecone cho các khóa học đã đóng / tài liệu đã bị xóa
    let vectorOrphanedFilesCleaned = 0;
    let semanticCachePurgedCount = 0;
    if (supabaseAdmin && allEnrolledCourseIds.size > 0) {
      try {
        const allowedExtensions = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt']);
        for (const cid of Array.from(allEnrolledCourseIds).slice(0, 20)) {
          const contentsRes = await fetch(
            `${moodleBase}?${new URLSearchParams({
              wstoken: MOODLE_TOKEN,
              wsfunction: 'core_course_get_contents',
              moodlewsrestformat: 'json',
              courseid: String(cid),
            })}`
          );
          if (contentsRes.ok) {
            const sections = (await contentsRes.json()) as Array<{
              modules?: Array<{
                id: number;
                modname?: string;
                contents?: Array<{ filename?: string; fileid?: number }>;
              }>;
            }>;
            if (Array.isArray(sections)) {
              const activeFids: number[] = [];
              for (const sec of sections) {
                for (const mod of sec.modules || []) {
                  const modType = (mod.modname || '').toLowerCase();
                  if (modType === 'url' || modType === 'page') {
                    activeFids.push(Number(mod.id));
                  } else {
                    for (const file of mod.contents || []) {
                      const ext = (file.filename || '').split('.').pop()?.toLowerCase() || '';
                      if (allowedExtensions.has(ext)) {
                        activeFids.push(Number(file.fileid || mod.id));
                      }
                    }
                  }
                }
              }
              if (activeFids.length > 0) {
                const cleaned = await sweepOrphanedCourseEmbeddings(cid, activeFids);
                vectorOrphanedFilesCleaned += cleaned;
              }
            }
          }
        }
      } catch (sweepErr) {
        console.warn('Lỗi dọn rác vector trong sync-moodle cron:', sweepErr);
      }

      // 5b. TTL Maintenance: Purge semantic query cache rows older than 30 days
      try {
        semanticCachePurgedCount = await purgeExpiredSemanticCache(30);
      } catch (cacheTtlErr) {
        console.warn('Lỗi dọn dẹp semantic cache TTL:', cacheTtlErr);
      }
    }

    return NextResponse.json({
      success: true,
      scanDays: SCAN_DAYS,
      totalMoodleEvents: rawEvents.length,
      eligibleEvents: eligibleEvents.length,
      insertedCount,
      updatedCount,
      deletedCount,
      expiredDeletedCount,
      vectorOrphanedFilesCleaned,
      semanticCachePurgedCount,
      events: syncedDetails,
    });
  } catch (error) {
    console.error('Lỗi khi đồng bộ sự kiện từ Moodle:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
