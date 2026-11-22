'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, CheckCircle2, ChevronRight, Clock3, Lightbulb, LoaderCircle, X } from 'lucide-react';
import type { CourseSourceItem, QuizQuestion } from '@/app/types';
import {
  QUICK_TEST_QUESTION_COUNT,
  QUICK_TEST_SESSION_PREFIX,
  answerLabel,
  correctAnswerLabel,
  isCorrect,
  normalizeQuickTestQuestions,
  questionKey,
  toStoredCorrectAnswers,
  toStoredQuestion,
  writeQuickTestSession,
  type QuickTestQuestion,
  type StoredQuickTestSession,
} from '@/app/lib/quick-test';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { checkIsPuterSignedIn } from '@/app/lib/puter-client';

interface QuickTestGateProps {
  courseId?: number;
  courseName: string;
  userId?: number;
  /** Course sources selected on the course page; lets the quiz read the LMS corpus. */
  sources?: CourseSourceItem[];
  onComplete?: () => void;
}

const QUESTION_COUNT = QUICK_TEST_QUESTION_COUNT;
const SESSION_PREFIX = QUICK_TEST_SESSION_PREFIX;

function fallbackQuestions(courseName: string, sources?: CourseSourceItem[]): QuickTestQuestion[] {
  const sourceSample = (sources || []).slice(0, 3).map((s) => s.name).filter(Boolean);
  const sourceContext = sourceSample.length > 0 ? ` trong các học liệu (${sourceSample.join(', ')})` : '';

  return [
    {
      q: `Mục tiêu cơ bản nhất của việc nghiên cứu môn học "${courseName}"${sourceContext} là gì?`,
      type: 'multiple_choice',
      choices: [
        'Nắm vững kiến thức nền tảng và phương pháp thực hành chuyên môn',
        'Học thuộc lòng định nghĩa mà không cần hiểu bản chất',
        'Bỏ qua lý thuyết cơ bản để làm theo khuôn mẫu',
        'Chỉ tập trung vào các từ khóa tiếng Anh',
      ],
      answer: 0,
      explanation: 'Việc học đòi hỏi sự kết hợp giữa hiểu bản chất lý thuyết và khả năng áp dụng thực tế vào học phần.',
    },
    {
      q: `Việc check-in ôn lại nhịp kiến thức trước mỗi phiên học môn "${courseName}" mang lại lợi ích gì?`,
      type: 'multiple_choice',
      choices: [
        'Kích hoạt vùng nhớ kiến thức và nhận diện lỗ hổng cần củng cố kịp thời',
        'Bắt buộc phải thuộc lòng toàn bộ giáo trình ngay lập tức',
        'Thay thế toàn bộ các bài thi và bài kiểm tra trên lớp',
        'Chỉ để kiểm tra thời gian học tập',
      ],
      answer: 0,
      explanation: 'Check-in tạo phản xạ gợi nhớ chủ động (active recall), giúp củng cố kiến thức dài hạn.',
    },
    {
      q: `Trong môn "${courseName}", việc liên kết các khái niệm giữa các bài học là yếu tố quan trọng để làm chủ kiến thức nâng cao.`,
      type: 'true_false',
      choices: ['Đúng', 'Sai'],
      answer: 0,
      explanation: 'Kiến thức có tính hệ thống; nắm chắc kiến thức trước là tiền đề để tiếp thu bài học sau.',
    },
  ];
}

