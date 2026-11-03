import { adminMessaging } from '@/lib/firebase-admin';
import { supabaseAdmin } from '@/lib/supabase';
import { runtimeEnv } from '@/db/runtime';
import { getSubmittedUserIdsForEvent, getEnrolledUserIdsFromMoodleDb } from '@/lib/moodle-db';
import { deleteCompletedEvent } from '@/lib/event-completion';

export interface ProcessEventsResult {
  success: boolean;
  eventsDeleted: number;
  notificationsSent: number;
  totalEventsScanned: number;
  details: Array<{
    id?: number;
    eventId?: string;
    moodleEventId?: number | null;
    title?: string;
    eventType?: string;
    action: 'deleted' | 'sent' | 'pending' | 'skipped' | 'failed';
    diffMinutes?: number;
    matchedReminder?: number;
    reminders?: number[];
    remainingReminders?: number[];
    targetUserIds?: number[];
    submittedUserIds?: number[];
    sentCount?: number;
    reason?: string;
  }>;
}

interface RawEvent {
  id: string;
  moodleEventId?: number | null;
  title: string;
  eventType: string;
  moodleCourseId?: number | null;
  deliverTime: Date;
  sentReminders: number[];
  eventDetails?: string | null;
}

interface AttendanceEventDetails {
  durationMinutes?: number | string | null;
  attendanceId?: number | string | null;
  sessionId?: number | string | null;
}

interface AssignEventDetails {
  assignId?: number | string | null;
  duedate?: number | string | null;
}

