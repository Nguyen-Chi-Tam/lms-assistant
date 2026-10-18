import { NextResponse } from 'next/server';
import { runtimeEnv } from '@/db/runtime';
import { saveStudentFeedback } from '@/lib/feedback-store';

interface StudentGradeInput {
  studentId: number;
  score: number;
  feedback?: string;
}

export async function POST(request: Request) {
  try {
    const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
    const authorization = request.headers.get('authorization');
    const clientToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const serverToken = MOODLE_TOKEN && MOODLE_TOKEN !== 'your_moodle_wstoken_here' ? MOODLE_TOKEN : '';
    // Prefer the logged-in teacher's token so grade writes are attributed to the
    // course teacher (and checked against their capabilities), not the shared
    // server/service account. Fall back to the server token when no session exists.
    const moodleToken = clientToken || serverToken;

    const body = (await request.json()) as {
      courseId: number | string;
      component?: string;
      activityId?: number;
      itemNumber?: number;
      grades: StudentGradeInput[];
    };

    if (!body.courseId || !Array.isArray(body.grades) || body.grades.length === 0) {
      return NextResponse.json({ error: 'Dữ liệu cập nhật điểm không đầy đủ.' }, { status: 400 });
    }

    // Persist feedbacks to local store for student retrieval
    body.grades.forEach(g => {
      if (g.feedback) {
        saveStudentFeedback({
          studentId: g.studentId,
          courseId: body.courseId,
          score: g.score,
          feedback: g.feedback,
          updatedAt: Date.now(),
        });
      }
    });

    // Demo/Simulated mode if Moodle URL or token is not set
    if (!MOODLE_URL || !moodleToken || moodleToken === 'your_moodle_wstoken_here') {
      return NextResponse.json({
        success: true,
        mode: 'demo',
        updatedCount: body.grades.length,
        message: `[Mô phỏng thành công] Đã lưu ${body.grades.length} điểm và nhận xét sinh viên vào cột điểm Moodle.`,
        grades: body.grades,
      });
    }

    const moodleBaseUrl = MOODLE_URL.replace(/\/$/, '');

    // 1. Try Direct Moodle Bridge (supports manual grade items, quizzes, and feedbacks)
    try {
      const bridgeUrl = `${moodleBaseUrl}/webservice/lms_grade_update.php`;
      const bridgeRes = await fetch(bridgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          wstoken: moodleToken,
          courseId: body.courseId,
          itemId: body.itemNumber ?? body.activityId ?? 0,
          grades: body.grades,
        }),
      });

      if (bridgeRes.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bridgeData = (await bridgeRes.json()) as any;
        if (bridgeData && bridgeData.success) {
          console.log('✅ [LMS Grade Bridge] Updated grades directly in Moodle:', bridgeData);
          return NextResponse.json({
            success: true,
            mode: 'live',
            updatedCount: bridgeData.updatedCount ?? body.grades.length,
            message: `🎉 TUYỆT VỜI! Đã cập nhật thành công ${body.grades.length} điểm và nhận xét vào Moodle Grader report!`,
            moodleResponse: bridgeData,
          });
        }
      }
    } catch (bridgeErr) {
      console.warn('Bridge call skipped, attempting standard REST API:', bridgeErr);
    }

    // 2. Standard Moodle REST API fallback (core_grades_update_grades)
    const base = `${moodleBaseUrl}/webservice/rest/server.php`;
    const component = body.component || 'moodle';
    const activityId = body.activityId ?? 0;
    const itemNumber = body.itemNumber ?? 0;
    const source = component === 'moodle' ? 'manual' : 'lms-assistant';

    const formData = new URLSearchParams();
    formData.append('wstoken', moodleToken);
    formData.append('wsfunction', 'core_grades_update_grades');
    formData.append('moodlewsrestformat', 'json');
    formData.append('source', source);
    formData.append('courseid', String(body.courseId));
    formData.append('component', component);
    formData.append('activityid', String(activityId));
    formData.append('itemnumber', String(itemNumber));

    body.grades.forEach((g, idx) => {
      formData.append(`grades[${idx}][studentid]`, String(g.studentId));
      formData.append(`grades[${idx}][grade]`, String(g.score));
      if (g.feedback) {
        formData.append(`grades[${idx}][str_feedback]`, g.feedback);
      }
    });

    console.log('============================================================');
    console.log('📤 [Moodle REST API] Calling core_grades_update_grades:');
    console.log('Target URL:', base);
    console.log('Parameters:', {
      wsfunction: 'core_grades_update_grades',
      courseid: body.courseId,
      component,
      activityid: activityId,
      itemnumber: itemNumber,
      source,
      studentCount: body.grades.length,
    });
    console.log('Grades payload:', body.grades);
    console.log('============================================================');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let moodleData: any = null;

    try {
      const response = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: formData.toString(),
      });

      if (!response.ok) {
        console.error('❌ [Moodle REST API] HTTP Error:', response.status, response.statusText);
        return NextResponse.json(
          {
            success: false,
            error: `Lỗi kết nối Moodle (HTTP ${response.status} ${response.statusText})`,
          },
          { status: 502 }
        );
      }

      moodleData = await response.json();
      console.log('📥 [Moodle REST API] Raw Response:', moodleData);

      if (moodleData && typeof moodleData === 'object' && (moodleData.exception || moodleData.errorcode)) {
        console.warn('⚠️ [Moodle REST API] Moodle rejected with exception:', moodleData);
        return NextResponse.json(
          {
            success: false,
            error: `Moodle từ chối: ${moodleData.message || moodleData.exception} (${moodleData.errorcode || 'accessexception'})`,
            moodleRaw: moodleData,
          },
          { status: 403 }
        );
      }

      console.log('✅ [Moodle REST API] Grades successfully written to Moodle database!');
      return NextResponse.json({
        success: true,
        mode: 'live',
        updatedCount: body.grades.length,
        message: `Đã cập nhật thành công ${body.grades.length} điểm vào bảng điểm Moodle!`,
        moodleResponse: moodleData,
      });
    } catch (netErr) {
      console.error('❌ [Moodle REST API] Network call failed:', netErr);
      return NextResponse.json(
        {
          success: false,
          error: `Không thể kết nối đến máy chủ Moodle: ${netErr instanceof Error ? netErr.message : 'Network error'}`,
        },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('Grades update route error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi hệ thống khi cập nhật điểm.' },
      { status: 500 }
    );
  }
}
