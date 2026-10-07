import { NextResponse } from 'next/server';
import { runtimeEnv } from '@/db/runtime';
import { supabaseAdmin } from '@/lib/supabase';
import { getMoodlePool } from '@/lib/moodle-db';
import { sweepOrphanedCourseEmbeddings } from '@/lib/supabase-vector';
import { purgeExpiredSemanticCache } from '@/lib/semantic-cache';

interface MoodleCalendarEvent {
  id: number;
  name: string;
  modulename?: string;
  eventtype?: string;
  timestart: number;
  timesort?: number;
  timeduration?: number;
  instance?: number;
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
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const maxFutureTimestamp = nowTimestamp + SCAN_DAYS * 24 * 60 * 60;

    // 0. Xác thực Token & Kiểm tra quyền truy cập Web Service Moodle
    const siteParams = new URLSearchParams({
      wstoken: MOODLE_TOKEN,
      wsfunction: 'core_webservice_get_site_info',
      moodlewsrestformat: 'json',
    });

    const siteRes = await fetch(`${moodleBase}?${siteParams.toString()}`);
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

      const moodleRes = await fetch(`${moodleBase}?${calParams.toString()}`);
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
        const upcomingRes = await fetch(`${moodleBase}?${upcomingParams.toString()}`);
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

    // 2. Lấy danh sách users từ bảng users
    let targetUserIds: number[] = [];
    if (supabaseAdmin) {
      const { data: userRows } = await supabaseAdmin.from('users').select('moodle_user_id');
      if (userRows && userRows.length > 0) {
        targetUserIds = userRows.map((u) => u.moodle_user_id).filter(Boolean);
      }
    }

    // Nếu bảng users trên Supabase chưa có ai, mặc định lấy userId của chủ Token Moodle
    if (targetUserIds.length === 0) {
      const adminId = siteData?.userid ? Number(siteData.userid) : 2;
      targetUserIds = [adminId];
    }

    // 3. Đồng bộ ánh xạ môn học của từng sinh viên (user_courses)
    const allEnrolledCourseIds = new Set<number>();
    const courseMap = new Map<number, string>();
    const userCoursesRecords: Array<{ user_id: number; moodle_course_id: number }> = [];