function parseAttendanceDetails(eventDetails?: string | null): AttendanceEventDetails | null {
  if (!eventDetails) return null;
  try {
    const parsed = JSON.parse(eventDetails) as AttendanceEventDetails | null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `event_details` of assignment rows already stores the Moodle assignment id
 * captured at sync time (mdl_event.instance). Using it avoids re-resolving the
 * assignment by title via `mod_assign_get_assignments`, which fails when the
 * webservice token owner is not enrolled in the course (e.g. a teacher/admin
 * token) and used to make the "already submitted" check silently return empty.
 */
function parseAssignId(eventDetails?: string | null): number | null {
  if (!eventDetails) return null;
  try {
    const parsed = JSON.parse(eventDetails) as AssignEventDetails | null;
    const assignId = Number(parsed?.assignId);
    return Number.isFinite(assignId) && assignId > 0 ? assignId : null;
  } catch {
    return null;
  }
}

/**
 * Thời điểm phiên điểm danh thực sự đóng.
 * deliver_time = giờ mở, nên cần cộng thêm duration để biết khi nào buổi kết thúc.
 */
function getAttendanceEndTime(event: RawEvent, fallbackMinutes = 60): number {
  const durationMinutes = Number(parseAttendanceDetails(event.eventDetails)?.durationMinutes);
  const safeDuration = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : fallbackMinutes;
  return event.deliverTime.getTime() + safeDuration * 60000;
}

/**
 * Cron/reminder notifications are student-only. Teachers now own FCM tokens
 * (for artifact-ready pushes), so make sure they never enter the scheduled
 * reminder audience even if `user_courses` contains their enrollments.
 */
async function filterToStudentUserIds(userIds: number[]): Promise<number[]> {
  if (!supabaseAdmin || userIds.length === 0) return [];
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('moodle_user_id, role');
    if (error || !data) return [];

    // Chỉ giữ lại những tài khoản được xác nhận rõ ràng role === 'student'
    const studentIds = new Set(
      data
        .filter(u => u.role && u.role.trim().toLowerCase() === 'student')
        .map(u => Number(u.moodle_user_id))
    );
    // Loại bỏ hoàn toàn giáo viên (teacher), admin, hoặc các tài khoản không phải student
    return userIds.filter(id => studentIds.has(id));
  } catch {
    return [];
  }
}

/**
 * Lấy danh sách user_id của sinh viên ghi danh trong khóa học.
 * 1. Ưu tiên tra cứu bảng trung gian `user_courses` trên Supabase
 * 2. Fallback sang Moodle API core_enrol_get_users_courses cho danh sách users hiện có
 */
async function getEnrolledUserIdsForCourse(
  courseId: number | null,
  userCoursesCache: Map<number, number[]>
): Promise<number[]> {
  if (!courseId) {
    // Nếu sự kiện không gắn môn học cụ thể, chỉ gửi cho sinh viên (role = 'student'), loại bỏ giáo viên
    if (supabaseAdmin) {
      const { data } = await supabaseAdmin.from('users').select('moodle_user_id').eq('role', 'student');
      return (data || []).map(u => Number(u.moodle_user_id)).filter(Boolean);
    }
    return [];
  }

  // 1. Thử lấy từ bảng user_courses trên Supabase (lọc loại bỏ giáo viên)
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('user_courses')
        .select('user_id')
        .eq('moodle_course_id', courseId);
      if (!error && data && data.length > 0) {
        const rawIds = Array.from(new Set(data.map(r => Number(r.user_id)))).filter(Boolean);
        return await filterToStudentUserIds(rawIds);
      }
    } catch {
      // bảng chưa tạo hoặc có lỗi, fallback sang MySQL Moodle
    }
  }

  // 2. Tra cứu trực tiếp danh sách ghi danh từ MySQL Moodle (LỌC CHỈ SINH VIÊN, không lấy giáo viên)
  try {
    const dbEnrolled = await getEnrolledUserIdsFromMoodleDb(courseId);
    if (dbEnrolled && dbEnrolled.length > 0) {
      return await filterToStudentUserIds(dbEnrolled);
    }
  } catch {
    // tiếp tục fallback nếu MySQL bận
  }

  // 3. Fallback: Lấy danh sách users từ Supabase có role = 'student' rồi kiểm tra khóa học đã ghi danh
  let knownUserIds: number[] = [];
  if (supabaseAdmin) {
    const { data: userRows } = await supabaseAdmin.from('users').select('moodle_user_id').eq('role', 'student');
    if (userRows && userRows.length > 0) {
      knownUserIds = userRows.map(u => Number(u.moodle_user_id)).filter(Boolean);
    }
  }

  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  if (!MOODLE_URL || !MOODLE_TOKEN) {
    return knownUserIds;
  }

  const moodleBase = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
  const enrolledUserIds: number[] = [];

  for (const uid of knownUserIds) {
    let courses = userCoursesCache.get(uid);
    if (!courses) {
      try {
        const enrolParams = new URLSearchParams({
          wstoken: MOODLE_TOKEN,
          wsfunction: 'core_enrol_get_users_courses',
          moodlewsrestformat: 'json',
          userid: String(uid),
        });
        const enrolRes = await fetch(`${moodleBase}?${enrolParams.toString()}`);
        if (enrolRes.ok) {
          const enrolData = await enrolRes.json();
          if (Array.isArray(enrolData)) {
            courses = enrolData.map((c: { id: number }) => Number(c.id));
            userCoursesCache.set(uid, courses);
          }
        }
      } catch (err) {
        console.warn(`Lỗi tra cứu môn học user ${uid}:`, err);
      }
    }

    if (courses && courses.includes(courseId)) {
      enrolledUserIds.push(uid);
    }
  }

  return enrolledUserIds.length > 0 ? enrolledUserIds : knownUserIds;
}

