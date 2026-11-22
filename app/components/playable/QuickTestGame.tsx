'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brain, CheckCircle2, ChevronRight, Clock3, Lightbulb, LoaderCircle, Target, X } from 'lucide-react';
import type { CourseSourceItem, QuizQuestion } from '@/app/types';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { PlayableAIFeedback } from '@/app/components/playable/PlayableAIFeedback';
import {
  answerLabel,
  correctAnswerLabel,
  isCorrect,
  normalizeQuickTestQuestions,
  questionKey,
  type QuickTestQuestion,
} from '@/app/lib/quick-test';

interface QuickTestGameProps {
  courseId: number | string | undefined;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
  onClose: () => void;
}

const QUESTION_COUNT = 3;

function fallbackQuestions(courseName: string): QuickTestQuestion[] {
  return [
    {
      q: `Mục tiêu cơ bản nhất của việc học môn ${courseName} là gì?`,
      type: 'multiple_choice',
      choices: [
        'Nắm vững kiến thức cốt lõi và kỹ năng thực hành',
        'Học thuộc lòng tất cả các định nghĩa không cần hiểu',
        'Bỏ qua lý thuyết và chỉ làm theo mẫu có sẵn',
        'Chỉ cần nhớ các từ khóa tiếng Anh',
      ],
      answer: 0,
      explanation: 'Việc học đòi hỏi sự kết hợp giữa hiểu bản chất lý thuyết và khả năng áp dụng thực tế.',
    },
    {
      q: 'Việc kiểm tra nhanh kiến thức trước buổi học (check-in) giúp ích gì cho sinh viên?',
      type: 'multiple_choice',
      choices: [
        'Kích hoạt vùng nhớ kiến thức và nhận diện lỗ hổng cần củng cố',
        'Tính điểm trực tiếp vào điểm thi kết thúc học phần',
        'Thay thế toàn bộ các bài tập lớn trong kỳ',
        'Bắt buộc phải thuộc lòng toàn bộ giáo trình',
      ],
      answer: 0,
      explanation: 'Check-in tạo phản xạ gợi nhớ và giúp người học tập trung vào các khái niệm mình còn bỡ ngỡ.',
    },
    {
      q: 'Để đạt hiệu quả cao trong môn học này, sinh viên nên thường xuyên làm gì?',
      type: 'multiple_choice',
      choices: [
        'Hệ thống hóa kiến thức theo sơ đồ và làm bài tập ôn tập định kỳ',
        'Chỉ xem bài giảng 1 lần duy nhất trước ngày thi',
        'Không cần làm bài tập thực hành',
        'Đọc lướt qua tài liệu và không ghi chú',
      ],
      answer: 0,
      explanation: 'Ôn tập ngắt quãng và thực hành chủ động là phương pháp học tập khoa học nhất.',
    },
  ];
}

