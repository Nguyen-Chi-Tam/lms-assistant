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
 * Tra cứu trạng thái nộp bài qua Moodle REST API (Fallback khi MySQL bị chặn eval).
 */
async function getSubmittedUserIdsViaApi(
  userIds: number[],
  courseId?: number | null,
  title?: string
): Promise<Set<number>> {
  const submittedSet = new Set<number>();
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  if (!MOODLE_URL || !MOODLE_TOKEN || !courseId || userIds.length === 0) {
    return submittedSet;
  }

  const moodleBase = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;

  try {
    // 1. Tìm assignment ID trong môn học
    const assignParams = new URLSearchParams({
      wstoken: MOODLE_TOKEN,
      wsfunction: 'mod_assign_get_assignments',
      moodlewsrestformat: 'json',
      'courseids[0]': String(courseId),
    });
    const assignRes = await fetch(`${moodleBase}?${assignParams.toString()}`);
    if (!assignRes.ok) return submittedSet;

    const assignData = (await assignRes.json()) as {
      courses?: Array<{ assignments?: Array<{ id: number; name: string; cmid?: number }> }>;
    };
    const assignments: Array<{ id: number; name: string; cmid?: number }> =
      assignData.courses?.[0]?.assignments || [];

    if (assignments.length === 0) return submittedSet;

    // Chuẩn hóa tên bài tập để khớp chính xác
    const cleanEventTitle = (title || '').toLowerCase().replace(/^.*:\s*/, '').replace(/\s+is due.*$/i, '').trim();
    let targetAssign = assignments.find(a =>
      a.name.toLowerCase().trim() === cleanEventTitle ||
      cleanEventTitle.includes(a.name.toLowerCase().trim()) ||
      a.name.toLowerCase().trim().includes(cleanEventTitle)
    );

    if (!targetAssign) {
      return submittedSet;
    }

    const assignId = targetAssign.id;

    // 2. Tra cứu trạng thái nộp bài của từng sinh viên qua `mod_assign_get_submission_status`
    for (const uid of userIds) {
      try {
        const subParams = new URLSearchParams({
          wstoken: MOODLE_TOKEN,
          wsfunction: 'mod_assign_get_submission_status',
          moodlewsrestformat: 'json',
          assignid: String(assignId),
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

          if (status === 'submitted' || status === 'draft' || hasOnlineText || hasFiles) {
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
  title?: string
): Promise<Set<number>> {
  if (!userIds || userIds.length === 0) {
    return new Set();
  }

  // TẦNG 1: Truy vấn MySQL Moodle trực tiếp
  if (isMoodleDbAvailable()) {
    try {
      const pool = getMoodlePool();
    let queryStr = '';
    let params: unknown[] = [];

    if (moodleEventId) {
      queryStr = `
        SELECT s.userid
        FROM mdl_event e
        JOIN mdl_assign_submission s ON s.assignment = e.instance
        WHERE e.modulename = 'assign'
          AND (
            s.status = 'submitted'
            OR (s.status != 'new' AND s.status IS NOT NULL)
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
            OR (s.status != 'new' AND s.status IS NOT NULL)
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
      return submittedSet;
    }
  } catch (error) {
    // EvalError trong worker sandbox hoặc lỗi kết nối -> kích hoạt fallback tầng 2
  }
}

  // TẦNG 2: Fallback sang Moodle REST API (luôn hoạt động ổn định trong mọi runtime)
  return await getSubmittedUserIdsViaApi(userIds, courseId, title);
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
          OR (s.status != 'new' AND s.status IS NOT NULL)
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
