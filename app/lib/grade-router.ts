import type { ExamResult, QuizAnalysisData } from '@/app/types';
import { getStoredAnalysis } from '@/app/lib/quiz-client-cache';
import { cleanAnswerText } from '@/lib/moodle-quiz-parser';

export { cleanAnswerText };

export type GradeContextMode =
  | 'full_insight'       // has_details: true, has_feedback: true (Chi tiết + Nhận xét)
  | 'tech_analysis'      // has_details: true, has_feedback: false (Chi tiết câu hỏi)
  | 'amplification'      // has_details: false, has_feedback: true (Nhận xét giảng viên)
  | 'interviewer_blind'; // has_details: false, has_feedback: false (Điểm số tổng quan)

export type GradeResponseStrategy =
  | 'roadmap'      // 📋 Lộ trình ôn tập & Hành động cụ thể
  | 'deep_dive'    // 🔍 Giải thích chuyên sâu bản chất lý thuyết
  | 'socratic'     // 💬 Gia sư gợi mở (Hỏi đáp tương tác)
  | 'practice';    // 🎯 Thử thách & Bài tập vận dụng tương tự

export interface StrategyOption {
  id: GradeResponseStrategy;
  label: string;
  iconName: string;
  badge: string;
  description: string;
}

export const GRADE_RESPONSE_STRATEGIES: StrategyOption[] = [
  {
    id: 'roadmap',
    label: 'Lộ trình ôn tập',
    iconName: 'ListChecks',
    badge: 'Kế hoạch',
    description: 'Vạch ra các bước hành động cụ thể, chương mục tài liệu cần đọc và checklist nâng cao điểm.',
  },
  {
    id: 'deep_dive',
    label: 'Giải thích chi tiết',
    iconName: 'BookOpen',
    badge: 'Bản chất',
    description: 'Phân tích kỹ lưỡng bản chất lý thuyết, làm rõ nguyên lý và các khái niệm cốt lõi dễ gây hiểu nhầm.',
  },
  {
    id: 'socratic',
    label: 'Gia sư gợi mở',
    iconName: 'HelpCircle',
    badge: 'Tương tác',
    description: 'Đóng vai gia sư hỏi đáp từng bước, đặt câu hỏi gợi mở để tôi tự nhận ra chỗ bị kẹt.',
  },
  {
    id: 'practice',
    label: 'Bài tập vận dụng',
    iconName: 'Sparkles',
    badge: 'Thực hành',
    description: 'Đưa ra 2–3 bài tập hoặc câu hỏi tình huống tương tự (từ cơ bản đến nâng cao) để tôi luyện tập ngay.',
  },
];

export interface GradeRouteInfo {
  hasDetails: boolean;
  hasFeedback: boolean;
  mode: GradeContextMode;
  modeName: string;
  defaultStrategy: GradeResponseStrategy;
  actionType: 'modal' | 'chat';
  buttonLabel: string;
  buttonTooltip: string;
  badgeText?: string;
  badgeColor?: string;
  buttonGradient?: string;
  borderColor?: string;
  prompt: string;
}

/**
 * Rounds a grade/score to at most one decimal place (e.g. 6.16667 -> 6.2, 0.67 -> 0.7, 10 -> 10).
 */
export function formatGrade(score: number | string | undefined | null): string {
  if (score === null || score === undefined || score === '') return '0';
  const num = typeof score === 'number' ? score : parseFloat(String(score));
  if (isNaN(num)) return String(score);
  return String(Math.round(num * 10) / 10);
}

/**
 * Builds a tailored academic prompt for AI Tutor according to selected response strategy,
 * detail level, and actual quiz mistakes if available.
 */