export function QuickTestGame({ courseId, courseName, userId, sources, onClose }: QuickTestGameProps) {
  const [questions, setQuestions] = useState<QuickTestQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<'generating' | 'playing' | 'summary'>('generating');
  const [result, setResult] = useState<{ score: number; feedback: string; recommendation: string } | null>(null);

  const initGame = useCallback((qs: QuickTestQuestion[], savedAnswers?: Record<number, string>) => {
    setQuestions(qs);
    setAnswers(savedAnswers || {});
    setStep(0);
    setStatus('playing');
  }, []);

  const loadOrGenerate = useCallback(async (forceNew = false) => {
    setStatus('generating');

    if (!forceNew) {
      const record = getDailyPlayable<{ questions: QuickTestQuestion[]; answers?: Record<number, string> }>(
        userId,
        courseId,
        'quiz'
      );
      if (record) {
        if (record.status === 'completed' && record.data?.questions) {
          setQuestions(record.data.questions);
          const sc = record.score ?? record.data.questions.length;
          const fb =
            sc === record.data.questions.length
              ? 'Nền tảng rất chắc.'
              : sc >= 2
              ? 'Bạn đang nắm phần lớn kiến thức.'
              : 'Có một vài lỗ hổng cần củng cố.';
          const rec =
            sc >= 2
              ? `Tiếp tục phát huy trong môn ${courseName}.`
              : `Bắt đầu bằng phần Tóm tắt và ôn lại các khái niệm nền của ${courseName}.`;
          setResult({ score: sc, feedback: fb, recommendation: rec });
          setStatus('summary');
          return;
        }
        if (record.status === 'in_progress' && record.data?.questions?.length) {
          initGame(record.data.questions, record.data.answers);
          return;
        }
      }
    }

    // 1-Pass generation
    let generated: QuickTestQuestion[] = [];
    try {
      const materialContext = buildMaterialContext(sources);
      const res = await generatePlayableData<{ questions: Array<{ q: string; type?: string; choices: string[]; answer: string; explanation?: string }> }>(
        'quiz',
        courseName,
        materialContext,
        Number(userId) || undefined
      );
      if (res?.questions?.length) {
        generated = normalizeQuickTestQuestions(res.questions as QuizQuestion[]);
      }
    } catch {
      // fallback to /api/quiz or static
    }

    if (!generated.length) {
      try {
        const response = await fetch('/api/quiz', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: courseName,
            course: courseName,
            courseId: Number(courseId) || undefined,
            userId: Number(userId) || undefined,
            count: QUESTION_COUNT,
            quickTest: true,
            ragMode: 'strict',
            questionTypes: ['multiple_choice', 'true_false'],
            sources: (sources || []).map((src) => ({
              name: src.name,
              url: src.url,
              type: src.type,
            })),
            sourceNames: (sources || []).map((src) => src.name),
          }),
        });
        const data = (await response.json()) as { questions?: QuizQuestion[] };
        if (data.questions?.length) {
          generated = normalizeQuickTestQuestions(data.questions);
        }
      } catch {
        // fallback
      }
    }

    if (generated.length < QUESTION_COUNT) {
      // Giữ các câu AI hợp lệ và chỉ bù bằng câu dự phòng cho đủ số lượng,
      // tránh việc một câu lỗi làm mất toàn bộ bộ câu hỏi vừa sinh.
      for (const filler of fallbackQuestions(courseName)) {
        if (generated.length >= QUESTION_COUNT) break;
        if (!generated.some((question) => questionKey(question.q) === questionKey(filler.q))) {
          generated.push(filler);
        }
      }
    }

    const finalQuestions = generated.slice(0, QUESTION_COUNT);

    saveDailyPlayable(userId, courseId, 'quiz', {
      status: 'in_progress',
      data: { questions: finalQuestions, answers: {} },
    });

    initGame(finalQuestions);
  }, [courseId, courseName, initGame, sources, userId]);

  useEffect(() => {
    void loadOrGenerate();
  }, [loadOrGenerate]);

  const currentQuestion = questions[step];
  const currentAnswer = answers[step];
  const canAdvance = Boolean(currentAnswer);
  const progress = questions.length ? ((step + 1) / questions.length) * 100 : 0;

  const handleSelectAnswer = (choiceIndex: number) => {
    const updated = { ...answers, [step]: String(choiceIndex) };
    setAnswers(updated);

    // Cập nhật câu trả lời dở dang vào localStorage
    saveDailyPlayable(userId, courseId, 'quiz', {
      status: 'in_progress',
      data: { questions, answers: updated },
    });
  };

  const finish = () => {
    const score = questions.reduce(
      (total, q, idx) => total + (isCorrect(q, answers[idx] || '') ? 1 : 0),
      0
    );
    const feedback =
      score === questions.length
        ? 'Nền tảng rất chắc.'
        : score === 2
        ? 'Bạn đang nắm phần lớn kiến thức.'
        : score === 1
        ? 'Có một vài lỗ hổng cần củng cố.'
        : 'Nên ôn lại kiến thức nền trước khi học tiếp.';

    const recommendation =
      score >= 2
        ? `Tiếp tục ${courseName}, ưu tiên ghi lại một khái niệm trọng tâm sau mỗi phiên học.`
        : `Bắt đầu bằng phần Tóm tắt và ôn lại các khái niệm nền của ${courseName} trước khi làm bài nâng cao.`;

    setResult({ score, feedback, recommendation });
    setStatus('summary');

    // Lưu hoàn thành vào localStorage, KHÔNG lưu xuống database backend theo yêu cầu
    saveDailyPlayable(userId, courseId, 'quiz', {
      status: 'completed',
      data: { questions, answers },
      score,
      maxScore: questions.length,
      completedAt: new Date().toISOString(),
    });
  };

  if (status === 'generating') {
    return (
      <div className="playable-panel">
        <div className="playable-loading">
          <LoaderCircle className="playable-spin" size={22} /> Đang chuẩn bị 3 câu hỏi trắc nghiệm check-in…
        </div>
      </div>
    );
  }

  const aiSessionSummary = [
    `Kết quả: ${result?.score ?? 0}/${questions.length} câu đúng.`,
    ...questions.map((question, index) => {
      const userAnswer = answers[index] || '';
      const correct = isCorrect(question, userAnswer);
      return [
        `Câu ${index + 1}: ${question.q}`,
        `- Đáp án đúng: ${correctAnswerLabel(question)}`,
        `- Bạn chọn: ${userAnswer ? answerLabel(question, userAnswer) : 'chưa trả lời'}`,
        `- Kết quả: ${correct ? 'đúng' : 'sai'}`,
        `- Giải thích: ${question.explanation || 'không có'}`,
      ].join('\n');
    }),
  ].join('\n\n');

  return (
    <div className="playable-panel">
      <div className="playable-header">
        <button type="button" className="playable-close" onClick={onClose} aria-label="Đóng">
          <X size={16} />
        </button>
        <div className="playable-title">
          <Target size={20} />
          <span>3 câu hỏi trắc nghiệm check-in</span>
        </div>
        <div style={{ color: '#cbd5e1', fontSize: '13px', fontWeight: 700 }}>
          {status === 'summary' ? 'Hoàn thành' : `Câu ${step + 1}/${questions.length}`}
        </div>
      </div>

      {status !== 'summary' && currentQuestion ? (
        <div className="playable-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="playable-sub">Ôn lại nhịp kiến thức của {courseName} · 1 lượt/ngày</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#94a3b8', fontSize: '11px' }}>
              <Clock3 size={13} /> ~1 phút
            </span>
          </div>

          <div className="quick-test-progress" style={{ margin: '0.4rem 0' }}>
            <i style={{ width: `${progress}%` }} />
          </div>

          <h3 style={{ color: '#f8fafc', fontSize: '15px', fontWeight: 700, margin: '0.5rem 0', lineHeight: 1.5 }}>
            {currentQuestion.q}
          </h3>

          <div className="quick-test-choices">
            {(currentQuestion.type === 'true_false' ? ['Đúng', 'Sai'] : currentQuestion.choices).map((choice, index) => (
              <button
                type="button"
                key={`${choice}-${index}`}
                className={currentAnswer === String(index) ? 'selected' : ''}
                onClick={() => handleSelectAnswer(index)}
              >
                <span>
                  {currentQuestion.type === 'true_false'
                    ? index === 0 ? '✓' : '✕'
                    : String.fromCharCode(65 + index)}
                </span>
                {choice}
              </button>
            ))}
          </div>

          <div className="quick-test-actions" style={{ marginTop: '0.75rem' }}>
            <span>{step + 1} trên {questions.length}</span>
            <button
              type="button"
              onClick={() => (step < questions.length - 1 ? setStep((v) => v + 1) : finish())}
              disabled={!canAdvance}
            >
              {step < questions.length - 1 ? 'Câu tiếp theo' : 'Xem nhận xét'} <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : result ? (
        <div className="playable-summary">
          <div className="playable-summary-icon">
            <CheckCircle2 size={26} />
          </div>
          <p className="playable-eyebrow">CHECK-IN HOÀN TẤT HÔM NAY</p>
          <h2>
            {result.score}/{questions.length} câu đúng
          </h2>
          <div className="playable-ai-feedback">
            <Lightbulb size={17} />
            <span>{result.feedback}</span>
          </div>
          <div className="playable-recommendation">
            <Lightbulb size={17} />
            <span>{result.recommendation}</span>
          </div>

          <PlayableAIFeedback
            courseId={courseId}
            courseName={courseName}
            userId={userId}
            activityType="quiz"
            activityLabel="3 câu hỏi trắc nghiệm check-in"
            score={result.score}
            total={questions.length}
            sessionSummary={aiSessionSummary}
          />

          {/* Chi tiết đáp án và giải thích */}
          <div style={{ width: '100%', textAlign: 'left', marginTop: '0.5rem' }}>
            <span className="playable-mistake-label">Chi tiết câu hỏi & giải thích:</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
              {questions.map((q, idx) => {
                const userAns = answers[idx];
                const userIsCorrect = isCorrect(q, userAns || '');
                return (
                  <div
                    key={idx}
                    style={{
                      fontSize: '12px',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.05)',
                      color: '#e2e8f0',
                      borderLeft: `3px solid ${userIsCorrect ? '#22c55e' : '#f43f5e'}`,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: '#f8fafc', marginBottom: '3px' }}>
                      Câu {idx + 1}: {q.q}
                    </div>
                    <div style={{ fontSize: '11px', color: userIsCorrect ? '#4ade80' : '#fb7185' }}>
                      {userIsCorrect ? '✓ Bạn chọn đúng: ' : '✕ Bạn đã chọn: '}
                      {answerLabel(q, userAns || '')}
                      {!userIsCorrect && ` (Đáp án chuẩn: ${correctAnswerLabel(q)})`}
                    </div>
                    {q.explanation && (
                      <div style={{ color: '#94a3b8', marginTop: '3px', fontSize: '11px' }}>
                        {q.explanation}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="playable-actions" style={{ marginTop: '1rem' }}>
            <button type="button" className="playable-btn primary" onClick={onClose}>
              Đóng <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
