import { NextResponse } from 'next/server';
import { runtimeEnv } from '@/db/runtime';
import { fetchWithCache } from '@/lib/server-cache';

interface MoodleEnrolledUser {
  id: number;
  username: string;
  fullname: string;
  email: string;
  idnumber?: string;
  profileimageurl?: string;
  roles?: Array<{ roleid: number; name: string; shortname: string }>;
}

export async function GET(request: Request) {
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  const url = new URL(request.url);
  const courseId = url.searchParams.get('courseId');

  const authorization = request.headers.get('authorization');
  const clientToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const serverToken = MOODLE_TOKEN && MOODLE_TOKEN !== 'your_moodle_wstoken_here' ? MOODLE_TOKEN : '';
  // Prefer the logged-in user's own Moodle token so per-course access is evaluated
  // as that user (e.g. a teacher opening a course they teach). The shared server
  // token is only a fallback for background/demo requests with no user session.
  const moodleToken = clientToken || serverToken;

  if (!courseId) {
    return NextResponse.json({ error: 'Thiếu tham số courseId.' }, { status: 400 });
  }

  if (!MOODLE_URL || !moodleToken) {
    // Return mock students for preview / demo when Moodle is not connected
    return NextResponse.json({
      mode: 'mock',
      accessible: true,
      students: [
        { id: 101, fullname: 'Bùi Xuân Huấn', username: 'huanhoahong', email: 'huanhoahong@example.com', idnumber: 'SV001' },
        { id: 102, fullname: 'Ngô Bá Khá', username: 'khabanh', email: 'khabanh@example.com', idnumber: 'SV002' },
        { id: 103, fullname: 'Nguyễn Văn Nam', username: 'namnv', email: 'namnv@example.com', idnumber: 'SV003' },
        { id: 104, fullname: 'Trần Thị Mai', username: 'maitt', email: 'maitt@example.com', idnumber: 'SV004' },
        { id: 105, fullname: 'Lê Hoàng Long', username: 'longlh', email: 'longlh@example.com', idnumber: 'SV005' },
      ],
      gradeItems: [
        { id: 1, name: 'Kiểm tra trắc nghiệm lần 1', itemtype: 'mod', itemmodule: 'quiz', iteminstance: 1, grademax: 10 },
        { id: 2, name: 'Bài tập thực hành tuần 2', itemtype: 'mod', itemmodule: 'assign', iteminstance: 2, grademax: 10 },
      ],
      initialScores: {},
      initialFeedbacks: {},
    });
  }

  const cacheKey = `teacher_students_${courseId}_${moodleToken.slice(0, 12)}`;
  const payload = await fetchWithCache(cacheKey, 60 * 1000, async () => {
    const base = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
    // Mutable so we can fall back to the shared server token if the user's token expired.
    let activeToken = moodleToken;
    const call = async <T>(fn: string, extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({
        wstoken: activeToken,
        wsfunction: fn,
        moodlewsrestformat: 'json',
        ...extra,
      });
      const response = await fetch(`${base}?${params}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Moodle status ${response.status}`);
      const data = (await response.json()) as T & { exception?: string; errorcode?: string; message?: string };
      if (data && typeof data === 'object' && ('exception' in data || 'errorcode' in data)) {
        const err = new Error(data.message ?? 'Moodle API error');
        if (data.errorcode === 'invalidtoken' || data.message?.toLowerCase().includes('token')) {
          (err as { code?: string }).code = 'INVALID_TOKEN';
        }
        throw err;
      }
      return data;
    };

    try {

    let site: { userid: number; fullname: string };
    try {
      site = await call<{ userid: number; fullname: string }>('core_webservice_get_site_info');
    } catch (firstErr) {
      const isTokenErr =
        (firstErr as { code?: string })?.code === 'INVALID_TOKEN' ||
        (firstErr instanceof Error && firstErr.message.toLowerCase().includes('token'));
      if (isTokenErr && serverToken && activeToken !== serverToken) {
        activeToken = serverToken;
        site = await call<{ userid: number; fullname: string }>('core_webservice_get_site_info');
      } else {
        throw firstErr;
      }
    }

    // 1. Fetch enrolled users in the course
    const enrolledUsers = await call<MoodleEnrolledUser[]>('core_enrol_get_enrolled_users', { courseid: courseId });

    let students: Array<{ id: number; fullname: string; username: string; email: string; idnumber?: string }> = [];
    if (Array.isArray(enrolledUsers)) {
      students = enrolledUsers
        .filter(u => {
          // Filter out site admin account (id 2) or users without student roles if populated
          if (u.id === 2 && enrolledUsers.length > 1) return false;
          if (!u.roles || u.roles.length === 0) return true;
          return u.roles.some(r => r.shortname === 'student' || r.shortname === 'user');
        })
        .map(u => ({
          id: u.id,
          fullname: u.fullname,
          username: u.username,
          email: u.email,
          idnumber: u.idnumber || '',
        }));

      if (students.length === 0 && enrolledUsers.length > 0) {
        students = enrolledUsers
          .filter(u => u.id !== 2 || enrolledUsers.length === 1)
          .map(u => ({
            id: u.id,
            fullname: u.fullname,
            username: u.username,
            email: u.email,
            idnumber: u.idnumber || '',
          }));
      }
    }

    const gradeItemsMap: Record<number, { id: number; name: string; itemtype: string; itemmodule: string; iteminstance: number; grademax: number }> = {};
    const initialScores: Record<number, Record<number, number | string>> = {};
    const initialFeedbacks: Record<number, Record<number, string>> = {};

    // 2. Fetch real Moodle grades for all enrolled students
    if (students.length > 0) {
      const studentGradesList = await Promise.allSettled(
        students.map(s =>
          call<{
            usergrades?: Array<{
              gradeitems: Array<{
                id: number;
                itemname: string | null;
                itemtype: string;
                itemmodule: string | null;
                iteminstance?: number | null;
                grademax?: number;
                graderaw?: number | null;
                feedback?: string;
              }>;
            }>;
          }>('gradereport_user_get_grade_items', {
            courseid: courseId,
            userid: String(s.id),
          })
        )
      );

      studentGradesList.forEach((res, idx) => {
        const student = students[idx];
        if (!student || res.status !== 'fulfilled' || !res.value?.usergrades?.[0]?.gradeitems) return;

        initialScores[student.id] = initialScores[student.id] || {};
        initialFeedbacks[student.id] = initialFeedbacks[student.id] || {};

        for (const item of res.value.usergrades[0].gradeitems) {
          const itemModule = (item.itemmodule || '').toLowerCase();
          const itemName = (item.itemname || '').toLowerCase();
          const itemType = (item.itemtype || '').toLowerCase();

          // Exclude course totals and attendance items from gradebook
          if (
            !item.itemname ||
            itemType === 'course' ||
            itemName.includes('course total') ||
            itemName.includes('tổng kết') ||
            itemModule === 'attendance' ||
            itemModule.includes('attendance') ||
            itemName.includes('attendance') ||
            itemType === 'attendance' ||
            itemName.includes('điểm danh') ||
            itemName.includes('chuyên cần')
          ) {
            continue;
          }

          if (!gradeItemsMap[item.id]) {
            gradeItemsMap[item.id] = {
              id: item.id,
              name: item.itemname,
              itemtype: item.itemtype || 'mod',
              itemmodule: item.itemmodule || '',
              iteminstance: item.iteminstance || 0,
              grademax: Number(item.grademax ?? 10),
            };
          }

          if (item.graderaw !== null && item.graderaw !== undefined) {
            initialScores[student.id][item.id] = Number(item.graderaw);
          }

          if (item.feedback) {
            const cleanFb = item.feedback.replace(/<[^>]*>/g, '').trim();
            if (cleanFb) {
              initialFeedbacks[student.id][item.id] = cleanFb;
            }
          }
        }
      });
    }

    const gradeItems = Object.values(gradeItemsMap);

    return {
      mode: 'live',
      accessible: true,
      students,
      gradeItems,
      initialScores,
      initialFeedbacks,
    };
  } catch (error) {
    console.warn('Could not fetch students from Moodle live:', error);
    const errText = error instanceof Error ? error.message : String(error);
    const isPermissionError =
      errText.includes('bối cảnh khóa học') ||
      errText.includes('không thể thực thi các hàm trong bối cảnh') ||
      errText.includes('không truy cập được') ||
      errText.includes('requireloginerror') ||
      errText.includes('course id:10') ||
      errText.includes('course id:') ||
      errText.toLowerCase().includes('permission') ||
      errText.toLowerCase().includes('access denied');

    if (isPermissionError) {
      return {
        mode: 'permission_denied',
        accessible: false,
        students: [],
        gradeItems: [],
        initialScores: {},
        initialFeedbacks: {},
        warning: `Bạn không có quyền truy cập khóa học này trên Moodle (Course ID: ${courseId}). Khóa học có thể đang bị ẩn hoặc tài khoản của bạn chưa được cấp quyền Giảng viên.`,
      };
    }

    // Graceful fallback with sample students for offline / network issues
    return {
      mode: 'fallback',
      accessible: true,
      students: [
        { id: 101, fullname: 'Bùi Xuân Huấn', username: 'huanhoahong', email: 'huanhoahong@example.com', idnumber: 'SV001' },
        { id: 102, fullname: 'Ngô Bá Khá', username: 'khabanh', email: 'khabanh@example.com', idnumber: 'SV002' },
        { id: 103, fullname: 'Nguyễn Văn Nam', username: 'namnv', email: 'namnv@example.com', idnumber: 'SV003' },
        { id: 104, fullname: 'Trần Thị Mai', username: 'maitt', email: 'maitt@example.com', idnumber: 'SV004' },
        { id: 105, fullname: 'Lê Hoàng Long', username: 'longlh', email: 'longlh@example.com', idnumber: 'SV005' },
      ],
      gradeItems: [
        { id: 1, name: 'Kiểm tra trắc nghiệm lần 1', itemtype: 'mod', itemmodule: 'quiz', iteminstance: 1, grademax: 10 },
        { id: 2, name: 'Bài tập thực hành tuần 2', itemtype: 'mod', itemmodule: 'assign', iteminstance: 2, grademax: 10 },
      ],
      initialScores: {},
      initialFeedbacks: {},
      warning: error instanceof Error ? error.message : 'Không thể kết nối Moodle live.',
    };
  }
  });

  return NextResponse.json(payload);
}