export async function processNotificationEvents(): Promise<ProcessEventsResult> {
  const now = new Date();
  let eventsDeleted = 0;
  let notificationsSent = 0;
  const details: ProcessEventsResult['details'] = [];

  // TÁC VỤ 1: Dọn dẹp sự kiện đã quá hạn via Supabase
  // Chỉ dọn dẹp các sự kiện đã quá hạn hơn 5 phút (ngoại trừ điểm danh còn mốc âm)
  if (supabaseAdmin) {
    try {
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60000).toISOString();
      const { data: expiredEvents } = await supabaseAdmin
        .from('events')
        .select('id, moodle_event_id, title, deliver_time, event_type, sent_reminders, event_details')
        .lt('deliver_time', fiveMinutesAgo);

      // Điểm danh có mốc âm (ví dụ -7: 3 phút trước khi đóng phiên), KHÔNG xóa sớm nếu còn mốc nhắc.
      // Sau khi đã gửi hết mốc vẫn phải giữ row tới khi phiên thực sự đóng, nếu không
      // sync-moodle sẽ insert lại và cron notify sẽ bắn lặp lại thông báo đóng.
      const trulyExpiredEvents = (expiredEvents || []).filter(e => {
        if (e.event_type === 'attendance') {
          const attendanceDetails = parseAttendanceDetails(e.event_details);
          const durationMinutes = Number(attendanceDetails?.durationMinutes);
          const safeDuration = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 60;
          const deliverMs = new Date(e.deliver_time).getTime();
          const sessionEnded = !Number.isNaN(deliverMs) && Date.now() > deliverMs + safeDuration * 60000 + 60000;
          return sessionEnded;
        }
        return true;
      });

      if (trulyExpiredEvents.length > 0) {
        const expIds = trulyExpiredEvents.map(e => e.id);
        await supabaseAdmin.from('events').delete().in('id', expIds);
        eventsDeleted += expIds.length;
        for (const exp of trulyExpiredEvents) {
          details.push({
            eventId: exp.id,
            moodleEventId: exp.moodle_event_id,
            title: exp.title,
            action: 'deleted',
            reason: exp.event_type === 'attendance'
              ? `Phiên điểm danh đã đóng (${exp.deliver_time} + thời lượng). Đã xóa khỏi database.`
              : `Đã quá hạn deliver_time (${exp.deliver_time}) hơn 5 phút. Đã xóa khỏi database.`,
          });
        }
      }
    } catch (cleanErr) {
      console.warn('Lỗi dọn dẹp sự kiện quá hạn:', cleanErr);
    }
  }

  // TÁC VỤ 2: Quét các sự kiện còn hiệu lực và còn mốc thông báo trong `sent_reminders`
  let allEvents: RawEvent[] = [];

  if (supabaseAdmin) {
    // Quét sự kiện từ thời điểm 3 giờ trước tới tương lai (đảm bảo không bỏ sót mốc âm của điểm danh)
    const scanThreshold = new Date(now.getTime() - 3 * 3600 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('*')
      .gte('deliver_time', scanThreshold)
      .order('deliver_time', { ascending: true });

    if (error) {
      console.error('Lỗi truy vấn bảng events:', error.message);
      throw error;
    }

    allEvents = (data || []).map(r => {
      const isManual = r.event_type === 'manual';
      const isQuiz = r.event_type === 'quiz';
      const isAttendance = r.event_type === 'attendance';
      const parsedReminders = (r.sent_reminders || []).map(Number).filter((n: number) => !isNaN(n));
      const delTime = new Date(r.deliver_time);
      const diffM = Math.floor((delTime.getTime() - now.getTime()) / 60000);

      if (isAttendance) {
        // Điểm danh: mốc 0 (ngay khi mở) và mốc âm < 0 (3 phút trước khi đóng phiên)
        const filtered = parsedReminders.filter((n: number) => n === 0 || n < 0);
        return {
          id: r.id,
          moodleEventId: r.moodle_event_id,
          title: r.title,
          eventType: 'attendance',
          moodleCourseId: r.moodle_course_id,
          deliverTime: delTime,
          sentReminders: filtered,
          eventDetails: r.event_details || null,
        };
      }

      if (isQuiz) {
        // Với bài thi/quiz Moodle: CHỈ nhắc duy nhất 5 phút trước khi bắt đầu
        const filtered = parsedReminders.filter((n: number) => n === 5);
        return {
          id: r.id,
          moodleEventId: r.moodle_event_id,
          title: r.title,
          eventType: r.event_type,
          moodleCourseId: r.moodle_course_id,
          deliverTime: delTime,
          sentReminders: filtered,
          eventDetails: r.event_details || null,
        };
      }

      if (r.event_type === 'assign_open') {
        // Bài tập sắp mở: giữ nguyên các mốc 15/5 đã đặt, không thêm mốc hạn chót.
        return {
          id: r.id,
          moodleEventId: r.moodle_event_id,
          title: r.title,
          eventType: 'assign_open',
          moodleCourseId: r.moodle_course_id,
          deliverTime: delTime,
          sentReminders: parsedReminders,
          eventDetails: r.event_details || null,
        };
      }

      if (!isManual) {
        // `sync-moodle` khởi tạo các mốc và `notify` tiêu thụ chúng. Không tự
        // thêm lại mốc 15 sau khi mốc đó đã được gửi.
        const filtered = parsedReminders.filter((n: number) => n !== 1440);
        return {
          id: r.id,
          moodleEventId: r.moodle_event_id,
          title: r.title,
          eventType: r.event_type,
          moodleCourseId: r.moodle_course_id,
          deliverTime: delTime,
          sentReminders: filtered,
          eventDetails: r.event_details || null,
        };
      }

      // Với sự kiện thủ công (manual): bảo toàn chính xác các mốc giáo viên chọn
      parsedReminders.sort((a: number, b: number) => b - a);
      return {
        id: r.id,
        moodleEventId: r.moodle_event_id,
        title: r.title,
        eventType: r.event_type,
        moodleCourseId: r.moodle_course_id,
        deliverTime: delTime,
        sentReminders: parsedReminders,
        eventDetails: r.event_details || null,
      };
    });
  }

  const userCoursesCache = new Map<number, number[]>();

  for (const event of allEvents) {
    if (!event.deliverTime || isNaN(event.deliverTime.getTime())) continue;

    const diffMs = event.deliverTime.getTime() - now.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const reminders = event.sentReminders || [];

    // Kiểm tra hết hạn:
    // Với điểm danh: chỉ xóa khi phiên đã thực sự đóng (mở + duration) và đã gửi hết
    // các mốc nhắc, hoặc đã qua hơn 3 tiếng. TUYỆT ĐỐI không xóa ngay sau khi gửi
    // mốc "-3 phút" vì phiên vẫn còn mở -> sync-moodle sẽ insert lại và gây bắn lặp.
    const isAtt = event.eventType === 'attendance';
    const attendanceEnded = isAtt ? Date.now() > getAttendanceEndTime(event) + 60000 : false;
    const isExpired = isAtt
      ? diffMs < -180 * 60000 || (reminders.length === 0 && attendanceEnded)
      : (diffMs < -5 * 60000 || (diffMs <= 0 && reminders.length === 0));

    if (isExpired) {
      if (supabaseAdmin) {
        await supabaseAdmin.from('events').delete().eq('id', event.id);
        eventsDeleted++;
        details.push({
          eventId: event.id,
          moodleEventId: event.moodleEventId,
          title: event.title,
          action: 'deleted',
          diffMinutes,
          reason: `Đã hoàn thành các mốc nhắc và quá hạn deliver_time (${event.deliverTime.toISOString()}). Đã xóa.`,
        });
      }
      continue;
    }

    if (reminders.length === 0) {
      details.push({
        eventId: event.id,
        moodleEventId: event.moodleEventId,
        title: event.title,
        action: 'pending',
        diffMinutes,
        reminders: [],
        reason: 'Đã gửi hết các mốc nhắc nhở (đang chờ hết hạn để tự động dọn dẹp).',
      });
      continue;
    }

    // Kiểm tra các mốc đã đến hạn bằng thời điểm chính xác (không dùng
    // diffMinutes đã làm tròn, tránh gửi sớm tới ~59 giây và khiến sync
    // tưởng mốc chưa gửi rồi thêm lại gây thông báo trùng).
    const dueReminders = reminders.filter(
      rem => event.deliverTime.getTime() - rem * 60000 <= now.getTime()
    );

    if (dueReminders.length > 0) {
      // Chọn mốc gần nhất đã đến hạn (mốc nhỏ nhất trong các mốc thỏa điều kiện)
      const matchedReminder = Math.min(...dueReminders);

      // Mốc này và các mốc lớn hơn đã trôi qua -> Luôn loại bỏ khỏi sent_reminders kể cả khi không gửi được
      const remainingReminders = reminders.filter(r => r < matchedReminder);

      // Cập nhật DB: Xóa mốc đã qua ngay lập tức
      if (supabaseAdmin) {
        await supabaseAdmin
          .from('events')
          .update({ sent_reminders: remainingReminders })
          .eq('id', event.id);
      }

      // Xác định sinh viên thuộc lớp học này (loại bỏ giáo viên/admin)
      const targetUserIds = await filterToStudentUserIds(
        await getEnrolledUserIdsForCourse(event.moodleCourseId || null, userCoursesCache)
      );

      if (targetUserIds.length === 0) {
        details.push({
          eventId: event.id,
          moodleEventId: event.moodleEventId,
          title: event.title,
          eventType: event.eventType,
          action: 'skipped',
          diffMinutes,
          matchedReminder,
          reminders,
          remainingReminders,
          reason: `Mốc ${matchedReminder} phút đã qua. Không tìm thấy sinh viên nào ghi danh trong môn ID = ${event.moodleCourseId}. Đã xóa mốc khỏi sent_reminders.`,
        });
        continue;
      }

      let pendingUserIds = targetUserIds;
      let submittedUserIds = new Set<number>();

      const isAttendanceEvent = event.eventType === 'attendance';

      // 1. Kiểm tra nộp bài đối với BÀI TẬP (assign/due)
      if (event.eventType === 'assign' || event.eventType === 'due' || event.eventType === 'assignment') {
        submittedUserIds = await getSubmittedUserIdsForEvent(
          event.moodleEventId,
          targetUserIds,
          event.moodleCourseId,
          event.title,
          null,
          null,
          event.deliverTime.getTime(),
          parseAssignId(event.eventDetails)
        );

        // Lọc danh sách sinh viên CHƯA NỘP BÀI để gửi thông báo
        pendingUserIds = targetUserIds.filter(id => !submittedUserIds.has(id));

        if (pendingUserIds.length === 0) {
          // Mọi sinh viên trong lớp đã nộp bài: không còn lý do giữ sự kiện
          // (và các mốc nhắc còn lại) trong danh sách. Xóa sớm thay vì chờ
          // qua hạn chót.
          if (await deleteCompletedEvent(event.id)) {
            eventsDeleted++;
          }
          details.push({
            eventId: event.id,
            moodleEventId: event.moodleEventId,
            title: event.title,
            eventType: event.eventType,
            action: 'deleted',
            diffMinutes,
            matchedReminder,
            reminders,
            targetUserIds,
            submittedUserIds: Array.from(submittedUserIds),
            remainingReminders,
            reason: `Mốc ${matchedReminder} phút đã qua. Tất cả sinh viên trong lớp [${targetUserIds.join(', ')}] đều đã nộp bài trên Moodle. Đã xóa sự kiện sớm.`,
          });
          continue;
        }
      }

      // 2. Logic điểm danh (attendance):
      // - Mốc 0 (ngay khi mở): gửi cho TẤT CẢ sinh viên trong lớp.
      // - Mốc âm (3 phút trước khi đóng): CHỈ gửi cho sinh viên CHƯA điểm danh.
      if (isAttendanceEvent && matchedReminder < 0) {
        const attendanceDetails = parseAttendanceDetails(event.eventDetails);
        const attendanceId = attendanceDetails?.attendanceId != null
          ? Number(attendanceDetails.attendanceId)
          : null;
        const sessionId = attendanceDetails?.sessionId != null
          ? Number(attendanceDetails.sessionId)
          : null;

        submittedUserIds = await getSubmittedUserIdsForEvent(
          event.moodleEventId,
          targetUserIds,
          event.moodleCourseId,
          event.title,
          Number.isFinite(attendanceId) ? attendanceId : null,
          Number.isFinite(sessionId) ? sessionId : null,
          event.deliverTime.getTime()
        );

        // Lọc những sinh viên CHƯA điểm danh
        pendingUserIds = targetUserIds.filter(id => !submittedUserIds.has(id));

        if (pendingUserIds.length === 0) {
          // Tất cả sinh viên đều đã điểm danh: xóa sớm phiên khỏi danh sách
          // thay vì chờ phiên đóng và cron dọn dẹp.
          if (await deleteCompletedEvent(event.id)) {
            eventsDeleted++;
          }
          details.push({
            eventId: event.id,
            moodleEventId: event.moodleEventId,
            title: event.title,
            eventType: event.eventType,
            action: 'deleted',
            diffMinutes,
            matchedReminder,
            reminders,
            targetUserIds,
            submittedUserIds: Array.from(submittedUserIds),
            remainingReminders,
            reason: `Mốc ${matchedReminder}m (trước khi đóng): Tất cả sinh viên trong lớp [${targetUserIds.join(', ')}] đều đã điểm danh trên Moodle. Đã xóa sự kiện sớm.`,
          });
          continue;
        }
      }

      // Kéo danh sách FCM token của các sinh viên cần gửi (bảo đảm 100% không bao giờ gửi cho giáo viên)
      const confirmedStudentIds = await filterToStudentUserIds(pendingUserIds);
      let tokens: string[] = [];
      if (supabaseAdmin && confirmedStudentIds.length > 0) {
        const { data: tokenRows } = await supabaseAdmin
          .from('fcm_tokens')
          .select('token')
          .in('user_id', confirmedStudentIds);
        tokens = Array.from(new Set((tokenRows || []).map(t => t.token))).filter(Boolean);
      }

      if (tokens.length === 0) {
        details.push({
          eventId: event.id,
          moodleEventId: event.moodleEventId,
          title: event.title,
          eventType: event.eventType,
          action: 'skipped',
          diffMinutes,
          matchedReminder,
          reminders,
          targetUserIds: pendingUserIds,
          submittedUserIds: Array.from(submittedUserIds),
          remainingReminders,
          reason: `Mốc ${matchedReminder} phút đã qua. Không có FCM token thiết bị nào cho các sinh viên [${pendingUserIds.join(', ')}].`,
        });
        continue;
      }

      // Định dạng thời gian thân thiện (VD: ngay bây giờ, 1 ngày, 2 giờ, 30 phút)
      const timeText =
        matchedReminder === 0
          ? 'ngay bây giờ'
          : diffMinutes >= 1440
          ? `${Math.round(diffMinutes / 1440)} ngày`
          : diffMinutes >= 60
          ? `${Math.round(diffMinutes / 60)} giờ`
          : `${diffMinutes > 0 ? diffMinutes : matchedReminder} phút`;

      // === LOGIC XỬ LÝ TIÊU ĐỀ & NỘI DUNG THÔNG BÁO ===
      let notificationTitle = event.title;
      let notificationBody = '';

      if (event.eventType === 'manual') {
        notificationTitle = event.title.includes(':') || event.title.startsWith('[')
          ? event.title
          : `Thông báo: ${event.title}`;
        notificationBody = event.eventDetails?.trim()
          || (matchedReminder === 0 ? 'Sự kiện đang diễn ra ngay bây giờ!' : `Sự kiện sẽ diễn ra sau ${timeText} nữa!`);
      } else if (event.eventType === 'attendance') {
        if (matchedReminder < 0) {
          // Lần 2: 3 phút trước khi đóng phiên điểm danh
          notificationTitle = event.title.includes(':')
            ? `Nhắc nhở đóng điểm danh: ${event.title}`
            : `Nhắc nhở: ${event.title}`;
          notificationBody = 'Chỉ còn 3 phút nữa là đóng phiên điểm danh! Hãy vào điểm danh ngay kẻo lỡ.';
        } else {
          // Lần 1: Ngay khi mở
          notificationTitle = event.title.includes(':') ? event.title : `Điểm danh: ${event.title}`;
          notificationBody = 'Buổi điểm danh đang mở ngay bây giờ! Hãy vào điểm danh ngay nhé.';
        }
      } else if (event.eventType === 'assign_open') {
        // Nhắc trước khi bài tập mở
        notificationTitle = `Sắp mở: ${event.title}`;
        notificationBody = `Bài tập sẽ mở sau ${timeText} nữa! Chuẩn bị làm bài nhé.`;
      } else if (event.eventType === 'quiz') {
        notificationTitle = event.title.includes(':') ? event.title : `Bài kiểm tra: ${event.title}`;
        notificationBody = `Bài kiểm tra sẽ bắt đầu sau ${timeText} nữa! Hãy chuẩn bị vào làm bài nhé.`;
      } else {
        notificationTitle = event.title.includes(':') ? event.title : `Nhắc nhở: ${event.title}`;
        notificationBody = (event.eventType === 'assign' || event.eventType === 'due')
          ? `Hạn chót sau ${timeText} nữa! Đừng quên nộp bài nhé.`
          : `Sự kiện sẽ diễn ra sau ${timeText} nữa!`;
      }

      // Dùng moodleEventId làm tag để nếu row bị tạo lại (id mới) thì notification
      // mới vẫn thay thế notification cũ trên thiết bị, không xếp chồng 2-3 banner.
      const eventTag = `event-${event.moodleEventId || event.id}`;
      const payload = {
        notification: {
          title: notificationTitle,
          body: notificationBody,
        },
        data: {
          eventId: String(event.id),
          moodleEventId: String(event.moodleEventId || ''),
          eventType: String(event.eventType || 'manual'),
          deliverTime: event.deliverTime.toISOString(),
          diffMinutes: String(diffMinutes),
          moodleCourseId: String(event.moodleCourseId || ''),
          eventDetails: String(event.eventDetails || ''),
          tag: eventTag,
          url: '/home',
        },
        webpush: {
          headers: {
            Urgency: 'high',
            TTL: '86400',
          },
          notification: {
            requireInteraction: true,
            icon: '/lms-assistant-icon.png',
            badge: '/lms-assistant-icon.png',
            tag: eventTag,
          },
          fcmOptions: {
            link: '/home',
          },
        },
        tokens,
      };

      // Gửi Push Notification multicast đồng loạt
      const response = await adminMessaging.sendEachForMulticast(payload);

      if (response.successCount > 0) {
        notificationsSent += response.successCount;

        // Tự động dọn dẹp các token FCM đã hết hạn hoặc không hợp lệ từ phản hồi Firebase
        const invalidTokens: string[] = [];
        response.responses?.forEach((resp, idx) => {
          const errCode = (resp.error as { code?: string })?.code;
          if (!resp.success && (errCode === 'messaging/registration-token-not-registered' || errCode === 'messaging/invalid-registration-token')) {
            invalidTokens.push(tokens[idx]);
          }
        });

        if (invalidTokens.length > 0 && supabaseAdmin) {
          await supabaseAdmin.from('fcm_tokens').delete().in('token', invalidTokens);
        }

        details.push({
          eventId: event.id,
          moodleEventId: event.moodleEventId,
          title: event.title,
          eventType: event.eventType,
          action: 'sent',
          diffMinutes,
          matchedReminder,
          sentCount: response.successCount,
          targetUserIds: pendingUserIds,
          submittedUserIds: Array.from(submittedUserIds),
          remainingReminders,
          reason: event.eventType === 'manual'
            ? `Đã bắn thông báo thủ công mốc ${matchedReminder}m tới ${response.successCount} thiết bị sinh viên trong lớp.`
            : event.eventType === 'attendance'
            ? (matchedReminder < 0
                ? `Đã bắn thông báo nhắc nhở đóng điểm danh 3 phút cuối (Lần 2) tới ${response.successCount} thiết bị sinh viên chưa điểm danh.`
                : `Đã bắn thông báo mở điểm danh (Lần 1) tới ${response.successCount} thiết bị của tất cả sinh viên trong lớp.`)
            : event.eventType === 'assign_open'
            ? `Đã bắn thông báo mốc ${matchedReminder}m trước giờ mở bài tập tới ${response.successCount} thiết bị sinh viên trong lớp.`
            : event.eventType === 'quiz'
            ? `Đã bắn thông báo bài kiểm tra mốc ${matchedReminder}m tới ${response.successCount} thiết bị sinh viên trong lớp.`
            : `Đã bắn thông báo mốc ${matchedReminder}m tới ${response.successCount} thiết bị của sinh viên chưa nộp bài.`,
        });
      } else {
        const failureErrors = response.responses?.map(r => r.error?.message).filter(Boolean);
        details.push({
          eventId: event.id,
          moodleEventId: event.moodleEventId,
          title: event.title,
          action: 'failed',
          diffMinutes,
          matchedReminder,
          targetUserIds: pendingUserIds,
          submittedUserIds: Array.from(submittedUserIds),
          remainingReminders,
          reason: `Mốc ${matchedReminder} phút đã qua. Firebase gửi thất bại: ${failureErrors?.join(', ') || 'Không thể gửi tới thiết bị'}. Đã xóa mốc khỏi sent_reminders.`,
        });
      }
    } else {
      details.push({
        eventId: event.id,
        moodleEventId: event.moodleEventId,
        title: event.title,
        action: 'pending',
        diffMinutes,
        reminders,
        reason: `Chưa đến mốc gửi tiếp theo (hiện còn ${diffMinutes} phút, các mốc hẹn còn lại: [${reminders.join(', ')}])`,
      });
    }
  }

  return {
    success: true,
    eventsDeleted,
    notificationsSent,
    totalEventsScanned: allEvents.length,
    details,
  };
}