export function QuickTestGate({ courseId, courseName, userId, sources, onComplete }: QuickTestGateProps) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [questions, setQuestions] = useState<QuickTestQuestion[]>([]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<{ score: number; feedback: string; recommendation: string } | null>(null);
  /** Khóa theo môn để một môn chỉ mở check-in một lần trong mỗi lần tải trang. */
  const shownCourseRef = useRef<string | null>(null);

  const sessionKey = `${SESSION_PREFIX}${courseId ?? courseName}`;

  /** Ghi lượt check-in hôm nay vào bản ghi ngày, dùng chung với game "3 câu hỏi check-in". */
  const persistDaily = useCallback(
    (
      status: 'in_progress' | 'completed',
      payload: { questions: QuickTestQuestion[]; answers?: Record<number, string> },
      score?: number
    ) => {
      if (!courseId) return;
      saveDailyPlayable(userId, courseId, 'quiz', {
        status,
        data: payload,
        ...(status === 'completed' && typeof score === 'number'
          ? { score, maxScore: payload.questions.length, completedAt: new Date().toISOString() }
          : {}),
      });
    },
    [courseId, userId]
  );

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenerationError(null);
    setResult(null);

    try {
      const collected: QuickTestQuestion[] = [];
      const seen = new Set<string>();

      // 1. Ưu tiên sinh câu hỏi trực tiếp từ LMS context qua client-side (Puter.js)
      try {
        const materialContext = buildMaterialContext(sources);
        const clientRes = await generatePlayableData<{
          questions: Array<{ q: string; type?: string; choices: string[]; answer: number | string; explanation?: string }>;
        }>('quiz', courseName, materialContext, Number(userId) || undefined);

        if (clientRes?.questions?.length) {
          for (const q of normalizeQuickTestQuestions(clientRes.questions as QuizQuestion[])) {
            const key = questionKey(q.q);
            if (seen.has(key)) continue;
            seen.add(key);
            collected.push(q);
            if (collected.length >= QUESTION_COUNT) break;
          }
        }
      } catch (clientErr) {
        console.warn('[QuickTestGate] Client generation skipped, fallback to server/LMS:', clientErr);
      }

      // 2. Nếu client chưa đủ 3 câu, gọi API backend
      if (collected.length < QUESTION_COUNT) {
        for (let attempt = 0; attempt < 2 && collected.length < QUESTION_COUNT; attempt += 1) {
          try {
            const response = await fetch('/api/quiz', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                topic: courseName,
                course: courseName,
                courseId,
                userId,
                count: QUESTION_COUNT,
                quickTest: true,
                ragMode: 'strict',
                questionTypes: ['multiple_choice', 'true_false'],
                sources: (sources || []).map((src) => ({
                  name: src.name,
                  url: src.url,
                  type: src.type,
                  fileId: src.fileId,
                  moduleId: src.moduleId,
                  sectionId: src.sectionId,
                  sectionName: src.sectionName,
                  chapter: src.chapter,
                  isStudentUpload: src.isStudentUpload,
                  content: src.content,
                })),
                sourceNames: (sources || []).map((src) => src.name),
              }),
            });
            const data = (await response.json()) as { questions?: QuizQuestion[]; error?: string };
            if (response.ok && data.questions?.length) {
              for (const question of normalizeQuickTestQuestions(data.questions)) {
                const key = questionKey(question.q);
                if (seen.has(key)) continue;
                seen.add(key);
                collected.push(question);
                if (collected.length >= QUESTION_COUNT) break;
              }
            }
          } catch {
            // ignore backend failure
          }
        }
      }

      // 3. Không dùng câu hỏi chung chung làm fallback: nếu AI không sinh đủ câu hỏi cụ thể,
      // báo lỗi để người dùng thử lại hoặc bỏ qua thay vì hiển thị câu hỏi meta/generic.
      if (collected.length < QUESTION_COUNT) {
        throw new Error('Không có đủ 3 câu hỏi trắc nghiệm một đáp án (A/B/C/D hoặc Đúng/Sai) phù hợp.');
      }

      setQuestions(collected);

      // Lưu lại phiên kiểm tra trên máy người dùng
      writeQuickTestSession(sessionKey, {
        courseName,
        savedAt: new Date().toISOString(),
        status: 'in_progress',
        questions: collected.map(toStoredQuestion),
        correctAnswers: toStoredCorrectAnswers(collected),
      });
      persistDaily('in_progress', { questions: collected, answers: {} });
    } catch (error) {
      setQuestions([]);
      setGenerationError(error instanceof Error ? error.message : 'Không thể chuẩn bị câu hỏi lúc này.');
    } finally {
      setGenerating(false);
    }
  }, [courseId, courseName, persistDaily, sessionKey, sources, userId]);

  useEffect(() => {
    // Chờ có danh tính người dùng để bản ghi ngày dùng đúng khóa (tránh hỏi 2 lần khi user tải xong).
    if (!courseId || !userId) {
      return;
    }
    const courseKey = String(courseId);
    if (shownCourseRef.current === courseKey) {
      return;
    }

    // Chỉ check-in 1 lượt/ngày giống các trò chơi khác: đã có bản ghi hôm nay thì không hỏi lại.
    if (getDailyPlayable(userId, courseId, 'quiz')) {
      shownCourseRef.current = courseKey;
      setLoading(false);
      return;
    }

    let cancelled = false;
    void checkIsPuterSignedIn(2500).then((signedIn) => {
      if (cancelled) return;
      shownCourseRef.current = courseKey;

      // Người dùng chưa đăng nhập Puter -> không chặn bằng QuickTestGate, cho vào học luôn.
      if (!signedIn) {
        setLoading(false);
        onComplete?.();
        return;
      }

      setVisible(true);
      setLoading(false);
      void generate();
    });

    return () => {
      cancelled = true;
    };
  }, [courseId, generate, onComplete, userId]);

  const currentQuestion = questions[step];
  const currentAnswer = answers[step];
  const canAdvance = Boolean(currentAnswer);
  const progress = questions.length ? ((step + 1) / questions.length) * 100 : 0;

  const finish = () => {
    const score = questions.reduce(
      (total, question, index) => total + (isCorrect(question, answers[index] || '') ? 1 : 0),
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
    const completedAt = new Date().toISOString();
    const wrongQuestions = questions
      .map((question, index) => ({
        question,
        answer: answers[index] || '',
        correct: isCorrect(question, answers[index] || ''),
      }))
      .filter((item) => !item.correct);

    const sessionPayload: StoredQuickTestSession = {
      courseName,
      savedAt: new Date().toISOString(),
      status: 'completed',
      questions: questions.map(toStoredQuestion),
      correctAnswers: toStoredCorrectAnswers(questions),
      answers,
      score,
      total: questions.length,
      feedback,
      recommendation,
      completedAt,
      wrongQuestions: wrongQuestions.map((item) => ({
        q: item.question.q,
        type: item.question.type,
        choices: item.question.choices,
        answer: item.question.answer,
        userAnswer: answerLabel(item.question, item.answer),
        correctAnswer: correctAnswerLabel(item.question),
        explanation: item.question.explanation,
      })),
    };

    writeQuickTestSession(sessionKey, sessionPayload);
    persistDaily('completed', { questions, answers }, score);
    setResult({ score, feedback, recommendation });
  };

  const selectAnswer = (choiceIndex: number) => {
    const next = { ...answers, [step]: String(choiceIndex) };
    setAnswers(next);
    if (questions.length) {
      persistDaily('in_progress', { questions, answers: next });
    }
  };

  const close = () => {
    // Đóng giữa chừng (kể cả khi sinh câu hỏi lỗi) vẫn tính là đã dùng lượt hôm nay.
    if (!result) {
      persistDaily('in_progress', { questions, answers });
    }
    setVisible(false);
    onComplete?.();
  };

  if (loading || !visible) return null;

  return (
    <div className="quick-test-overlay">
      <section className="quick-test-card" role="dialog" aria-modal="true" aria-labelledby="quick-test-title">
        <button type="button" className="quick-test-close" onClick={close} aria-label="Đóng câu hỏi nhanh">
          <X size={16} />
        </button>
        {!result ? (
          <>
            <div className="quick-test-header">
              <span className="quick-test-icon">
                <Brain size={20} />
              </span>
              <div>
                <p className="eyebrow">CHECK-IN TRƯỚC KHI HỌC</p>
                <h2 id="quick-test-title">3 câu hỏi nhanh</h2>
                <p>Ôn lại nhịp kiến thức của {courseName} · 1 lượt/ngày</p>
              </div>
            </div>
            <div className="quick-test-progress">
              <i style={{ width: `${progress}%` }} />
            </div>
            {generating ? (
              <div className="quick-test-loading">
                <LoaderCircle className="quick-test-spin" size={22} /> Đang chuẩn bị câu hỏi từ học liệu LMS…
              </div>
            ) : generationError ? (
              <div className="quick-test-loading">
                <p>{generationError}</p>
                <div className="quick-test-actions">
                  <button type="button" onClick={() => void generate()}>
                    Thử lại
                  </button>
                  <button type="button" onClick={close}>
                    Bỏ qua lần này
                  </button>
                </div>
              </div>
            ) : !currentQuestion ? (
              <div className="quick-test-loading">Không có câu hỏi phù hợp.</div>
            ) : (
              <>
                <div className="quick-test-count">
                  <span>
                    CÂU {step + 1}/{questions.length}
                  </span>
                  <span>
                    <Clock3 size={13} /> khoảng 1 phút
                  </span>
                </div>
                <h3>{currentQuestion.q}</h3>
                <div className="quick-test-choices">
                  {(currentQuestion.type === 'true_false' ? ['Đúng', 'Sai'] : currentQuestion.choices).map(
                    (choice, index) => (
                      <button
                        type="button"
                        key={`${choice}-${index}`}
                        className={currentAnswer === String(index) ? 'selected' : ''}
                        onClick={() => selectAnswer(index)}
                      >
                        <span>
                          {currentQuestion.type === 'true_false'
                            ? index === 0 ? '✓' : '✕'
                            : String.fromCharCode(65 + index)}
                        </span>
                        {choice}
                      </button>
                    )
                  )}
                </div>
                <div className="quick-test-actions">
                  <span>
                    {step + 1} trên {questions.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => (step < questions.length - 1 ? setStep((value) => value + 1) : finish())}
                    disabled={!canAdvance}
                  >
                    {step < questions.length - 1 ? 'Câu tiếp theo' : 'Xem nhận xét'}{' '}
                    <ChevronRight size={15} />
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="quick-test-result">
            <div className="quick-test-result-icon">
              <CheckCircle2 size={26} />
            </div>
            <p className="eyebrow">CHECK-IN HOÀN TẤT</p>
            <h2>
              {result.score}/{questions.length} câu đúng
            </h2>
            <strong>{result.feedback}</strong>

            {/* Chi tiết câu sai và giải thích có sẵn */}
            {questions.some((q, idx) => !isCorrect(q, answers[idx] || '')) && (
              <div style={{ width: '100%', textAlign: 'left', margin: '0.8rem 0' }}>
                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 800, textTransform: 'uppercase' }}>
                  Giải thích các điểm cần lưu ý:
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                  {questions
                    .map((q, idx) => ({ q, userAns: answers[idx] || '', correct: isCorrect(q, answers[idx] || '') }))
                    .filter((item) => !item.correct)
                    .map((item, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: '11.5px',
                          padding: '6px 8px',
                          borderRadius: '8px',
                          background: 'rgba(255,255,255,0.06)',
                          color: '#e2e8f0',
                        }}
                      >
                        <div style={{ color: '#fb7185', fontWeight: 600 }}>✕ {item.q.q}</div>
                        <div style={{ color: '#4ade80', fontSize: '11px', marginTop: '2px' }}>
                          Đáp án đúng: {correctAnswerLabel(item.q)}
                        </div>
                        {item.q.explanation && (
                          <div style={{ color: '#cbd5e1', fontSize: '10.5px', marginTop: '2px' }}>
                            {item.q.explanation}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )}

            <div className="quick-test-recommendation">
              <Lightbulb size={17} />
              <span>{result.recommendation}</span>
            </div>
            <button type="button" onClick={close}>
              Vào không gian học tập <ChevronRight size={15} />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
