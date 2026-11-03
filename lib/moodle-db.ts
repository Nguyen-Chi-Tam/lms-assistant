import mysql from 'mysql2/promise';
import { runtimeEnv } from '@/db/runtime';

let moodlePool: mysql.Pool | null = null;

/**
 * Kiểm tra xem database Moodle (MySQL) có thể truy cập được từ môi trường hiện tại hay không.
 * Trên cloud Vercel / Serverless, host 127.0.0.1 hoặc localhost không thể kết nối tới máy local (Laragon),
 * nên tự động bỏ qua để chuyển thẳng sang Moodle REST API, tránh treo kết nối (timeout).
 */
export function isMoodleDbAvailable(): boolean {
  const env = runtimeEnv();
  const enabled = String(env.MOODLE_DB_ENABLED ?? process.env.MOODLE_DB_ENABLED ?? '')
    .trim()
    .toLowerCase();
  // Cho phép tắt hẳn MySQL Moodle (vd: máy không kết nối được tới DB) để tránh timeout 2.5s mỗi lần gọi.
  if (['false', '0', 'no', 'off'].includes(enabled)) {
    return false;
  }
  const host = env.MOODLE_DB_HOST || process.env.MOODLE_DB_HOST || '127.0.0.1';
  if (process.env.VERCEL && (host === '127.0.0.1' || host === 'localhost')) {
    return false;
  }
  return true;
}

/**
 * Lấy hoặc khởi tạo MySQL Connection Pool kết nối tới database Moodle (Laragon).
 */
export function getMoodlePool(): mysql.Pool {
  if (!moodlePool) {
    const env = runtimeEnv();
    moodlePool = mysql.createPool({
      host: env.MOODLE_DB_HOST || process.env.MOODLE_DB_HOST || '127.0.0.1',
      port: Number(env.MOODLE_DB_PORT || process.env.MOODLE_DB_PORT || 3306),
      user: env.MOODLE_DB_USER || process.env.MOODLE_DB_USER || 'root',
      password: env.MOODLE_DB_PASSWORD ?? process.env.MOODLE_DB_PASSWORD ?? '',
      database: env.MOODLE_DB_NAME || process.env.MOODLE_DB_NAME || 'moodle',
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 2500,
    });
  }
  return moodlePool;
}

/**
 * Lấy danh sách user_id của sinh viên ghi danh trong môn học.
 * Chiến lược kép:
 * 1. Ưu tiên tra cứu trực tiếp MySQL Moodle (cực nhanh trong môi trường Node.js)
 * 2. Fallback sang Moodle REST API `core_enrol_get_enrolled_users` khi chạy trong sandbox (Cloudflare Workers / vinext)
 */
