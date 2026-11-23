import { supabaseAdmin } from '@/lib/database/supabase';
import { runtimeEnv } from '@/db/runtime';
import { getMoodlePool, getSubmittedEventIdsForUser, isMoodleDbAvailable } from '@/lib/database/moodle-db';
import { getLatestQuizAnalysis } from '@/lib/learning/learning-artifacts';
import type { ExamResult } from '@/app/types';

/**
 * Tầng 0 (student_progress) —gom "bức tranh tiến độ học tập" thực tế của sinh viên
 * trong ĐÚNG môn đang mở, để /api/tutor trả lời ngay mà không cần chờ độ tương đồng PDF.
 *
 * LƯU Ý: bảng `user_course_analytics` đã bị gỡ. Điểm số hiện được lấy live từ Moodle
 * (`gradereport_user_get_grade_items`, truyền vào đây qua `gradebook` từ client),
 * lịch nộp/điểm danh lấy từ Moodle DB (hoặc bảng `events` của Supabase làm dự phòng),
 * trạng thái đã nộp/đã điểm danh đối chiếu trực tiếp với Moodle,
 * còn phân tích lỗi sai lấy từ học liệu `learning_artifacts` (Firestore).
 */

export interface StudentProgressContextParams {
  userId: number;
  courseId?: number;
  courseName?: string;
  /** ExamResult[] đã được client lọc theo môn hiện tại và truyền qua /api/tutor. */
  gradebook?: ExamResult[];
  /** Chỉ lấy/đưa vào prompt các phần sinh viên thực sự hỏi. Mặc định lấy tất cả. */
  focus?: { exam?: boolean; attendance?: boolean; homework?: boolean };
}

type ProgressEvent = {
  moodle_event_id?: number | string | null;
  title?: string | null;
  event_type?: string | null;
  deliver_time?: string | null;
};

type ProgressItem = {
  id: number;
  title: string;
  dueMs: number;
  completed: boolean;
  kind?: 'assign' | 'quiz' | 'attendance';
};

type MoodleProgress = {
  attendance: { total: number; attended: number } | null;
  assignments: ProgressItem[];
  quizzes: ProgressItem[];
};

const fmtDate = (value?: string | number | null): string => {
  if (value === null || value === undefined || value === '') return 'chưa rõ';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'chưa rõ';
  return date.toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
};

const isAssignmentType = (type = ''): boolean => /^(assign|assignment)$/i.test(type) || /assign/i.test(type);
const isQuizType = (type = ''): boolean => /quiz/i.test(type);
const isAttendanceType = (type = ''): boolean => /attendance/i.test(type) || /điểm\s*danh/i.test(type);