export function buildGradePrompt(
  res: ExamResult,
  strategy?: GradeResponseStrategy | GradeResponseStrategy[],
  detailLevel: 'concise' | 'detailed' = 'detailed',
  analysis?: QuizAnalysisData | null
): string {
  const rawFeedback = (res.feedback || '').trim();
  const hasFeedback = Boolean(
    rawFeedback &&
    rawFeedback !== '-' &&
    rawFeedback !== 'Chưa có nhận xét' &&
    rawFeedback.toLowerCase() !== 'none'
  );

  const scoreNum = Number(res.score) || 0;
  const maxScore = Number(res.maxScore) || 10;
  const ratio = maxScore > 0 ? scoreNum / maxScore : 0;
  const percentageStr = res.percentage || `${Math.round(ratio * 100)}%`;
  const isHighScore = ratio >= 0.7;

  // Retrieve cached analysis if not explicitly provided
  const effectiveAnalysis =
    analysis || (res.attemptId ? getStoredAnalysis(res.attemptId) : null);

  const weakTopics = effectiveAnalysis?.weakTopics || [];
  const weakTopicsStr = weakTopics.join(', ');

  const wrongOrPartialQuestions = (effectiveAnalysis?.questionsAnalysis || []).filter(
    q =>
      q.status === 'Incorrect' ||
      q.status === 'Partially correct' ||
      (q.mark && q.maxmark && parseFloat(q.mark) < q.maxmark)
  );

  const hasMistakes = weakTopics.length > 0 || wrongOrPartialQuestions.length > 0;

  // Normalize strategies to an array
  const rawStrategies = Array.isArray(strategy)
    ? strategy
    : strategy
    ? [strategy]
    : [];

  const defaultSingle: GradeResponseStrategy = hasFeedback
    ? 'roadmap'
    : isHighScore
    ? 'practice'
    : 'socratic';

  const effectiveStrategies: GradeResponseStrategy[] =
    rawStrategies.length > 0 ? rawStrategies : [defaultSingle];

  // Context Header
  let intro = `Chào Gia sư AI! Tôi vừa hoàn thành bài kiểm tra "${res.name}" môn ${res.courseName}: đạt ${formatGrade(res.score)}/${formatGrade(res.maxScore)}đ.`;
  if (hasFeedback) {
    intro += `\nLời phê của giảng viên: "${rawFeedback}".`;
  }

  // Inject real mistake data if available
  if (hasMistakes) {
    intro += `\n\nTHỰC TRẠNG BÀI THI & CÁC LỖI SAI CỤ THỂ ĐÃ ĐƯỢC HỆ THỐNG GHI NHẬN:`;
    if (weakTopics.length > 0) {
      intro += `\n- Các chủ đề cốt lõi tôi bị ngộ nhận / mất điểm: ${weakTopicsStr}.`;
    }
    if (wrongOrPartialQuestions.length > 0) {
      intro += `\n- Chi tiết các câu hỏi tôi bị trừ điểm cụ thể:`;
      wrongOrPartialQuestions.slice(0, 5).forEach((q, idx) => {
        const cleanText = q.questionText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const cleanStudent = cleanAnswerText(q.studentAnswer);
        const cleanRight = cleanAnswerText(q.rightAnswer);
        intro += `\n  ${idx + 1}) [Câu hỏi]: "${cleanText}"\n     • Lựa chọn của tôi: ${cleanStudent || 'Chưa chọn'}\n     • Đáp án đúng: ${cleanRight || 'Chưa rõ'}`;
        if (q.diagnosedReason) {
          intro += `\n     • Chẩn đoán sai sót: ${q.diagnosedReason}`;
        }
      });
    }
  } else if (!res.attemptId) {
    intro += `\n(Lưu ý: Hệ thống LMS không có chi tiết từng câu trắc nghiệm của bài kiểm tra này).`;
  }

  // Sub-instructions per strategy
  const getStrategyInstruction = (st: GradeResponseStrategy): { title: string; body: string } => {
    switch (st) {
      case 'roadmap':
        return {
          title: '📋 Lộ trình ôn tập & Checklist hành động',
          body: hasMistakes
            ? `1. Phân tích nguyên nhân cốt lõi khiến tôi bị mất điểm ở các câu hỏi và chủ đề trên (${weakTopicsStr || 'đã nêu ở trên'}).\n2. Dựa vào giáo trình môn ${res.courseName}, chỉ rõ chính xác các chương mục và khái niệm tôi cần đọc lại để khắc phục các lỗi sai này.\n3. Vạch ra Lộ trình ôn tập 3 bước hành động cụ thể để tôi sửa chữa triệt để các lỗ hổng trên và nâng cao điểm số.`
            : `1. Phân tích kết quả này ${hasFeedback ? 'dựa trên lời phê của giảng viên ' : ''}trong bối cảnh môn ${res.courseName}.\n2. Dựa vào tài liệu giáo trình của môn học, chỉ ra chính xác các chương mục, khái niệm và phần kiến thức cốt lõi tôi cần đọc và củng cố lại.\n3. Vạch ra một Lộ trình hành động 3 bước rõ ràng kèm checklist cụ thể để tôi khắc phục triệt để và nâng cao điểm số.`,
        };

      case 'deep_dive':
        return {
          title: '🔍 Giải thích chuyên sâu bản chất lý thuyết & nguyên lý',
          body: hasMistakes
            ? `1. Đi sâu vào BẢN CHẤT LÝ THUYẾT của chính xác các câu hỏi tôi đã làm sai ở trên (đặc biệt là các phần về: ${weakTopicsStr || 'đã liệt kê'}).\n2. Giải thích tại sao đáp án đúng lại là như vậy, và bẫy khái niệm hoặc ngộ nhận tư duy nào đã khiến tôi chọn sai các câu đó.\n3. Hướng dẫn cách tiếp cận đúng đắn và tư duy chuẩn xác để tôi không bao giờ mắc lại các lỗi tương tự.`
            : `1. Đi sâu vào bản chất lý thuyết và các nguyên lý học thuật liên quan đến nội dung bài kiểm tra "${res.name}".\n2. Phân tích các khái niệm dễ gây hiểu nhầm hoặc sai sót phổ biến nhất ở mức điểm ${formatGrade(res.score)}/${formatGrade(res.maxScore)}đ.\n3. Giải thích cặn kẽ cách tiếp cận đúng đắn và tư duy chuẩn xác cho môn học này.`,
        };

      case 'socratic':
        return {
          title: '💬 Gia sư gợi mở (Phương pháp hỏi đáp Socratic tương tác)',
          body: hasMistakes
            ? `1. Chọn ngay 1 câu hỏi tôi đã làm sai ở trên (ưu tiên phần về ${weakTopics[0] || 'điểm mù lớn nhất'}).\n2. Đặt cho tôi 1-2 câu hỏi gợi mở để giúp tôi tự suy ngẫm và nhận ra lý do vì sao đáp án đúng lại khác với lựa chọn của tôi.\n3. Chờ tôi phản hồi rồi hãy cùng tôi giải quyết tiếp các câu sai còn lại!`
            : `1. Không đưa ra ngay bài giảng hay lời giải dài dòng.\n2. Nêu ngắn gọn các chuyên đề trọng tâm và phần lý thuyết dễ gây nhầm lẫn nhất của môn ${res.courseName}.\n3. Đặt cho tôi 2 câu hỏi gợi mở để giúp tôi tự nhớ lại xem mình đã bị lúng túng hoặc chưa chắc chắn ở phần nào nhất khi làm bài thi.\n4. Sau khi tôi phản hồi, hãy cùng tôi gỡ rối từng câu một nhé!`,
        };

      case 'practice':
        return {
          title: '🎯 Bài tập vận dụng & Câu hỏi tình huống củng cố',
          body: isHighScore
            ? `1. Chúc mừng tôi một cách hào hứng và công nhận nỗ lực học tập này!\n2. Đưa ra 2 bài toán tình huống thực tế hoặc câu hỏi phân tích sâu vượt chương trình của môn ${res.courseName} để xem giới hạn tư duy của tôi ở đâu nhé!\n3. Chờ tôi đưa ra câu trả lời trước khi bạn phân tích và chấm giải.`
            : hasMistakes
            ? `1. Đưa ra ngay 2 bài tập hoặc câu hỏi tình huống tương tự xoáy sâu vào các điểm mù tôi vừa làm sai ở trên (về ${weakTopicsStr || 'các câu hỏi trên'}).\n2. Cho tôi tự suy nghĩ trả lời, sau đó chữa chi tiết và chỉ ra bài học kinh nghiệm để tôi không lặp lại lỗi sai.`
            : `1. Đưa ra ngay 2 bài tập hoặc câu hỏi tình huống tương tự với kiến thức của bài kiểm tra này (từ mức độ hiểu đến vận dụng).\n2. Cho tôi tự suy nghĩ trả lời, sau đó chữa chi tiết và chỉ ra bài học kinh nghiệm để tôi không lặp lại lỗi sai.`,
        };
    }
  };

  let instruction = '';
  if (effectiveStrategies.length === 1) {
    const single = getStrategyInstruction(effectiveStrategies[0]);
    let roleTitle = 'Bạn hãy đóng vai Cố Vấn Học Tập chuyên sâu:';
    if (effectiveStrategies[0] === 'roadmap') roleTitle = 'Bạn hãy đóng vai Cố Vấn Học Tập chuyên sâu:';
    else if (effectiveStrategies[0] === 'deep_dive') roleTitle = `Bạn hãy đóng vai Chuyên Gia Học Thuật môn ${res.courseName}:`;
    else if (effectiveStrategies[0] === 'socratic') roleTitle = 'Bạn hãy đóng vai Gia Sư Gợi Mở (phương pháp Socratic tương tác):';
    else if (effectiveStrategies[0] === 'practice') roleTitle = isHighScore ? 'Bạn hãy đóng vai Người Thử Thách:' : 'Bạn hãy đóng vai Người Hướng Dẫn Luyện Tập:';

    instruction = `${roleTitle}\n${single.body}`;
  } else {
    instruction = `Bạn hãy đóng vai Cố Vấn Học Tập & Chuyên Gia Toàn Diện môn ${res.courseName}, hỗ trợ tôi đồng thời theo ${effectiveStrategies.length} phương pháp sau:\n`;
    effectiveStrategies.forEach((st, idx) => {
      const item = getStrategyInstruction(st);
      instruction += `\n[MỤC TIÊU ${idx + 1}: ${item.title}]\n${item.body}\n`;
    });
  }

  // Detail modifier
  const detailInstruction =
    detailLevel === 'concise'
      ? '\n\nĐịnh dạng phản hồi: Trọng tâm, súc tích, gạch đầu dòng rõ ràng, đi thẳng vào vấn đề cốt lõi.'
      : '\n\nĐịnh dạng phản hồi: Chi tiết, lập luận chặt chẽ, dẫn chứng cụ thể từ giáo trình tài liệu môn học.';

  const focusDirective = hasMistakes
    ? '\n\nCHỈ THỊ BẮT BUỘC: Hãy tập trung 100% vào chính xác các câu hỏi làm sai và các chủ đề yếu đã nêu ở trên. Tuyệt đối KHÔNG giải thích lý thuyết chung chung toàn bộ môn học, không nói "cần có nội dung câu hỏi", và không liệt kê lan man ngoài phạm vi các lỗi sai này.'
    : '';

  return `${intro}\n\n${instruction}${detailInstruction}${focusDirective}`;
}