    for (const userId of targetUserIds) {
      try {
        const enrolParams = new URLSearchParams({
          wstoken: MOODLE_TOKEN,
          wsfunction: 'core_enrol_get_users_courses',
          moodlewsrestformat: 'json',
          userid: String(userId),
        });
        const enrolRes = await fetch(`${moodleBase}?${enrolParams.toString()}`);
        if (enrolRes.ok) {
          const enrolData = (await enrolRes.json()) as MoodleCourse[];
          if (Array.isArray(enrolData)) {
            for (const c of enrolData) {
              allEnrolledCourseIds.add(c.id);
              courseMap.set(c.id, c.fullname || c.shortname);
              userCoursesRecords.push({ user_id: userId, moodle_course_id: c.id });
            }
          }
        }
      } catch (enrolErr) {
        console.warn(`Lỗi khi lấy danh sách môn học của user ${userId}:`, enrolErr);
      }
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
    try {
      const pool = getMoodlePool();
      // Quét các buổi điểm danh đang diễn ra hoặc mở trong SCAN_DAYS
      const [attRows] = await pool.query(
        `SELECT 
           COALESCE(e.id, sess.id + 100000) AS id,
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
      // Fallback: Tra cứu qua core_calendar_get_calendar_events
      try {
        if (allEnrolledCourseIds.size > 0 && MOODLE_URL && MOODLE_TOKEN) {
          for (const cid of allEnrolledCourseIds) {
            const calEventParams = new URLSearchParams({
              wstoken: MOODLE_TOKEN,
              wsfunction: 'core_calendar_get_calendar_events',
              moodlewsrestformat: 'json',
              'events[courseids][0]': String(cid),
              'options[timestart]': String(nowTimestamp - 3600),
              'options[timeend]': String(maxFutureTimestamp),
            });
            const cRes = await fetch(`${moodleBase}?${calEventParams.toString()}`);
            if (cRes.ok) {
              const cData = (await cRes.json()) as any;
              const evList = cData?.events || [];
              for (const ev of evList) {
                if (ev.modulename === 'attendance' || ev.eventtype === 'attendance') {
                  const end = (ev.timestart || 0) + (ev.timeduration || 600);
                  if (end >= nowTimestamp) {
                    attendanceEvents.push({
                      id: Number(ev.id),
                      name: ev.name,
                      modulename: 'attendance',
                      eventtype: 'attendance',
                      timestart: Number(ev.timestart),
                      timesort: Number(ev.timestart),
                      timeduration: Number(ev.timeduration || 600),
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
          }
        }
      } catch (attApiErr) {
        console.warn('[sync-moodle] Tra cứu điểm danh qua REST API thất bại:', attApiErr);
      }
    }

    // 4. Lọc & Khử trùng lặp: "two students from same classes received same homework should be one event"
    // Gom nhóm theo (moodle_course_id, cleanTitle), giữ lại duy nhất 1 sự kiện có hạn nộp/giờ mở gần nhất
    const allCombinedEvents = [...futureEvents, ...attendanceEvents];
    const deduplicatedEventsMap = new Map<string, MoodleCalendarEvent>();
    for (const ev of allCombinedEvents) {
      const courseId = ev.course?.id ? Number(ev.course.id) : null;
      if (!courseId || !allEnrolledCourseIds.has(courseId)) continue;

      const cleanTitle = ev.name
        .replace(/\s+is due.*$/i, '')
        .replace(/\s+(?:opens?|closes?)\s*$/i, '')
        .trim()
        .toLowerCase();
      
      const isAtt = ev.modulename === 'attendance' || ev.eventtype === 'attendance';
      // Điểm danh có thể có nhiều ca trong cùng môn học -> gom nhóm kèm mốc timestart
      const dedupKey = isAtt
        ? `${courseId}::attendance::${cleanTitle}::${ev.timestart}`
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

    // Mốc thời gian nhắc nhở mặc định cho bài tập (assignment): 60, 30, 15, 10, 5 phút trước hạn chót
    const defaultReminders = [60, 30, 15, 10, 5];

    // 5. Upsert các sự kiện vào bảng events (mỗi bài tập/bài thi của lớp là DUY NHẤT 1 event)
    for (const ev of eligibleEvents) {
      let time = ev.timesort || ev.timestart;
      let targetMoodleEventId = ev.id;

      const cleanTitle = ev.name
        .replace(/\s+is due.*$/i, '')
        .replace(/\s+(?:opens?|closes?)\s*$/i, '')
        .trim();

      const isAttendance =
        ev.modulename === 'attendance' ||
        ev.eventtype === 'attendance' ||
        /attendance|điểm danh/i.test(ev.name);

      const isQuiz = !isAttendance && (
        ev.modulename === 'quiz' ||
        ev.eventtype === 'quiz' ||
        ev.eventtype === 'open' ||
        ev.eventtype === 'close' ||
        /quiz|trắc nghiệm/i.test(cleanTitle)
      );

      const eventType = isAttendance ? 'attendance' : (isQuiz ? 'quiz' : (ev.modulename || ev.eventtype || 'assign'));
      const moodleCourseId = ev.course?.id ? Number(ev.course.id) : null;
      const courseName = ev.course?.fullname || (moodleCourseId ? courseMap.get(moodleCourseId) : '') || ev.course?.shortname || '';

      // Tên hiển thị chuẩn hóa: <Tên môn>: <Tên bài tập/bài thi/buổi điểm danh>
      const displayTitle = courseName ? `${courseName}: ${cleanTitle}` : cleanTitle;

      if (isQuiz) {
        // Đối với Quiz: Thời gian delivered_time PHẢI là giờ mở đề (opens), KHÔNG PHẢI giờ đóng (closes)
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
            }
          }
        } catch {
          // Fallback: Tra cứu qua Moodle REST API nếu MySQL không trực tiếp khả dụng
          try {
            if (moodleCourseId && MOODLE_URL && MOODLE_TOKEN) {
              const qParams = new URLSearchParams({
                wstoken: MOODLE_TOKEN,
                wsfunction: 'mod_quiz_get_quizzes_by_courses',
                moodlewsrestformat: 'json',
                'courseids[0]': String(moodleCourseId),
              });
              const qRes = await fetch(`${moodleBase}?${qParams.toString()}`);
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

      // Bỏ qua sự kiện đã quá hạn (đối với điểm danh, chỉ bỏ qua khi thời lượng buổi điểm danh đã kết thúc)
      if (deliverTime.getTime() <= Date.now() && !isStillOpenAttendance) continue;

      if (supabaseAdmin) {
        // Kiểm tra xem moodle_event_id này đã có trong bảng events chưa (tìm cả id sự kiện open và close)
        const idsToMatch = Array.from(new Set([ev.id, targetMoodleEventId])).filter(Boolean);
        const { data: existingRows } = await supabaseAdmin
          .from('events')
          .select('id, sent_reminders, moodle_event_id')
          .in('moodle_event_id', idsToMatch)
          .limit(1);

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
            // Cập nhật sự kiện điểm danh đã có: bảo lưu mốc chưa gửi
            const oldReminders = (existingRows[0].sent_reminders || []).map(Number).filter((n: number) => !isNaN(n));
            currentReminders = attendanceReminders.filter(r => {
              if (!oldReminders.includes(r)) return false;
              return diffMinutes >= r || (isStillOpenAttendance && r < 0 && diffMinutes <= 0);
            });
          } else if (isQuiz) {
            // Đối với Quiz: CHỈ gửi thông báo đúng 5 phút trước khi bắt đầu
            const oldReminders = (existingRows[0].sent_reminders || []).map(Number).filter((n: number) => !isNaN(n));
            // Nếu còn thời gian (> 5 phút), mốc thông báo là duy nhất 5
            if (diffMinutes > 5 && (oldReminders.includes(5) || oldReminders.length > 0)) {
              currentReminders = [5];
            } else {
              currentReminders = oldReminders.filter((n: number) => n === 5 && diffMinutes > 5);
            }
          } else {
            // Đối với Assignment: Bảo lưu các mốc đang đếm lùi, loại bỏ 1440 và đảm bảo có mốc 15 nếu chưa qua hạn
            currentReminders = (existingRows[0].sent_reminders || []).map(Number).filter((n: number) => !isNaN(n) && n !== 1440);
            if (!currentReminders.includes(15) && (diffMinutes > 15 || currentReminders.some((r: number) => r > 15))) {
              currentReminders.push(15);
              currentReminders.sort((a: number, b: number) => b - a);
            }
            // Luôn loại bỏ các mốc đã trôi qua trong quá khứ (diffMinutes <= r)
            currentReminders = currentReminders.filter((r: number) => diffMinutes > r);
          }

          const { error: updErr } = await supabaseAdmin
            .from('events')
            .update({
              moodle_event_id: targetMoodleEventId,
              title: displayTitle,
              deliver_time: deliverTime.toISOString(),
              event_type: eventType,
              moodle_course_id: moodleCourseId,
              sent_reminders: currentReminders,
              event_details: isAttendance ? JSON.stringify({ durationMinutes }) : null,
            })
            .eq('id', existingRows[0].id);

          if (!updErr) {
            updatedCount++;
            syncedDetails.push({
              id: targetMoodleEventId,
              title: displayTitle,
              courseName,
              deliverTime: deliverTime.toISOString(),
              status: 'updated',
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
          } else if (isQuiz) {
            initialReminders = diffMinutes > 5 ? [5] : [];
          } else {
            initialReminders = defaultReminders.filter((r: number) => diffMinutes > r);
          }

          const { error: insErr } = await supabaseAdmin.from('events').insert({
            moodle_event_id: targetMoodleEventId,
            event_type: eventType,
            title: displayTitle,
            deliver_time: deliverTime.toISOString(),
            moodle_course_id: moodleCourseId,
            sent_reminders: initialReminders,
            event_details: isAttendance ? JSON.stringify({ durationMinutes }) : null,
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
          .select('id, title, deliver_time, event_type, sent_reminders')
          .lt('deliver_time', new Date().toISOString());

        // Điểm danh có mốc âm (ví dụ -7: 3 phút trước khi đóng), KHÔNG xóa khi còn mốc nhắc
        const trulyExpired = (expiredEvents || []).filter(e => {
          if (e.event_type === 'attendance') {
            const rems = (e.sent_reminders || []).map(Number).filter((n: number) => !isNaN(n));
            return rems.length === 0;
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
        .select('id, moodle_event_id, deliver_time, event_type')
        .not('moodle_event_id', 'is', null);

      if (dbEvents && dbEvents.length > 0) {
        const toDeleteIds: string[] = [];
        for (const r of dbEvents) {
          // Bỏ qua sự kiện thủ công của giáo viên (manual)
          if (r.event_type === 'manual') continue;
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

    // 8. Garbage Collection: Dọn rác vector pgvector cho các khóa học đã đóng / tài liệu đã bị xóa
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