/** Truy vấn trực tiếp Moodle DB —nguồn duy nhất có lịch sử điểm danh/bài nộp đã qua. */
async function queryMoodleProgress(
  userId: number,
  courseId: number,
  wantAttendance: boolean,
  wantHomework: boolean
): Promise<MoodleProgress | null> {
  if (!userId || !courseId || !isMoodleDbAvailable()) return null;
  if (!wantAttendance && !wantHomework) return null;

  try {
    const pool = getMoodlePool();

    const [attRows] = wantAttendance ? await pool.query(
      `SELECT COUNT(DISTINCT sess.id) AS total_sessions,
              COUNT(DISTINCT CASE WHEN COALESCE(st.grade, 0) > 0 THEN sess.id END) AS attended_sessions
       FROM mdl_attendance att
       JOIN mdl_attendance_sessions sess ON sess.attendanceid = att.id
       LEFT JOIN mdl_attendance_log al ON al.sessionid = sess.id AND al.studentid = ?
       LEFT JOIN mdl_attendance_statuses st ON st.id = al.statusid
       WHERE att.course = ? AND sess.sessdate > 0 AND sess.sessdate <= UNIX_TIMESTAMP()`,
      [userId, courseId]
    ) : [[]];

    const [eventRows] = wantHomework ? await pool.query(
      `SELECT e.id AS moodle_event_id, e.name AS title, e.modulename AS event_type, e.timestart AS due_ts,
              CASE WHEN EXISTS (
                SELECT 1 FROM mdl_assign_submission s
                WHERE s.assignment = e.instance AND s.userid = ?
                  AND (s.status = 'submitted' OR EXISTS (
                    SELECT 1 FROM mdl_assignsubmission_onlinetext ot
                    WHERE ot.submission = s.id AND ot.onlinetext IS NOT NULL AND TRIM(ot.onlinetext) <> ''
                  ) OR EXISTS (
                    SELECT 1 FROM mdl_files f
                    WHERE f.component = 'assignsubmission_file' AND f.filearea = 'submission_files'
                      AND f.itemid = s.id AND f.filesize > 0
                  ))
              ) THEN 1 ELSE 0 END AS submitted,
              CASE WHEN EXISTS (
                SELECT 1 FROM mdl_quiz_attempts q
                WHERE q.quiz = e.instance AND q.userid = ? AND q.state = 'finished'
              ) THEN 1 ELSE 0 END AS finished
       FROM mdl_event e
       WHERE e.courseid = ? AND e.timestart > 0 AND e.modulename IN ('assign', 'quiz')
       ORDER BY e.timestart ASC
       LIMIT 200`,
      [userId, userId, courseId]
    ) : [[]];

    const att = (Array.isArray(attRows) ? attRows[0] : null) as
      | { total_sessions?: number | string; attended_sessions?: number | string }
      | undefined;

    const assignments: ProgressItem[] = [];
    const quizzes: ProgressItem[] = [];
    if (Array.isArray(eventRows)) {
      for (const row of eventRows as Array<{
        moodle_event_id?: number | string;
        title?: string;
        event_type?: string;
        due_ts?: number | string;
        submitted?: number | string | boolean;
        finished?: number | string | boolean;
      }>) {
        const id = Number(row.moodle_event_id);
        const dueSec = Number(row.due_ts);
        if (!id || !Number.isFinite(dueSec)) continue;
        const item: ProgressItem = {
          id,
          title: row.title || 'Bài tập chưa đặt tên',
          dueMs: dueSec * 1000,
          completed:
            isAssignmentType(row.event_type) || row.event_type === 'assign'
              ? Number(row.submitted) > 0
              : Number(row.finished) > 0,
          kind: isQuizType(row.event_type) ? 'quiz' : 'assign',
        };
        if (isQuizType(row.event_type)) quizzes.push(item);
        else assignments.push(item);
      }
    }

    return {
      attendance:
        att && Number(att.total_sessions) > 0
          ? { total: Number(att.total_sessions), attended: Number(att.attended_sessions) || 0 }
          : null,
      assignments,
      quizzes,
    };
  } catch (err) {
    console.warn('[Student Progress] Moodle DB progress query note:', err);
    return null;
  }
}

type MoodleRestProgress = {
  events: ProgressItem[];
  attendance: { total: number; attended: number } | null;
  attendanceGrade: { raw: number; max: number; name: string } | null;
};

/**
 * Dự phòng khi không có MySQL Moodle (Vercel/sandbox): dùng Moodle REST với token hệ thống,
 * giống /api/dashboard/grades. Lấy cả sự kiện quá khứ + chi tiết log điểm danh của sinh viên.
 */
