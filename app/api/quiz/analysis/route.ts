import { NextResponse } from 'next/server';
import { runtimeEnv } from '@/db/runtime';
import { generateText } from '@/models/registry';
import { parseMoodleQuestion, ParsedMoodleQuestion, cleanAnswerText } from '@/lib/moodle-quiz-parser';
import { getLearningArtifacts, getQuizAnalysisByAttempt, saveLearningArtifact } from '@/lib/learning-artifacts';
import { getPersonalMaterials } from '@/lib/firebase-data';
import type { QuizAnalysisData } from '@/app/types';

function sanitizeQuestionsAnalysis(questions: any[]) {
  if (!Array.isArray(questions)) return [];
  return questions.map(q => ({
    ...q,
    studentAnswer: cleanAnswerText(q.studentAnswer),
    rightAnswer: cleanAnswerText(q.rightAnswer),
    explanation: q.explanation || q.feedback || '',
  }));
}

function sanitizeAnalysis(data: any): any {
  if (!data) return data;
  return {
    ...data,
    questionsAnalysis: sanitizeQuestionsAnalysis(data.questionsAnalysis),
  };
}

function parseModelJson(text: string): Record<string, unknown> | null {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(normalized.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const courseIdParam = searchParams.get('courseId');
    const userIdParam = searchParams.get('userId');
    const attemptIdParam = searchParams.get('attemptId');

    const courseId = courseIdParam ? Number(courseIdParam) : undefined;
    const userId = userIdParam ? Number(userIdParam) : undefined;

    if (attemptIdParam) {
      const targetAttemptId = Number(attemptIdParam);
      const matched = await getQuizAnalysisByAttempt(targetAttemptId, courseId);
      if (matched) {
        return NextResponse.json({ analysis: { ...sanitizeAnalysis(matched), cached: true }, cached: true });
      }
    }

    const artifacts = await getLearningArtifacts({
      moodleCourseId: courseId,
      userId,
      artifactType: 'quiz_analysis',
      limit: 30,
    });

    const analyses = artifacts
      .map((item: any) => {
        const content = item.content_data || item.contentData;
        if (!content) return null;
        return sanitizeAnalysis({
          ...content,
          id: item.id,
          createdAt: item.created_at || item.createdAt,
          cached: true,
        });
      })
      .filter(Boolean);

    if (attemptIdParam) {
      const targetAttemptId = Number(attemptIdParam);
      const matched = analyses.find((a: any) => Number(a.attemptId) === targetAttemptId);
      return NextResponse.json({ analysis: matched || null, cached: !!matched });
    }

    return NextResponse.json({ analyses });
  } catch (error) {
    console.error('Error fetching quiz analysis artifacts:', error);
    return NextResponse.json({ error: 'Không thể tải lịch sử phân tích bài thi.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      attemptId: number;
      courseId?: number;
      courseCode?: string;
      courseName?: string;
      quizName?: string;
      userId?: number;
      userName?: string;
      model?: string;
      forceReanalyze?: boolean;
      feedback?: string | null;
      has_details?: boolean;
      has_feedback?: boolean;
    };

    const attemptId = Number(body.attemptId);
    if (!attemptId || isNaN(attemptId)) {
      return NextResponse.json({ error: 'Thiếu mã lượt thi (attemptId) hợp lệ.' }, { status: 400 });
    }

    // Cache-First: Check if already analyzed to save AI tokens & credits
    const forceReanalyze = body.forceReanalyze === true;
    if (!forceReanalyze) {
      const existing = await getQuizAnalysisByAttempt(attemptId, body.courseId);
      if (existing) {
        console.log(`[QuizAnalysis] Found existing analysis for attempt ${attemptId}. Returning cached artifact without calling LLM.`);
        return NextResponse.json({
          analysis: {
            ...sanitizeAnalysis(existing),
            cached: true,
          },
          cached: true,
          message: 'Đã tải bản chẩn đoán đã lưu từ trước (không tiêu hao AI credit).'
        });
      }
    }

    const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
    const authorization = request.headers.get('authorization');
    const clientToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const moodleToken = clientToken || MOODLE_TOKEN;

    if (!MOODLE_URL || !moodleToken) {
      return NextResponse.json(
        { error: 'Moodle URL hoặc Access Token chưa được cấu hình.' },
        { status: 500 }
      );
    }

    // 1. Fetch attempt review from Moodle Web Services API
    const base = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
    const params = new URLSearchParams({
      wstoken: moodleToken,
      wsfunction: 'mod_quiz_get_attempt_review',
      moodlewsrestformat: 'json',
      attemptid: String(attemptId),
      page: '-1', // fetch all pages
    });

    const mRes = await fetch(`${base}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });

    if (!mRes.ok) {
      throw new Error(`Moodle API responded with status ${mRes.status}`);
    }

    const mData = (await mRes.json()) as {
      grade?: number | string;
      attempt?: {
        id: number;
        quiz: number;
        userid: number;
        sumgrades?: number;
        state?: string;
      };
      questions?: Array<{
        slot: number;
        type?: string;
        state?: string;
        status?: string;
        mark?: string;
        maxmark?: number;
        html?: string;
      }>;
      exception?: string;
      message?: string;
    };

    if (mData.exception) {
      throw new Error(mData.message || 'Lỗi khi gọi Moodle mod_quiz_get_attempt_review');
    }

    const allQuestions = mData.questions || [];
    const attemptInfo = mData.attempt || { id: attemptId, quiz: 0, userid: body.userId || 4 };
    const rawGrade = Number(mData.grade ?? attemptInfo.sumgrades ?? 0);
    const roundedGrade = Math.round(rawGrade * 10) / 10;

    // 2. Filter questions with mistakes: gradedwrong or gradedpartial
    const mistakeQuestions = allQuestions.filter(
      q => q.state === 'gradedwrong' || q.state === 'gradedpartial'
    );
    const parsedMistakes: ParsedMoodleQuestion[] = mistakeQuestions.map(q => parseMoodleQuestion(q));

    const totalQuestions = allQuestions.length;
    const wrongCount = allQuestions.filter(q => q.state === 'gradedwrong').length;
    const partialCount = allQuestions.filter(q => q.state === 'gradedpartial').length;
    const percentage = totalQuestions > 0 ? `${Math.round((roundedGrade / 10) * 100)}%` : '0%';

    // 3. Gather Course Documents Context for Adaptive Guidance
    let docContext = '';
    const numericCourseId = body.courseId ? Number(body.courseId) : undefined;
    if (numericCourseId) {
      try {
        const mats = await getPersonalMaterials({ moodleCourseId: numericCourseId, limit: 4 });
        if (mats && mats.length > 0) {
          docContext = mats.map(m => `[Tài liệu: ${m.title}]`).join('\n');
        }
      } catch (firebaseError) {
        console.warn('Firebase course docs warning for quiz analysis:', firebaseError);
      }
    }

    // 4. Stuff context & construct pedagogical AI prompt
    const mistakesSummary = parsedMistakes
      .map(
        m => `[Câu ${m.slot} (${m.status} - Điểm: ${m.mark}/${m.maxmark})]
- Câu hỏi: ${m.questionText}
- Sinh viên chọn: ${m.studentAnswer}
- Đáp án đúng: ${m.rightAnswer}
${m.explanation || m.feedback ? `- Lời giải / Giải thích từ đề thi: ${m.explanation || m.feedback}` : '- Lời giải từ đề: Chưa có'}`
      )
      .join('\n\n');

    const rawFeedback = (body.feedback || '').trim();
    const hasFeedback = Boolean(rawFeedback && rawFeedback !== '-' && rawFeedback !== 'Chưa có nhận xét');

    const strategyInstruction = hasFeedback
      ? `CHIẾN LƯỢC ĐỊNH TUYẾN NGỮ CẢNH: KẾT HỢP NHẬN XÉT GIẢNG VIÊN (FULL INSIGHT)
- Lời phê chính thức của Giảng viên: "${rawFeedback}".
- Hãy dùng lời phê này làm "kim chỉ nam" mục tiêu.
- Kết hợp bóc tách chi tiết từng câu làm sai làm minh chứng thực tế để vạch lộ trình khắc phục chính xác nhất.`
      : `CHIẾN LƯỢC ĐỊNH TUYẾN NGỮ CẢNH: PHÂN TÍCH THEO DỮ LIỆU ĐỀ THI
- Bài thi không có lời phê riêng từ giảng viên.
- Tự động phân nhóm các câu chọn sai, đối chiếu với tài liệu gốc môn học để tự tìm ra các lỗ hổng khái niệm cốt lõi.`;

    const prompt = `Bạn là Chuyên gia Khảo thí và Cố vấn Học tập Thích ứng (Adaptive Learning Tutor).
Dưới đây là kết quả một bài kiểm tra trắc nghiệm của sinh viên trên Moodle:

THÔNG TIN BÀI THI:
- Môn học: ${body.courseName || 'Khóa học'} (${body.courseCode || ''})
- Tên bài kiểm tra: ${body.quizName || 'Bài kiểm tra trắc nghiệm'}
- Điểm đạt được: ${roundedGrade}/10 (${percentage})
- Tổng số câu: ${totalQuestions} câu
- Số câu sai hoàn toàn: ${wrongCount} câu
- Số câu đúng một phần: ${partialCount} câu

${strategyInstruction}

${docContext ? `TÀI LIỆU THAM KHẢO CỦA MÔN HỌC:\n${docContext}\n\n` : ''}
DANH SÁCH CÁC CÂU HỎI SINH VIÊN BỊ TRỪ ĐIỂM (CÂU SAI & ĐÚNG MỘT PHẦN):
${mistakesSummary || 'Học sinh làm đúng 100% tất cả các câu hỏi.'}

YÊU CẦU PHÂN TÍCH:
1. Đưa ra "overview": Đánh giá tổng quan điểm mạnh và điểm yếu cốt lõi của sinh viên qua bài thi này với giọng văn tích cực, sư phạm và mang tính định hướng.
2. Trích xuất "weakTopics": Mảng các chuỗi ngắn (2-5 từ) nêu tên chính xác các khái niệm/chủ đề sinh viên đang hổng (ví dụ: ["Virtual DOM", "SvelteKit SSR", "Node.js Template Engines"]). Đây sẽ là đầu vào để hệ thống tạo đề thi bù đắp lỗ hổng.
3. Đưa ra "recommendations": Mảng các hành động cụ thể sinh viên cần thực hiện ngay (ví dụ: các chương tài liệu cần đọc lại, bài tập cần làm).
4. Phân tích chi tiết từng câu trong "questionsAnalysis":
   - "slot": số thứ tự câu hỏi
   - "diagnosedReason": Phân tích ngắn gọn tại sao sinh viên lại chọn sai (ngộ nhận khái niệm, nhầm lẫn giữa các nội dung, hay chọn thiếu phương án) và lời khuyên khắc phục cốt lõi. NẾU CÂU HỎI ĐÃ CÓ "Lời giải / Giải thích từ đề thi", HÃY BÁM SÁT VÀO ĐÓ ĐỂ CHỈ RÕ ĐIỂM MÙ TƯ DUY, TUYỆT ĐỐI KHÔNG SUY ĐOÁN LAN MAN NGOÀI LỀ.

ĐỊNH DẠNG TRẢ VỀ:
Bắt buộc trả về đúng duy nhất 1 JSON object theo cấu trúc:
{
  "overview": "Nhận xét tổng quan và phân tích năng lực hiện tại...",
  "weakTopics": ["Chủ đề yếu 1", "Chủ đề yếu 2"],
  "recommendations": ["Hành động 1", "Hành động 2"],
  "questionsAnalysis": [
    {
      "slot": 1,
      "diagnosedReason": "Phân tích nguyên nhân chọn nhầm và giải thích bản chất..."
    }
  ]
}
Không kèm markdown hay văn bản ngoài JSON.`;

    // 5. Call AI Unified Registry
    let aiResponse = {
      overview: `Bạn đã hoàn thành bài thi với điểm số ${roundedGrade}/10. Hãy xem lại các câu sai để củng cố kiến thức trước bài kiểm tra tiếp theo.`,
      weakTopics: [] as string[],
      recommendations: ['Đọc lại các chương liên quan đến câu hỏi đã trả lời sai.'],
      questionsAnalysis: [] as Array<{ slot: number; diagnosedReason: string }>,
    };

    try {
      const aiResult = await generateText(body.model, {
        system:
          'Bạn là Cố vấn Học tập Thích ứng chuyên sâu về CNTT và sư phạm đại học. Luôn phân tích chính xác nguyên nhân sai sót và đề xuất giải pháp trọng tâm bằng CHÍNH XÁC ngôn ngữ của bài thi/câu hỏi (Tiếng Việt luôn là ngôn ngữ mặc định nếu bài thi bằng tiếng Việt). Trả về đúng JSON schema.',
        userPrompt: prompt,
        temperature: 0.2,
        jsonMode: true,
        taskCategory: 'complex',
        signal: request.signal,
      });

      if (aiResult.text) {
        const parsed = parseModelJson(aiResult.text);
        if (parsed) {
          aiResponse = {
            overview: typeof parsed.overview === 'string' ? parsed.overview : aiResponse.overview,
            weakTopics: Array.isArray(parsed.weakTopics) ? parsed.weakTopics.filter((item): item is string => typeof item === 'string') : [],
            recommendations: Array.isArray(parsed.recommendations)
              ? parsed.recommendations.filter((item): item is string => typeof item === 'string')
              : aiResponse.recommendations,
            questionsAnalysis: Array.isArray(parsed.questionsAnalysis) ? parsed.questionsAnalysis as Array<{ slot: number; diagnosedReason: string }> : [],
          };
        } else {
          console.warn('AI Quiz Diagnosis returned non-JSON content; using fallback analysis.');
        }
      }
    } catch (aiErr) {
      console.warn('AI Quiz Diagnosis error:', aiErr);
    }

    // Default weak topics fallback if AI was empty
    if (aiResponse.weakTopics.length === 0 && parsedMistakes.length > 0) {
      aiResponse.weakTopics = parsedMistakes.slice(0, 3).map(m => {
        const firstWords = m.questionText.split('?')[0].slice(0, 30);
        return firstWords || `Câu hỏi ${m.slot}`;
      });
    }

    // 6. Assemble complete QuizAnalysisData
    const analysisData: QuizAnalysisData = {
      attemptId,
      quizId: attemptInfo.quiz,
      quizName: body.quizName || `Kiểm tra trắc nghiệm #${attemptInfo.quiz || attemptId}`,
      courseId: Number(body.courseId || 0),
      courseName: body.courseName || 'Khóa học',
      score: roundedGrade,
      maxScore: 10,
      percentage,
      totalQuestions,
      wrongCount,
      partialCount,
      weakTopics: aiResponse.weakTopics,
      recommendations: aiResponse.recommendations,
      overview: aiResponse.overview,
      questionsAnalysis: parsedMistakes.map(m => {
        const aiDiag = aiResponse.questionsAnalysis.find(a => a.slot === m.slot);
        const explanation = m.explanation || m.feedback || '';
        return {
          slot: m.slot,
          questionText: m.questionText,
          studentAnswer: cleanAnswerText(m.studentAnswer),
          rightAnswer: cleanAnswerText(m.rightAnswer),
          status: m.status,
          mark: m.mark ? String(Math.round(parseFloat(m.mark) * 10) / 10) : m.mark,
          maxmark: m.maxmark !== undefined ? Math.round(m.maxmark * 10) / 10 : m.maxmark,
          feedback: explanation,
          explanation: explanation,
          diagnosedReason: aiDiag?.diagnosedReason || explanation || '',
        };
      }),
      analyzedAt: new Date().toISOString(),
    };

    const targetCourseId = Number(body.courseId || 0);
    const savedArtifact = await saveLearningArtifact({
      userId: body.userId || attemptInfo.userid || 4,
      userName: body.userName,
      moodleCourseId: targetCourseId,
      artifactType: 'quiz_analysis',
      contentData: {
        name: `Chẩn đoán bài kiểm tra: ${analysisData.quizName}`,
        ...analysisData,
      },
    });

    if (savedArtifact?.id) {
      analysisData.id = String(savedArtifact.id);
    }

    return NextResponse.json({
      success: true,
      analysis: analysisData,
    });
  } catch (error) {
    console.error('Error in /api/quiz/analysis:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Có lỗi khi phân tích kết quả bài thi.' },
      { status: 500 }
    );
  }
}