/**
 * Evaluates an ExamResult and returns the appropriate action routing info.
 */
export function resolveGradeRoute(
  res: ExamResult,
  isAnalyzed = false,
  strategy?: GradeResponseStrategy,
  detailLevel: 'concise' | 'detailed' = 'detailed'
): GradeRouteInfo {
  const hasDetails = Boolean(res.attemptId);
  const rawFeedback = (res.feedback || '').trim();
  const hasFeedback = Boolean(
    rawFeedback &&
    rawFeedback !== '-' &&
    rawFeedback !== 'Chưa có nhận xét' &&
    rawFeedback.toLowerCase() !== 'none'
  );

  const scoreNum = Number(res.score) || 0;
  const maxScore = Number(res.maxScore) || 10;
  const ratio = maxScore > 0 ? scoreNum / maxScore : 0;
  const isHighScore = ratio >= 0.7;

  // Case 1: has_details: true, has_feedback: true
  if (hasDetails && hasFeedback) {
    const prompt = buildGradePrompt(res, strategy || 'roadmap', detailLevel);
    return {
      hasDetails: true,
      hasFeedback: true,
      mode: 'full_insight',
      modeName: 'Chẩn đoán bài thi',
      defaultStrategy: 'roadmap',
      actionType: 'modal',
      buttonLabel: isAnalyzed ? 'Xem lại phân tích' : 'Chẩn đoán bài thi',
      buttonTooltip: 'Dùng lời phê của giáo viên kết hợp bóc tách chi tiết từng câu sai để vạch lộ trình ôn tập.',
      badgeText: '',
      badgeColor: '#a855f7',
      buttonGradient: isAnalyzed
        ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.25), rgba(168, 85, 247, 0.25))'
        : 'linear-gradient(135deg, rgba(168, 85, 247, 0.25), rgba(236, 72, 153, 0.25))',
      borderColor: isAnalyzed ? 'rgba(34, 197, 94, 0.5)' : 'rgba(168, 85, 247, 0.4)',
      prompt,
    };
  }

  // Case 2: has_details: true, has_feedback: false
  if (hasDetails && !hasFeedback) {
    const prompt = buildGradePrompt(res, strategy || 'deep_dive', detailLevel);
    return {
      hasDetails: true,
      hasFeedback: false,
      mode: 'tech_analysis',
      modeName: 'Chẩn đoán bài thi',
      defaultStrategy: 'deep_dive',
      actionType: 'modal',
      buttonLabel: isAnalyzed ? 'Xem lại phân tích' : 'Chẩn đoán bài thi',
      buttonTooltip: 'Tự động phân nhóm các câu chọn sai, đối chiếu với tài liệu môn học để tìm ra lỗ hổng khái niệm cốt lõi.',
      badgeText: '',
      badgeColor: '#38bdf8',
      buttonGradient: isAnalyzed
        ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.25), rgba(56, 189, 248, 0.25))'
        : 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(124, 109, 242, 0.2))',
      borderColor: isAnalyzed ? 'rgba(34, 197, 94, 0.5)' : 'rgba(56, 189, 248, 0.4)',
      prompt,
    };
  }

  // Case 3: has_details: false, has_feedback: true
  if (!hasDetails && hasFeedback) {
    const prompt = buildGradePrompt(res, strategy || 'roadmap', detailLevel);
    return {
      hasDetails: false,
      hasFeedback: true,
      mode: 'amplification',
      modeName: 'Ôn tập theo nhận xét',
      defaultStrategy: 'roadmap',
      actionType: 'chat',
      buttonLabel: 'Ôn tập theo nhận xét',
      buttonTooltip: 'Lấy nhận xét của giảng viên làm trọng tâm, đối chiếu theo đề cương tài liệu môn học để gợi ý nội dung ôn tập.',
      badgeText: '',
      badgeColor: '#f59e0b',
      buttonGradient: 'linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(234, 88, 12, 0.2))',
      borderColor: 'rgba(245, 158, 11, 0.45)',
      prompt,
    };
  }

  // Case 4: has_details: false, has_feedback: false
  if (isHighScore) {
    const prompt = buildGradePrompt(res, strategy || 'practice', detailLevel);
    return {
      hasDetails: false,
      hasFeedback: false,
      mode: 'interviewer_blind',
      modeName: 'Luyện tập nâng cao',
      defaultStrategy: 'practice',
      actionType: 'chat',
      buttonLabel: 'Luyện tập nâng cao',
      buttonTooltip: 'Kết quả xuất sắc! AI sẽ đồng hành gợi mở các bài tập và tình huống nâng cao.',
      badgeText: '',
      badgeColor: '#22c55e',
      buttonGradient: 'linear-gradient(135deg, rgba(34, 197, 94, 0.25), rgba(168, 85, 247, 0.2))',
      borderColor: 'rgba(34, 197, 94, 0.45)',
      prompt,
    };
  } else {
    const prompt = buildGradePrompt(res, strategy || 'socratic', detailLevel);
    return {
      hasDetails: false,
      hasFeedback: false,
      mode: 'interviewer_blind',
      modeName: 'Hỏi gia sư AI',
      defaultStrategy: 'socratic',
      actionType: 'chat',
      buttonLabel: 'Hỏi gia sư AI',
      buttonTooltip: 'Hệ thống chưa có chi tiết bài làm. AI sẽ chủ động gợi mở để cùng bạn làm rõ các khúc mắc.',
      badgeText: '',
      badgeColor: '#ec4899',
      buttonGradient: 'linear-gradient(135deg, rgba(236, 72, 153, 0.25), rgba(139, 92, 246, 0.2))',
      borderColor: 'rgba(236, 72, 153, 0.45)',
      prompt,
    };
  }
}