export async function getEnrolledUserIdsFromMoodleDb(courseId: number): Promise<number[]> {
  if (!courseId) return [];

  // 1. Thử MySQL trực tiếp: Lọc CHỈ LẤY SINH VIÊN (role = 'student'), tuyệt đối không lấy giáo viên/trợ giảng
  if (isMoodleDbAvailable()) {
    try {
      const pool = getMoodlePool();
    const queryStr = `
      SELECT DISTINCT ue.userid
      FROM mdl_user_enrolments ue
      JOIN mdl_enrol e ON e.id = ue.enrolid
      JOIN mdl_context ctx ON ctx.instanceid = e.courseid AND ctx.contextlevel = 50
      JOIN mdl_role_assignments ra ON ra.userid = ue.userid AND ra.contextid = ctx.id
      JOIN mdl_role r ON r.id = ra.roleid
      WHERE e.courseid = ? 
        AND ue.status = 0 
        AND r.shortname = 'student'
    `;
      const [rows] = await pool.query(queryStr, [courseId]);
      if (Array.isArray(rows) && rows.length > 0) {
        return (rows as Array<{ userid: number | string }>).map(r => Number(r.userid)).filter(Boolean);
      }
    } catch (mysqlErr) {
      // Nếu MySQL bị hạn chế (EvalError trong worker sandbox) hoặc mất kết nối, tiếp tục fallback
    }
  }

  // 2. Fallback sang Moodle REST API: Chỉ lấy tài khoản có role 'student'
  try {
    const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
    if (MOODLE_URL && MOODLE_TOKEN) {
      const moodleBase = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
      const params = new URLSearchParams({
        wstoken: MOODLE_TOKEN,
        wsfunction: 'core_enrol_get_enrolled_users',
        moodlewsrestformat: 'json',
        courseid: String(courseId),
      });
      const res = await fetch(`${moodleBase}?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as any;
        if (Array.isArray(data)) {
          return data
            .filter((u: any) => Array.isArray(u.roles) && u.roles.some((r: any) => r.shortname === 'student'))
            .map((u: any) => Number(u.id))
            .filter(Boolean);
        }
      }
    }
  } catch (apiErr) {
    console.warn('[Moodle DB] Lỗi tra cứu danh sách ghi danh qua API:', apiErr);
  }

  return [];
}

/**
 * Gọi một Moodle Web Service function và trả về JSON đã parse.
 * Trả về null nếu HTTP lỗi hoặc Moodle trả về exception/errorcode.
 */
async function callMoodleWebService<T>(
  moodleBase: string,
  token: string,
  wsfunction: string,
  params: Record<string, string> = {}
): Promise<T | null> {
  const query = new URLSearchParams({
    wstoken: token,
    wsfunction,
    moodlewsrestformat: 'json',
    ...params,
  });
  const requestUrl = `${moodleBase}?${query.toString()}`;

  // Thử tối đa 3 lần (1 lần chính + 2 lần fallback) với timeout 15s
  // và exponential backoff (1s, 2s) kèm jitter để tránh quá tải server Moodle.
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(requestUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[Moodle DB] ${wsfunction}: HTTP ${res.status}`);
        // Lần thử cuối cùng -> trả null ngay
        if (attempt === 2) return null;
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 200));
        continue;
      }
      const data = (await res.json()) as T & {
        exception?: string;
        errorcode?: string;
        message?: string;
      };
      if (data && typeof data === 'object' && (data.exception || data.errorcode)) {
        console.warn(`[Moodle DB] ${wsfunction}: ${data.message || data.exception || data.errorcode}`);
        return null;
      }
      return data as T;
    } catch (err: any) {
      clearTimeout(timer);
      // Lần thử cuối cùng -> trả null
      if (attempt === 2) {
        console.warn(`[Moodle DB] ${wsfunction} failed after 3 attempts:`, err?.message || err);
        return null;
      }
      // Exponential backoff: 1000ms, 2000ms kèm jitter
      const baseDelay = 1000 * Math.pow(2, attempt);
      const jitter = Math.random() * 200;
      const delay = baseDelay + jitter;
      console.warn(`[Moodle DB] ${wsfunction} attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

/**
 * Moodle trả về danh sách dạng mảng hoặc object keyed by id tuỳ phiên bản
 * (external_multiple_structure dùng key không tuần tự sẽ serialize thành object).
 */
function toObjectArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, T>);
  }
  return [];
}

interface MoodleAttendanceStatus {
  id?: number | string;
  acronym?: string;
  grade?: number | string;
}

interface MoodleAttendanceLog {
  studentid?: number | string;
  statusid?: number | string;
  id?: number | string;
}

interface MoodleAttendanceSession {
  id?: number | string;
  attendanceid?: number | string;
  sessdate?: number | string;
  duration?: number | string;
  statuses?: unknown;
  attendance_log?: unknown;
  logs?: unknown;
  log?: unknown;
}

/** Log điểm danh có thể nằm ở `attendance_log` (chuẩn) hoặc `logs`/`log` (một số bản plugin). */
function getAttendanceLogs(session: MoodleAttendanceSession): unknown {
  return session.attendance_log ?? session.logs ?? session.log;
}

/**
 * Một số phiên bản plugin bọc dữ liệu trong key `session` (external_single_structure),
 * số khác trả về trực tiếp. Chuẩn hoá để phần đọc log phía dưới hoạt động với cả hai.
 */
function normalizeAttendanceSession(raw: unknown): MoodleAttendanceSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.session && typeof obj.session === 'object') {
    return obj.session as MoodleAttendanceSession;
  }
  return obj as MoodleAttendanceSession;
}

/**
 * Tra cứu sinh viên ĐÃ ĐIỂM DANH qua Moodle Web Service.
 *
 * Lưu ý quan trọng:
 * - `mod_attendance_get_attendances` KHÔNG tồn tại trong plugin attendance
 *   (đây là nguyên nhân trước đây luôn trả về rỗng).
 * - Hàm đúng là `mod_attendance_get_session` / `mod_attendance_get_sessions`,
 *   và log điểm danh nằm trong `attendance_log`.
 * - Chỉ tính là đã điểm danh khi status có grade > 0 (P/L/E); các status
 *   grade = 0 (Absent) không được coi là đã điểm danh.
 */
async function getAttendanceUserIdsViaApi(
  userIds: number[],
  courseId: number | null | undefined,
  attendanceId: number | null | undefined,
  sessionId: number | null | undefined,
  eventStartMs: number | null | undefined
): Promise<Set<number>> {
  const submittedSet = new Set<number>();
  const env = runtimeEnv();
  const { MOODLE_URL } = env;
  // Token của service "Attendance" (chỉ chứa các hàm mod_attendance_*) nếu có,
  // nếu không thì dùng token chung MOODLE_TOKEN.
  const attendanceToken = env.MOODLE_ATTENDANCE_TOKEN || env.MOODLE_TOKEN;
  if (!MOODLE_URL || !attendanceToken || !courseId || userIds.length === 0) {
    return submittedSet;
  }

  const moodleBase = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
  const startSec = eventStartMs ? Math.floor(eventStartMs / 1000) : null;
  const nowSec = Math.floor(Date.now() / 1000);

  // Chỉ nhận đúng phiên của sự kiện này (tránh đọc log của ca khác trong cùng môn).
  const isTargetSession = (sess: MoodleAttendanceSession): boolean => {
    if (attendanceId && sess.attendanceid != null && Number(sess.attendanceid) !== attendanceId) {
      return false;
    }
    if (startSec == null) return true;
    const start = Number(sess.sessdate || 0);
    const duration = Number(sess.duration || 0);
    return (
      Math.abs(start - startSec) <= 180 ||
      (start <= startSec + 180 && start + duration >= startSec - 180) ||
      (start <= nowSec && start + duration >= nowSec)
    );
  };

  const sessionIds = new Set<number>();
  const rawById = new Map<number, MoodleAttendanceSession>();

  const collect = (raw: unknown) => {
    const sess = normalizeAttendanceSession(raw);
    if (!sess || sess.id == null) return;
    const id = Number(sess.id);
    if (!Number.isFinite(id) || !isTargetSession(sess)) return;
    sessionIds.add(id);
    rawById.set(id, sess);
  };

  // 1. Biết trước session id (sync-moodle lưu trong event_details) -> dùng luôn.
  if (sessionId) {
    sessionIds.add(sessionId);
  }

  if (attendanceId) {
    // 2. Đường nhẹ: các buổi điểm danh trong hôm nay của user thuộc token.
    const today = await callMoodleWebService<unknown>(
      moodleBase,
      attendanceToken,
      'mod_attendance_get_courses_with_today_sessions',
      { userid: String(userIds[0]) }
    );
    for (const course of toObjectArray<{ attendance_instances?: unknown }>(today)) {
      for (const instance of toObjectArray<{ today_sessions?: unknown }>(course.attendance_instances)) {
        for (const raw of toObjectArray<unknown>(instance.today_sessions)) {
          collect(raw);
        }
      }
    }

    // 3. Fallback: lấy toàn bộ session của attendance instance rồi lọc theo giờ mở.
    if (sessionIds.size === 0) {
      const list = await callMoodleWebService<unknown>(
        moodleBase,
        attendanceToken,
        'mod_attendance_get_sessions',
        { attendanceid: String(attendanceId) }
      );
      for (const raw of toObjectArray<unknown>(list)) {
        collect(raw);
      }
    }
  }

  // 4. Luôn lấy chi tiết từng phiên: `mod_attendance_get_session` mới trả kèm
  //    attendance_log đầy đủ (list sessions thường không có log).
  const detailById = new Map<number, MoodleAttendanceSession>();
  for (const id of sessionIds) {
    const detail = await callMoodleWebService<MoodleAttendanceSession>(
      moodleBase,
      attendanceToken,
      'mod_attendance_get_session',
      { sessionid: String(id) }
    );
    const normalized = normalizeAttendanceSession(detail);
    const hasLogs = normalized ? toObjectArray(getAttendanceLogs(normalized)).length > 0 : false;
    const chosen = (hasLogs ? normalized : rawById.get(id) || normalized) || null;
    if (chosen) detailById.set(id, chosen);
  }

  const candidates = Array.from(detailById.values());

  if (candidates.length === 0) {
    console.warn(
      '[Moodle DB] Không đọc được dữ liệu điểm danh từ Moodle. ' +
      'Kiểm tra MOODLE_ATTENDANCE_TOKEN (hoặc MOODLE_TOKEN) có service chứa ' +
      'mod_attendance_get_session + mod_attendance_get_sessions ' +
      '(và mod_attendance_get_courses_with_today_sessions), ' +
      'đồng thời user của token có quyền mod/attendance:takeattendances.'
    );
  }

  for (const session of candidates) {
    const gradeByStatusId = new Map<string, number>();
    for (const status of toObjectArray<MoodleAttendanceStatus>(session.statuses)) {
      const statusId = Number(status.id);
      if (!Number.isNaN(statusId)) {
        gradeByStatusId.set(String(statusId), Number(status.grade ?? 0));
      }
    }

    for (const log of toObjectArray<MoodleAttendanceLog>(getAttendanceLogs(session))) {
      const uid = Number(log.studentid);
      if (!uid || !userIds.includes(uid)) continue;

      const rawStatusId = Number(log.statusid);
      if (Number.isNaN(rawStatusId)) continue;
      const statusKey = String(rawStatusId);
      const hasStatusMeta = gradeByStatusId.has(statusKey);

      // Không có metadata status (Moodle cũ/thiếu quyền) -> giữ hành vi cũ:
      // có log nghĩa là đã điểm danh. Có metadata -> yêu cầu grade > 0.
      if (!hasStatusMeta || (gradeByStatusId.get(statusKey) ?? 0) > 0) {
        submittedSet.add(uid);
      }
    }
  }

  return submittedSet;
}

/**
 * Tra cứu trạng thái nộp bài / điểm danh qua Moodle REST API
 * (Fallback khi MySQL bị chặn eval hoặc không kết nối được).
 */
async function getSubmittedUserIdsViaApi(
  userIds: number[],
  courseId?: number | null,
  title?: string,
  attendanceId?: number | null,
  sessionId?: number | null,
  eventStartMs?: number | null,
  assignId?: number | null
): Promise<Set<number>> {
  const submittedSet = new Set<number>();
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  if (!MOODLE_URL || !MOODLE_TOKEN || !courseId || userIds.length === 0) {
    return submittedSet;
  }

  // Sự kiện điểm danh: chỉ cần tra log điểm danh, không phụ thuộc assignment.
  if (attendanceId || sessionId) {
    return await getAttendanceUserIdsViaApi(userIds, courseId, attendanceId, sessionId, eventStartMs);
  }

  const moodleBase = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;

  try {
    let targetAssignId = assignId ? Number(assignId) : null;

    // Tìm assignment ID trong môn học theo tên. Dùng làm fallback khi chưa có
    // assignId, hoặc khi assignId trong event_details không được Moodle nhận diện
    // (ví dụ event lấy từ action-events trả về course-module id thay vì assign id).
    const resolveAssignIdByName = async (): Promise<number | null> => {
      if (!courseId) return null;

      const assignData = await callMoodleWebService<{
        courses?: Array<{ assignments?: Array<{ id: number; name: string; duedate?: number; cmid?: number }> }>;
        warnings?: Array<{ item?: string; message?: string }>;
      }>(moodleBase, MOODLE_TOKEN, 'mod_assign_get_assignments', {
        'courseids[0]': String(courseId),
      });

      const assignments: Array<{ id: number; name: string; duedate?: number; cmid?: number }> =
        assignData?.courses?.[0]?.assignments || [];

      if (assignments.length === 0) {
        const warning = assignData?.warnings?.[0]?.message;
        console.warn(
          `[Moodle API] Không lấy được danh sách bài tập của môn ${courseId} để đối chiếu tên bài nộp${warning ? `: ${warning}` : ''}`
        );
        return null;
      }

      // Chuẩn hóa tên bài tập để khớp chính xác (loại bỏ tiền tố khóa học và hậu tố tiếng Anh/Việt)
      const cleanEventTitle = (title || '')
        .toLowerCase()
        .replace(/^.*:\s*/, '')
        .replace(/\s+(?:is due|tới hạn|đến hạn).*$/i, '')
        .replace(/\s+(?:opens?|closes?|bắt đầu|kết thúc)\s*$/i, '')
        .trim();

      const matchedAssigns = assignments.filter(a => {
        const aName = a.name.toLowerCase().trim();
        return aName === cleanEventTitle || cleanEventTitle.includes(aName) || aName.includes(cleanEventTitle);
      });

      if (matchedAssigns.length === 0) return null;

      if (matchedAssigns.length > 1 && eventStartMs) {
        // Nếu có nhiều bài cùng tên, chọn bài có duedate gần nhất với mốc eventStartMs
        const targetSec = Math.floor(eventStartMs / 1000);
        matchedAssigns.sort((a, b) => Math.abs((a.duedate || 0) - targetSec) - Math.abs((b.duedate || 0) - targetSec));
      }

      return matchedAssigns[0].id;
    };

    if (!targetAssignId) {
      targetAssignId = await resolveAssignIdByName();
    }

    if (!targetAssignId) return submittedSet;

    // 2. Tra cứu trạng thái nộp bài qua API chuẩn: `mod_assign_get_submissions` (1 request lấy tất cả)
    type SubmittedAssignment = {
      assignmentid: number;
      submissions?: Array<{
        id: number;
        userid: number;
        status: string;
        plugins?: Array<{
          type?: string;
          editorfields?: Array<{ text?: string }>;
          fileareas?: Array<{ files?: unknown[] }>;
        }>;
      }>;
    };

    const fetchSubmissions = async (assignmentId: number) => {
      const subRes = await callMoodleWebService<{ assignments?: SubmittedAssignment[] }>(
        moodleBase,
        MOODLE_TOKEN,
        'mod_assign_get_submissions',
        { 'assignmentids[0]': String(assignmentId) }
      );
      const assignment = subRes?.assignments?.find(a => Number(a.assignmentid) === assignmentId);
      return { assignment, submissions: assignment?.submissions || [] };
    };

    let { assignment, submissions } = await fetchSubmissions(targetAssignId);

    if (!assignment && assignId) {
      const resolved = await resolveAssignIdByName();
      if (resolved && resolved !== targetAssignId) {
        targetAssignId = resolved;
        ({ assignment, submissions } = await fetchSubmissions(targetAssignId));
      }
    }

    if (assignment) {
      for (const sub of submissions) {
        const uid = Number(sub.userid);
        if (!uid || !userIds.includes(uid)) continue;

        const status = sub.status;
        const plugins = sub.plugins || [];

        const hasOnlineText = plugins.some((p: { type?: string; editorfields?: Array<{ text?: string }> }) =>
          p.type === 'onlinetext' &&
          p.editorfields?.some(f => f.text && f.text.trim() !== '' && f.text !== '<p></p>')
        );

        const hasFiles = plugins.some((p: { type?: string; fileareas?: Array<{ files?: unknown[] }> }) =>
          p.type === 'file' &&
          p.fileareas?.some(a => Array.isArray(a.files) && a.files.length > 0)
        );

        if (status === 'submitted' || hasOnlineText || hasFiles) {
          submittedSet.add(uid);
        }
      }
      return submittedSet;
    }

    // 3. Fallback: Nếu `mod_assign_get_submissions` không khả dụng, gọi `mod_assign_get_submission_status` từng user
    for (const uid of userIds) {
      try {
        const subParams = new URLSearchParams({
          wstoken: MOODLE_TOKEN,
          wsfunction: 'mod_assign_get_submission_status',
          moodlewsrestformat: 'json',
          assignid: String(targetAssignId),
          userid: String(uid),
        });
        const subRes = await fetch(`${moodleBase}?${subParams.toString()}`);
        if (subRes.ok) {
          const subData = (await subRes.json()) as any;
          const submission = subData?.lastattempt?.submission;
          const status = submission?.status;
          const plugins = submission?.plugins || [];

          const hasOnlineText = plugins.some((p: { type?: string; editorfields?: Array<{ text?: string }> }) =>
            p.type === 'onlinetext' &&
            p.editorfields?.some(f => f.text && f.text.trim() !== '' && f.text !== '<p></p>')
          );

          const hasFiles = plugins.some((p: { type?: string; fileareas?: Array<{ files?: unknown[] }> }) =>
            p.type === 'file' &&
            p.fileareas?.some(a => Array.isArray(a.files) && a.files.length > 0)
          );

          if (status === 'submitted' || hasOnlineText || hasFiles) {
            submittedSet.add(uid);
          }
        }
      } catch (userErr) {
        console.warn(`[Moodle DB] Lỗi kiểm tra bài nộp user ${uid}:`, userErr);
      }
    }
  } catch (err) {
    console.warn('[Moodle DB] Lỗi API kiểm tra nộp bài:', err);
  }

  return submittedSet;
}

/**
 * Tra cứu danh sách sinh viên ĐÃ NỘP BÀI cho một sự kiện cụ thể.
 * 
 * Kiến trúc 2 tầng (Dual-Engine):
 * 1. Tầng 1: MySQL trực tiếp (Reverse Engineering) cho tốc độ tối đa trong Node.js
 * 2. Tầng 2: Moodle REST API fallback tự động khi chạy trong môi trường worker sandbox (vinext)
 * 
 * @param moodleEventId ID sự kiện trên bảng mdl_event
 * @param userIds Danh sách user_id sinh viên cần kiểm tra
 * @param courseId ID khóa học trên Moodle
 * @param title Tiêu đề sự kiện / bài tập
 */
export async function getSubmittedUserIdsForEvent(
  moodleEventId: number | null | undefined,
  userIds: number[],
  courseId?: number | null,
  title?: string,
  attendanceId?: number | null,
  sessionId?: number | null,
  eventStartMs?: number | null,
  assignId?: number | null
): Promise<Set<number>> {
  if (!userIds || userIds.length === 0) {
    return new Set();
  }

  const isAttendanceLookup = Boolean(attendanceId || sessionId);

  // TẦNG 1: Truy vấn MySQL Moodle trực tiếp
  if (isMoodleDbAvailable()) {
    try {
      const pool = getMoodlePool();

    // Điểm danh có query riêng: khớp đúng buổi và chỉ tính status grade > 0
    // (P/L/E), tránh trường hợp log "Absent" bị coi là đã điểm danh.
    if (isAttendanceLookup) {
      const conditions: string[] = ['al.studentid IN (?)', '(st.id IS NULL OR st.grade > 0)'];
      const attParams: unknown[] = [userIds];
      let eventJoin = '';

      if (sessionId) {
        conditions.push('sess.id = ?');
        attParams.push(sessionId);
      } else if (attendanceId && eventStartMs) {
        const startSec = Math.floor(eventStartMs / 1000);
        conditions.push('sess.attendanceid = ? AND sess.sessdate BETWEEN ? AND ?');
        attParams.push(attendanceId, startSec - 180, startSec + 180);
      } else if (attendanceId) {
        conditions.push('sess.attendanceid = ?');
        attParams.push(attendanceId);
      } else if (moodleEventId) {
        eventJoin = `LEFT JOIN mdl_event e ON (e.id = sess.caleventid OR (e.instance = sess.attendanceid AND e.modulename = 'attendance' AND e.timestart = sess.sessdate))`;
        conditions.push('(e.id = ? OR sess.id = ? OR (sess.id + 100000) = ?)');
        attParams.push(moodleEventId, moodleEventId, moodleEventId);
      }

      const attendanceQuery = `
        SELECT DISTINCT al.studentid AS userid
        FROM mdl_attendance_log al
        JOIN mdl_attendance_sessions sess ON sess.id = al.sessionid
        LEFT JOIN mdl_attendance_statuses st ON st.id = al.statusid
        ${eventJoin}
        WHERE ${conditions.join(' AND ')}
      `;

      const [attRows] = await pool.query(attendanceQuery, attParams);
      const attendanceSet = new Set<number>();
      if (Array.isArray(attRows)) {
        for (const row of attRows as Array<{ userid: number | string }>) {
          const id = Number(row.userid);
          if (id) attendanceSet.add(id);
        }
      }
      return attendanceSet;
    }

    let queryStr = '';
    let params: unknown[] = [];

    if (assignId) {
      const [assignRows] = await pool.query(
        `SELECT s.userid
         FROM mdl_assign_submission s
         WHERE s.assignment = ?
           AND s.userid IN (?)
           AND (
             s.status = 'submitted'
             OR EXISTS (
               SELECT 1 FROM mdl_assignsubmission_onlinetext ot 
               WHERE ot.submission = s.id 
                 AND ot.onlinetext IS NOT NULL 
                 AND TRIM(ot.onlinetext) != '' 
                 AND ot.onlinetext != '<p></p>'
             )
             OR EXISTS (
               SELECT 1 FROM mdl_files f 
               WHERE f.component = 'assignsubmission_file' 
                 AND f.filearea = 'submission_files' 
                 AND f.itemid = s.id 
                 AND f.filesize > 0
             )
           )`,
        [assignId, userIds]
      );
      const subSet = new Set<number>();
      if (Array.isArray(assignRows)) {
        for (const row of assignRows as Array<{ userid: number | string }>) {
          const id = Number(row.userid);
          if (id) subSet.add(id);
        }
      }
      if (subSet.size > 0) return subSet;
    }

    if (moodleEventId) {
      queryStr = `
        SELECT s.userid
        FROM mdl_event e
        JOIN mdl_assign_submission s ON s.assignment = e.instance
        WHERE e.modulename = 'assign'
          AND (
            s.status = 'submitted'
            OR EXISTS (
              SELECT 1 FROM mdl_assignsubmission_onlinetext ot 
              WHERE ot.submission = s.id 
                AND ot.onlinetext IS NOT NULL 
                AND TRIM(ot.onlinetext) != '' 
                AND ot.onlinetext != '<p></p>'
            )
            OR EXISTS (
              SELECT 1 FROM mdl_files f 
              WHERE f.component = 'assignsubmission_file' 
                AND f.filearea = 'submission_files' 
                AND f.itemid = s.id 
                AND f.filesize > 0
            )
          )
          AND e.id = ?
          AND s.userid IN (?)
        UNION
        SELECT q.userid
        FROM mdl_event e
        JOIN mdl_quiz_attempts q ON q.quiz = e.instance
        WHERE e.modulename = 'quiz'
          AND q.state = 'finished'
          AND e.id = ?
          AND q.userid IN (?)
        UNION
        SELECT al.studentid as userid
        FROM mdl_attendance_sessions sess
        JOIN mdl_attendance_log al ON al.sessionid = sess.id
        LEFT JOIN mdl_event e ON (sess.caleventid = e.id OR (sess.attendanceid = e.instance AND sess.sessdate = e.timestart))
        WHERE (e.id = ? OR sess.id = ? OR (sess.id + 100000) = ?)
          AND al.studentid IN (?)
      `;
      params = [moodleEventId, userIds, moodleEventId, userIds, moodleEventId, moodleEventId, moodleEventId, userIds];
    } else if (courseId) {
      queryStr = `
        SELECT s.userid
        FROM mdl_assign a
        JOIN mdl_assign_submission s ON s.assignment = a.id
        WHERE a.course = ?
          AND (
            s.status = 'submitted'
            OR EXISTS (
              SELECT 1 FROM mdl_assignsubmission_onlinetext ot 
              WHERE ot.submission = s.id 
                AND ot.onlinetext IS NOT NULL 
                AND TRIM(ot.onlinetext) != '' 
                AND ot.onlinetext != '<p></p>'
            )
            OR EXISTS (
              SELECT 1 FROM mdl_files f 
              WHERE f.component = 'assignsubmission_file' 
                AND f.filearea = 'submission_files' 
                AND f.itemid = s.id 
                AND f.filesize > 0
            )
          )
          AND s.userid IN (?)
        UNION
        SELECT al.studentid as userid
        FROM mdl_attendance a
        JOIN mdl_attendance_sessions sess ON sess.attendanceid = a.id
        JOIN mdl_attendance_log al ON al.sessionid = sess.id
        WHERE a.course = ?
          AND al.studentid IN (?)
      `;
      params = [courseId, userIds, courseId, userIds];
    }

    if (queryStr) {
      const [rows] = await pool.query(queryStr, params);
      const submittedSet = new Set<number>();
      if (Array.isArray(rows)) {
        for (const row of rows as Array<{ userid: number | string }>) {
          submittedSet.add(Number(row.userid));
        }
      }
      if (submittedSet.size > 0) {
        return submittedSet;
      }

      // Calendar events are not guaranteed to use the assignment id as
      // `mdl_event.instance`. Resolve the assignment from the course/title
      // and then inspect the submission tables shown in Moodle's schema.
      if (courseId && title) {
        const [assignmentRows] = await pool.query(
          `SELECT id, name
           FROM mdl_assign
           WHERE course = ?`,
          [courseId]
        );
        const cleanTitle = title
          .toLowerCase()
          .replace(/^.*:\s*/, '')
          .replace(/\s+is due.*$/i, '')
          .trim();
        const assignment = Array.isArray(assignmentRows)
          ? (assignmentRows as Array<{ id: number | string; name?: string }>).find(row => {
              const name = (row.name || '').toLowerCase().trim();
              return Boolean(name) && (
                name === cleanTitle || cleanTitle.includes(name) || name.includes(cleanTitle)
              );
            })
          : undefined;

        if (assignment) {
          const [submissionRows] = await pool.query(
            `SELECT s.userid
             FROM mdl_assign_submission s
             WHERE s.assignment = ?
               AND s.userid IN (?)
               AND (
                 s.status = 'submitted'
                 OR EXISTS (
                   SELECT 1
                   FROM mdl_assignsubmission_onlinetext ot
                   WHERE ot.submission = s.id
                     AND ot.onlinetext IS NOT NULL
                     AND TRIM(ot.onlinetext) != ''
                     AND ot.onlinetext != '<p></p>'
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM mdl_files f
                   WHERE f.component = 'assignsubmission_file'
                     AND f.filearea = 'submission_files'
                     AND f.itemid = s.id
                     AND f.filesize > 0
                 )
               )`,
            [Number(assignment.id), userIds]
          );
          if (Array.isArray(submissionRows)) {
            for (const row of submissionRows as Array<{ userid: number | string }>) {
              submittedSet.add(Number(row.userid));
            }
          }
        }
      }

      if (submittedSet.size > 0) {
        return submittedSet;
      }
    }
  } catch (error) {
    // EvalError trong worker sandbox hoặc lỗi kết nối -> kích hoạt fallback tầng 2
  }
}

  // TẦNG 2: Fallback sang Moodle REST API (luôn hoạt động ổn định trong mọi runtime)
  return await getSubmittedUserIdsViaApi(userIds, courseId, title, attendanceId, sessionId, eventStartMs, assignId);
}

/**
 * Tra cứu danh sách các moodleEventId mà một sinh viên cụ thể đã nộp bài.
 */
export async function getSubmittedEventIdsForUser(
  userId: number,
  moodleEventIds: number[]
): Promise<Set<number>> {
  if (!userId || !moodleEventIds || moodleEventIds.length === 0) {
    return new Set();
  }

  if (isMoodleDbAvailable()) {
    try {
      const pool = getMoodlePool();
    const queryStr = `
      SELECT e.id AS moodle_event_id
      FROM mdl_event e
      JOIN mdl_assign_submission s ON s.assignment = e.instance
      WHERE e.modulename = 'assign'
        AND (
          s.status = 'submitted'
          OR EXISTS (
            SELECT 1 FROM mdl_assignsubmission_onlinetext ot 
            WHERE ot.submission = s.id 
              AND ot.onlinetext IS NOT NULL 
              AND TRIM(ot.onlinetext) != '' 
              AND ot.onlinetext != '<p></p>'
          )
          OR EXISTS (
            SELECT 1 FROM mdl_files f 
            WHERE f.component = 'assignsubmission_file' 
              AND f.filearea = 'submission_files' 
              AND f.itemid = s.id 
              AND f.filesize > 0
          )
        )
        AND s.userid = ?
        AND e.id IN (?)
      UNION
      SELECT e.id AS moodle_event_id
      FROM mdl_event e
      JOIN mdl_quiz_attempts q ON q.quiz = e.instance
      WHERE e.modulename = 'quiz'
        AND q.state = 'finished'
        AND q.userid = ?
        AND e.id IN (?)
      UNION
      SELECT e.id AS moodle_event_id
      FROM mdl_event e
      JOIN mdl_attendance_sessions sess ON (sess.caleventid = e.id OR (sess.attendanceid = e.instance AND sess.sessdate = e.timestart))
      JOIN mdl_attendance_log al ON al.sessionid = sess.id
      WHERE e.modulename = 'attendance'
        AND al.studentid = ?
        AND e.id IN (?)
    `;

    const [rows] = await pool.query(queryStr, [
      userId,
      moodleEventIds,
      userId,
      moodleEventIds,
      userId,
      moodleEventIds,
    ]);

    const submittedEventIds = new Set<number>();
    if (Array.isArray(rows)) {
      for (const row of rows as Array<{ moodle_event_id: number | string }>) {
        submittedEventIds.add(Number(row.moodle_event_id));
      }
    }

    return submittedEventIds;
  } catch (error) {
    return new Set();
  }
}
  return new Set();
}

/**
 * Đóng connection pool nếu cần giải phóng tài nguyên.
 */
export async function closeMoodlePool(): Promise<void> {
  if (moodlePool) {
    await moodlePool.end();
    moodlePool = null;
  }
}