async function fetchMoodleRestProgress(
  userId: number,
  courseId: number,
  wantAttendance: boolean,
  wantHomework: boolean
): Promise<MoodleRestProgress | null> {
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  if (!MOODLE_URL || !MOODLE_TOKEN || !userId || !courseId) return null;
  if (!wantAttendance && !wantHomework) return null;

  const base = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
  const call = async <T>(fn: string, extra: Record<string, string>): Promise<T> => {
    const params = new URLSearchParams({
      wstoken: MOODLE_TOKEN,
      wsfunction: fn,
      moodlewsrestformat: 'json',
      ...extra,
    });
    const res = await fetch(`${base}?${params.toString()}`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Moodle ${fn}: ${res.status}`);
    const data = (await res.json()) as T & { exception?: string; message?: string };
    if (data?.exception) throw new Error(data.message || data.exception);
    return data;
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const calPromise = call<{
      events?: Array<{
        id?: number;
        name?: string;
        timestart?: number;
        modulename?: string;
        instance?: number;
      }>;
    }>('core_calendar_get_calendar_events', {
      'events[courseids][0]': String(courseId),
      timestart: String(nowSec - 180 * 86400),
      timeend: String(nowSec + 90 * 86400),
    });

  const gradePromise = wantAttendance
    ? call<{
      usergrades?: Array<{
        gradeitems?: Array<{
          itemname?: string;
          itemmodule?: string;
          graderaw?: number | null;
          grademax?: number;
        }>;
      }>;
    }>('gradereport_user_get_grade_items', {
      courseid: String(courseId),
      userid: String(userId),
    })
    : Promise.resolve(null);

  const [calRes, gradeRes] = await Promise.allSettled([calPromise, gradePromise]);

  const rawEvents = calRes.status === 'fulfilled' ? calRes.value.events || [] : [];
  const events: ProgressItem[] = [];
  for (const e of rawEvents) {
    const mod = (e.modulename || '').toLowerCase();
    if (!e.timestart || !['assign', 'quiz', 'attendance'].includes(mod)) continue;
    events.push({
      id: Number(e.id),
      title: e.name || 'Sự kiện chưa đặt tên',
      dueMs: e.timestart * 1000,
      completed: false,
      kind: mod === 'quiz' ? 'quiz' : mod === 'attendance' ? 'attendance' : 'assign',
    });
  }

  let attendanceGrade: MoodleRestProgress['attendanceGrade'] = null;
  if (gradeRes.status === 'fulfilled' && gradeRes.value) {
    for (const ug of gradeRes.value.usergrades || []) {
      for (const it of ug.gradeitems || []) {
        const name = (it.itemname || '').toLowerCase();
        const mod = (it.itemmodule || '').toLowerCase();
        if (mod.includes('attendance') || name.includes('attendance') || name.includes('điểm danh')) {
          attendanceGrade = {
            raw: Number(it.graderaw) || 0,
            max: Number(it.grademax) || 0,
            name: it.itemname || 'Điểm danh',
          };
        }
      }
    }
  }

  // Đối chiếu log điểm danh của RIÊNG sinh viên này (tối đa 15 buổi gần nhất).
  const attendanceSessions = events
    .filter((e) => e.kind === 'attendance' && e.dueMs <= nowSec * 1000)
    .slice(-15);
  let attendance: MoodleRestProgress['attendance'] = null;
  if (attendanceSessions.length > 0) {
    const details = await Promise.allSettled(
      attendanceSessions.map((e) =>
        call<{
          session?: {
            attendance_log?: Array<{ studentid?: number | string; statusid?: number | string }>;
            statuses?: Array<{ id?: number | string; grade?: number | string }>;
          };
        }>('mod_attendance_get_session', { sessionid: String(e.id) })
      )
    );
    let verified = 0;
    let attended = 0;
    for (const d of details) {
      if (d.status !== 'fulfilled' || !d.value?.session) continue;
      const session = d.value.session;
      verified += 1;
      const gradeById = new Map(
        (session.statuses || []).map((s) => [Number(s.id), Number(s.grade) || 0])
      );
      const log = (session.attendance_log || []).find((l) => Number(l.studentid) === userId);
      if (log && (gradeById.get(Number(log.statusid)) ?? 0) > 0) attended += 1;
    }
    if (verified > 0) attendance = { total: verified, attended };
  }

  if (events.length === 0 && !attendance && !attendanceGrade) return null;
  return { events, attendance, attendanceGrade };
}

/**
 * Trả về khối ngữ cảnh có cấu trúc để nhét thẳng vào System Prompt của Tutor.
 * Không bao giờ tạo ra số liệu: mọi giá trị đều lấy từ dữ liệu thực tế hoặc ghi rõ "Chưa có".
 */
export async function getStudentCourseProgressContext(
  params: StudentProgressContextParams
): Promise<string> {
  const { userId, courseId, courseName, gradebook = [] } = params;
  const wantExam = params.focus?.exam ?? true;
  const wantAttendance = params.focus?.attendance ?? true;
  const wantHomework = params.focus?.homework ?? true;
  const nowMs = Date.now();

  // 1. Điểm số (Moodle, do client truyền sang) + phân tích bài kiểm tra gần nhất (Firestore)
  const recentGrades = (Array.isArray(gradebook) ? gradebook : [])
    .map((item) => {
      const max = Number(item.maxScore) || 10;
      const score = Number(item.score) || 0;
      const pct = max > 0 ? Math.round((score / max) * 1000) / 10 : 0;
      return { item, pct };
    })
    .sort((a, b) => Number(b.item.gradedAt || 0) - Number(a.item.gradedAt || 0));

  const weakGrades = recentGrades.filter((g) => g.pct < 65);
  const latestGrade = recentGrades[0];
  const averagePct = recentGrades.length > 0
    ? Math.round((recentGrades.reduce((sum, g) => sum + g.pct, 0) / recentGrades.length) * 10) / 10
    : null;

  // 2. Chạy song song: DB Moodle (lịch sử thật) + Firestore + Supabase events (dự phòng)
  const [moodle, moodleRest, latestQuizAnalysis, supabaseEvents] = await Promise.all([
    courseId ? queryMoodleProgress(userId, courseId, wantAttendance, wantHomework) : Promise.resolve(null),
    courseId
      ? fetchMoodleRestProgress(userId, courseId, wantAttendance, wantHomework).catch(() => null)
      : Promise.resolve(null),
    courseId && wantExam
      ? getLatestQuizAnalysis({ userId, moodleCourseId: courseId }).catch(() => null)
      : Promise.resolve(null),
    (async () => {
      if (!courseId || !supabaseAdmin || (!wantAttendance && !wantHomework)) return [] as ProgressEvent[];
      try {
        const { data, error } = await supabaseAdmin
          .from('events')
          .select('moodle_event_id, title, event_type, deliver_time')
          .eq('moodle_course_id', courseId)
          .order('deliver_time', { ascending: true })
          .limit(100);
        if (!error && Array.isArray(data)) return data as ProgressEvent[];
        if (error) console.warn('[Student Progress] Supabase events note:', error.message);
      } catch (err) {
        console.warn('[Student Progress] Could not query Supabase events:', err);
      }
      return [] as ProgressEvent[];
    })(),
  ]);

  const hasGradeForTitle = (title: string): boolean => {
    const needle = (title || '').toLowerCase().trim();
    if (!needle) return false;
    return recentGrades.some(({ item }) => {
      const name = (item.name || '').toLowerCase().trim();
      return name === needle || name.includes(needle) || needle.includes(name);
    });
  };

  // 3. Lịch nộp bài / quiz: ưu tiên Moodle DB; nếu không có thì dùng events + đối chiếu nộp bài
  let assignments: ProgressItem[] = [];
  let quizzes: ProgressItem[] = [];
  let canVerifyAssignments = false;

  if (moodle) {
    assignments = moodle.assignments;
    quizzes = moodle.quizzes;
    canVerifyAssignments = true;
  } else if (moodleRest && moodleRest.events.length > 0) {
    assignments = moodleRest.events.filter((e) => e.kind === 'assign');
    quizzes = moodleRest.events.filter((e) => e.kind === 'quiz');
    canVerifyAssignments = false;
  } else if (supabaseEvents.length > 0 && userId > 0 && isMoodleDbAvailable()) {
    const eventIds = supabaseEvents
      .map((e) => Number(e.moodle_event_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    let completedIds = new Set<number>();
    try {
      completedIds = await getSubmittedEventIdsForUser(userId, eventIds);
      canVerifyAssignments = true;
    } catch (err) {
      console.warn('[Student Progress] Moodle completion lookup note:', err);
    }
    const toItem = (e: ProgressEvent): ProgressItem => {
      const parsed = Date.parse(String(e.deliver_time || ''));
      const type = (e.event_type || '').toLowerCase();
      return {
        id: Number(e.moodle_event_id),
        title: e.title || 'Bài tập chưa đặt tên',
        dueMs: Number.isNaN(parsed) ? 0 : parsed,
        completed: completedIds.has(Number(e.moodle_event_id)),
        kind: isQuizType(type) ? 'quiz' : isAttendanceType(type) ? 'attendance' : 'assign',
      };
    };
    assignments = supabaseEvents.filter((e) => isAssignmentType(e.event_type || '')).map(toItem);
    quizzes = supabaseEvents.filter((e) => isQuizType(e.event_type || '')).map(toItem);
  } else if (supabaseEvents.length > 0) {
    // Không đối chiếu được trạng thái cá nhân: chỉ báo lịch, không khẳng định quên nộp.
    const toItem = (e: ProgressEvent): ProgressItem => {
      const parsed = Date.parse(String(e.deliver_time || ''));
      const type = (e.event_type || '').toLowerCase();
      return {
        id: Number(e.moodle_event_id),
        title: e.title || 'Bài tập chưa đặt tên',
        dueMs: Number.isNaN(parsed) ? 0 : parsed,
        completed: false,
        kind: isQuizType(type) ? 'quiz' : isAttendanceType(type) ? 'attendance' : 'assign',
      };
    };
    assignments = supabaseEvents.filter((e) => isAssignmentType(e.event_type || '')).map(toItem);
    quizzes = supabaseEvents.filter((e) => isQuizType(e.event_type || '')).map(toItem);
  }

  const overdueAssigns = assignments.filter(
    (a) => a.dueMs > 0 && a.dueMs <= nowMs && !a.completed && !hasGradeForTitle(a.title)
  );
  const upcomingAssigns = assignments.filter((a) => a.dueMs > nowMs && !a.completed);
  const upcomingQuizzes = quizzes.filter((q) => q.dueMs > nowMs && !q.completed);

  // 4. Điểm danh: ưu tiên số liệu thật từ Moodle DB
  let attendanceLine = '';
  if (moodle?.attendance) {
    const { total, attended } = moodle.attendance;
    const absent = Math.max(0, total - attended);
    attendanceLine = `- Số buổi đã điểm danh có mặt: ${attended}/${total} buổi đã diễn ra (Vắng: ${absent} buổi).`;
    if (total > 0 && absent / total >= 0.15) {
      attendanceLine += '\n- ⚠️ CẢNH BÁO: Tỷ lệ vắng đang tiệm cận ngưỡng cấm thi (20% số tiết theo quy chế).';
    }
  } else if (moodleRest?.attendance) {
    const { total, attended } = moodleRest.attendance;
    const absent = Math.max(0, total - attended);
    attendanceLine = `- Số buổi đã điểm danh có mặt: ${attended}/${total} buổi đã diễn ra (Vắng: ${absent} buổi).`;
    if (total > 0 && absent / total >= 0.15) {
      attendanceLine += '\n- ⚠️ CẢNH BÁO: Tỷ lệ vắng đang tiệm cận ngưỡng cấm thi (20% số tiết theo quy chế).';
    }
  } else if (moodleRest?.attendanceGrade) {
    const g = moodleRest.attendanceGrade;
    const pct = g.max > 0 ? Math.round((g.raw / g.max) * 100) : null;
    attendanceLine = `- Điểm chuyên cần "${g.name}": ${g.raw}/${g.max}${pct !== null ? ` (${pct}%)` : ''}. Chưa đối chiếu được số buổi có mặt/vắng cụ thể, chỉ được báo điểm chuyên cần.`;
  } else {
    const pastAttendance = supabaseEvents.filter(
      (e) => isAttendanceType(e.event_type || '') && Date.parse(String(e.deliver_time || '')) <= nowMs
    );
    attendanceLine = pastAttendance.length === 0
      ? '- Chưa có buổi điểm danh nào đã diễn ra được ghi nhận cho môn này.'
      : `- Có ${pastAttendance.length} buổi điểm danh đã diễn ra, nhưng hệ thống chưa đối chiếu được trạng thái từng buổi của sinh viên. Chỉ được báo số buổi đã diễn ra, KHÔNG tự kết luận sinh viên vắng mặt.`;
  }

  // 5. Đóng gói thành văn bản có cấu trúc (AI chỉ được đọc số liệu từ đây)
  const gradeLines: string[] = [
    `- Điểm trung bình các đầu điểm đã có: ${averagePct !== null ? `${averagePct}%` : 'Chưa có dữ liệu điểm đồng bộ cho môn này.'}`,
  ];
  if (latestGrade) {
    gradeLines.push(
      `- Đầu điểm gần đây nhất: "${latestGrade.item.name}" — ${latestGrade.item.score}/${latestGrade.item.maxScore} (${latestGrade.pct}%), ngày ${fmtDate(latestGrade.item.gradedAt)}.`
    );
    const feedback = (latestGrade.item.feedback || '').trim();
    if (feedback) gradeLines.push(`- Nhận xét của giảng viên cho đầu điểm này: ${feedback}`);
  }
  if (weakGrades.length > 0) {
    gradeLines.push(
      `- ĐẦU ĐIỂM DƯỚI 65% (lỗ hổng cần củng cố): ${weakGrades
        .slice(0, 6)
        .map((g) => `"${g.item.name}" (${g.pct}%)${g.item.feedback ? ` — nhận xét: ${g.item.feedback}` : ''}`)
        .join('; ')}.`
    );
  } else if (recentGrades.length > 0) {
    gradeLines.push('- Không có đầu điểm nào dưới 65%.');
  }

  if (latestQuizAnalysis) {
    const weakTopics = (latestQuizAnalysis.weakTopics || []).filter(Boolean);
    gradeLines.push(
      `- Phân tích bài kiểm tra gần nhất "${latestQuizAnalysis.quizName || 'chưa rõ tên'}" (${latestQuizAnalysis.percentage || 'chưa rõ điểm'}): ${
        weakTopics.length > 0
          ? `chủ đề yếu: ${weakTopics.join(', ')}; sai ${latestQuizAnalysis.wrongCount ?? '?'} câu, sai một phần ${latestQuizAnalysis.partialCount ?? '?'} câu.`
          : latestQuizAnalysis.overview || 'Chưa có danh sách chủ đề yếu.'
      }`
    );
    if (latestQuizAnalysis.recommendations?.length) {
      gradeLines.push(`- Gợi ý ôn tập đã lưu: ${latestQuizAnalysis.recommendations.slice(0, 3).join('; ')}.`);
    }
  }

  const listItems = (items: ProgressItem[]): string =>
    items.length > 0
      ? items
          .slice(0, 8)
          .map((a) => `"${a.title}" (${fmtDate(a.dueMs)})`)
          .join('; ')
      : 'Không có.';

  const assignmentLines: string[] = [
    canVerifyAssignments
      ? `- ĐÃ QUÁ HẠN nhưng CHƯA NỘP (${overdueAssigns.length} bài): ${listItems(overdueAssigns)}`
      : `- ĐÃ QUÁ HẠN (${overdueAssigns.length} bài, chưa đối chiếu được trạng thái nộp — hãy nói "cần kiểm tra lại" thay vì khẳng định quên nộp): ${listItems(overdueAssigns)}`,
    `- SẮP TỚI HẠN (${upcomingAssigns.length} bài): ${listItems(upcomingAssigns)}`,
  ];
  if (upcomingQuizzes.length > 0) {
    assignmentLines.push(`- Bài kiểm tra sắp diễn ra (${upcomingQuizzes.length}): ${listItems(upcomingQuizzes)}`);
  }

  const sections: Array<{ title: string; body: string }> = [];
  if (wantExam) {
    sections.push({ title: 'KẾT QUẢ KIỂM TRA & LỖ HỔNG KIẾN THỨC', body: gradeLines.join('\n') });
  }
  if (wantAttendance) {
    sections.push({ title: 'TÌNH HÌNH ĐIỂM DANH', body: attendanceLine });
  }
  if (wantHomework) {
    sections.push({ title: 'BÀI TẬP VỀ NHÀ & HẠN NỘP', body: assignmentLines.join('\n') });
  }

  return `
=== DỮ LIỆU TIẾN ĐỘ HỌC TẬP THỰC TẾ CỦA SINH VIÊN (TẦNG 0 - student_progress) ===
Môn học: ${courseName || 'môn học hiện tại'} | Moodle User ID: ${userId || 'chưa rõ'}

${sections.map((s, idx) => `${idx + 1}. ${s.title}:\n${s.body}`).join('\n\n')}
===================================================
`.trim();
}
