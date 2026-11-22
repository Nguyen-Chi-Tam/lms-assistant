'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brain, ChevronRight, CheckCircle2, Clock3, Lightbulb, LoaderCircle, X } from 'lucide-react';
import type { QuizQuestion } from '@/app/types';
import {
  QUICK_TEST_QUESTION_COUNT,
  answerLabel,
  correctAnswerLabel,
  isCorrect,
  normalizeQuickTestQuestions,
  type QuickTestQuestion,
} from '@/app/lib/quick-test';
import { askPuterJSON } from '@/app/lib/puter-client';
import { appendFeedbackHistory } from '@/app/lib/feedback-history';

interface QuickTestModalProps {
  courseId?: number | string;
  courseName: string;
  userId?: number | string;
  /** Course sources selected on the course page; used to build question context. */
  sources?: Array<{ name: string; url?: string; type?: string }>;
  open: boolean;
  onClose: () => void;
}

interface StoredQtRow {
  id?: string;
  content_data?: { id?: string; questions?: unknown };
  contentData?: { id?: string; questions?: unknown };
}

const qtDocId = (courseId: number | string | undefined, userId?: number | string) =>
  `qt_${userId ?? 'anon'}_${courseId ?? 'course'}`;

function shortText(value: string, max = 90) {
  const clean = value.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trim()}…`;
}

function describeWrongQuestion(question: QuickTestQuestion, userAnswer: string, position: number) {
  return `[Câu ${position}]
- Câu hỏi: ${question.q}
- Đáp án đúng: ${correctAnswerLabel(question)}
- Bạn đã chọn: ${answerLabel(question, userAnswer)}
${question.explanation ? `- Giải thích: ${question.explanation}` : ''}`;
}

export function QuickTestModal({ courseId, courseName, userId, sources, open, onClose }: QuickTestModalProps) {
  const [generating, setGenerating] = useState(false);
  const [questions, setQuestions] = useState<QuickTestQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<{ score: number; feedback: string; recommendation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const idNum = Number(userId) || 0;
  const courseIdNum = Number(courseId) || 0;
  const docId = qtDocId(courseId, userId);

  const loadExisting = useCallback(async (): Promise<QuickTestQuestion[]> => {
    const res = await fetch(
      `/api/learning-artifacts?moodleCourseId=${courseIdNum}&userId=${idNum}&artifactType=quick_test&limit=10`,
      { cache: 'no-store' },
    );
    const data = (await res.json()) as { artifacts?: StoredQtRow[] };
    const items = Array.isArray(data.artifacts) ? data.artifacts : [];
    const match = items.find(
      (it) => it.id === docId || it.content_data?.id === docId || it.contentData?.id === docId,
    );
    if (!match) return [];

    const content = match.content_data ?? match.contentData;
    if (!content || typeof content !== 'object' || !Array.isArray(content.questions)) return [];

    const valid = normalizeQuickTestQuestions(content.questions as QuizQuestion[]);
    return valid.length >= QUICK_TEST_QUESTION_COUNT ? valid : [];
  }, [courseIdNum, idNum, docId]);

  const generateViaServer = useCallback(async (): Promise<QuickTestQuestion[]> => {
    const res = await fetch('/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: courseName,
        course: courseName,
        courseId: courseIdNum,
        userId: idNum || undefined,
        count: QUICK_TEST_QUESTION_COUNT,
        quickTest: true,
        ragMode: 'strict',
        questionTypes: ['multiple_choice', 'true_false'],
        sources: (sources || []).map(src => ({ name: src.name, url: src.url, type: src.type })),
        sourceNames: (sources || []).map(src => src.name),
      }),
    });
    const data = (await res.json()) as { questions?: QuizQuestion[]; error?: string };
    if (!res.ok || !data.questions?.length) throw new Error(data.error || 'Không thể tạo câu hỏi nhanh');
    return normalizeQuickTestQuestions(data.questions);
  }, [courseIdNum, idNum, courseName, sources]);

  const generateViaPuter = useCallback(async (): Promise<QuickTestQuestion[]> => {
    const prompt = `Dựa trên môn học "${courseName}", hãy soạn đúng ${QUICK_TEST_QUESTION_COUNT} câu hỏi check-in nhanh một đáp án, bám sát kiến thức nền tảng của môn.

Mỗi câu hỏi phải thuộc một trong hai định dạng sau:
1) "type": "multiple_choice": "q" BẮT BUỘC kết thúc bằng dấu "?", "choices" đúng 4 phương án (A/B/C/D), "answer": số nguyên 0..3 là một đáp án đúng duy nhất.
2) "type": "true_false": "q" là mệnh đề khẳng định KHÔNG có dấu "?", "choices": ["Đúng", "Sai"], "answer": 0 nếu Đúng hoặc 1 nếu Sai.

Yêu cầu: mỗi câu kiểm tra một khái niệm, thuật ngữ, quy trình hoặc ví dụ cụ thể; không dùng câu hỏi chung chung áp dụng được cho mọi môn; mỗi câu có "explanation" ngắn gọn, đúng sự thật.
Trả về JSON duy nhất có khóa "questions".`;
    const parsed = await askPuterJSON<{ questions: QuizQuestion[] }>(prompt, 'gpt-4o-mini');
    return normalizeQuickTestQuestions(Array.isArray(parsed.questions) ? parsed.questions : []);
  }, [courseName]);

  const loadOrGenerate = useCallback(async () => {
    setError(null);
    try {
      const existing = await loadExisting();
      if (existing.length > 0) {
        setQuestions(existing);
        return;
      }

      setGenerating(true);
      try {
        const puterQuestions = await generateViaPuter();
        if (puterQuestions.length >= QUICK_TEST_QUESTION_COUNT) {
          setQuestions(puterQuestions);
          return;
        }
      } catch {
        // Puter not ready / no auth -> fall back to server RAG quiz
      }

      const serverQuestions = await generateViaServer();
      if (serverQuestions.length >= QUICK_TEST_QUESTION_COUNT) {
        setQuestions(serverQuestions);
        return;
      }
      throw new Error('Không có đủ 3 câu hỏi một đáp án (A/B/C/D hoặc Đúng/Sai) phù hợp.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể chuẩn bị câu hỏi lúc này.');
    } finally {
      setGenerating(false);
    }
  }, [loadExisting, generateViaPuter, generateViaServer]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOrGenerate();
  }, [open, courseId, userId, loadOrGenerate]);

  const currentQuestion = questions[step];
  const canAdvance = Boolean(currentQuestion && answers[step]);
  const progress = questions.length ? ((step + 1) / questions.length) * 100 : 0;

  const finish = async () => {
    const answered = questions.map((question, index) => ({
      question,
      answer: answers[index] || '',
      correct: isCorrect(question, answers[index] || ''),
      index,
    }));
    const score = answered.filter(item => item.correct).length;
    const wrong = answered.filter(item => !item.correct);

    let feedback = '';
    let plan = '';

    const wrongSummary = wrong
      .map(item => describeWrongQuestion(item.question, item.answer, item.index + 1))
      .join('\n\n');

    try {
      const prompt =
        `Môn học: ${courseName}. Sinh viên vừa hoàn thành check-in ${questions.length} câu hỏi một đáp án (trắc nghiệm A/B/C/D hoặc Đúng/Sai), đúng ${score}/${questions.length}.\n\n` +
        (wrong.length === 0
          ? `Tất cả các câu đều đúng. Hãy viết nhận xét 2-3 câu (tối đa 150 từ) nêu chủ đề cốt lõi sinh viên đã nắm tốt, kèm một gợi ý mở rộng cụ thể.\n\nCÁC CÂU ĐÃ LÀM:\n${questions
              .map((question, index) => `${index + 1}. ${question.q} — đáp án: ${correctAnswerLabel(question)}`)
              .join('\n')}`
          : `Chỉ phân tích các câu CHƯA ĐÚNG dưới đây. Với mỗi câu, hãy nêu chính xác khái niệm bị nhầm, giải thích bản chất của khái niệm đó một cách ngắn gọn, và đưa ra một hành động ôn tập cụ thể. Không lặp lại nguyên văn toàn bộ câu hỏi, không nhận xét chung chung.\n\nCÁC CÂU CHƯA ĐÚNG:\n${wrongSummary}`) +
        `\n\nTrả về JSON duy nhất {"ai_feedback":"...","improvement_plan":"..."}. Tiếng Việt, không markdown. ai_feedback tối đa 180 từ, improvement_plan tối đa 80 từ.`;

      const fb = await askPuterJSON<{ ai_feedback: string; improvement_plan: string }>(prompt, 'gpt-4o-mini');
      feedback = fb.ai_feedback || '';
      plan = fb.improvement_plan || '';
    } catch {
      if (wrong.length === 0) {
        feedback = `Bạn làm đúng cả ${questions.length} câu, thể hiện nền tảng kiến thức nền của ${courseName} đang chắc. Hãy thử một bài nâng cao hoặc một tình huống ứng dụng để mở rộng chủ đề bạn vừa làm tốt.`;
        plan = `Tiếp tục ${courseName} với phần bài tập vận dụng cao hoặc tình huống thực tế liên quan.`;
      } else {
        feedback = `Bạn còn nhầm ${wrong.length}/${questions.length} câu. ${wrong
          .map(item => `Câu ${item.index + 1} ("${shortText(item.question.q, 80)}") — đáp án đúng là ${correctAnswerLabel(item.question)}, bạn chọn ${answerLabel(item.question, item.answer)}.`)
          .join(' ')} Hãy đọc lại phần giải thích của từng câu trước khi học bài mới.`;
        plan = `Ôn lại ${wrong.map(item => shortText(item.question.q, 60)).join('; ')} rồi chuyển sang bài mới của ${courseName}.`;
      }
    }

    setResult({ score, feedback: feedback || 'Hoàn tất check-in.', recommendation: plan });

    // Đánh dấu đã check-in trong phiên này để F5 không kích hoạt lại
    try {
      const raw = sessionStorage.getItem('lms_quick_tested_courses');
      const tested: string[] = raw ? JSON.parse(raw) : [];
      if (!tested.includes(String(courseId ?? ''))) {
        sessionStorage.setItem('lms_quick_tested_courses', JSON.stringify([...tested, String(courseId ?? '')]));
      }
    } catch {
      // ignore
    }

    // Lưu nhận xét vào localStorage (tồn tại đến hết ngày, thay cho bảng Supabase)
    appendFeedbackHistory(idNum, courseIdNum, {
      id: `fb_${Date.now()}`,
      activity_type: 'quick_test',
      score_label: `${score}/${questions.length}`,
      ai_feedback: feedback,
      improvement_plan: plan,
      created_at: new Date().toISOString(),
    });

    // Ghi đè bộ câu hỏi mới cho lần sau (fixed document qt_...)
    try {
      const next = (await generateViaPuter().catch(() => generateViaServer())) || [];
      if (next.length) {
        await fetch('/api/learning-artifacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: idNum,
            userName: 'Sinh viên',
            moodleCourseId: courseIdNum,
            artifactType: 'quick_test',
            contentData: {
              id: docId,
              courseName,
              questions: next,
              answers: {},
              score: 0,
              total: next.length,
              feedback: '',
              recommendation: '',
              completedAt: null,
              regeneratedAt: new Date().toISOString(),
            },
          }),
        });
      }
    } catch {
      // ignore
    }
  };

  const close = () => {
    setResult(null);
    setAnswers({});
    setStep(0);
    setError(null);
    onClose();
  };

  const currentAnswer = answers[step];

  if (!open) return null;

  return (
    <div className="quick-test-overlay" role="dialog" aria-modal="true" aria-labelledby="quick-test-modal-title">
      <section className="quick-test-card">
        <button type="button" className="quick-test-close" onClick={close} aria-label="Đóng"><X size={16} /></button>
        {!result ? (
          <>
            <div className="quick-test-header">
              <span className="quick-test-icon"><Brain size={20} /></span>
              <div>
                <p className="eyebrow">KHÔNG GIAN HỌC TẬP · CHECK-IN</p>
                <h2 id="quick-test-modal-title">3 câu hỏi nhanh</h2>
                <p>{courseName} · sau mỗi lần vào khóa học</p>
              </div>
            </div>
            <div className="quick-test-progress"><i style={{ width: `${progress}%` }} /></div>
            {generating ? (
              <div className="quick-test-loading"><LoaderCircle className="quick-test-spin" size={22} /> Đang chuẩn bị câu hỏi…</div>
            ) : error ? (
              <div className="quick-test-loading">
                <p>{error}</p>
                <div className="quick-test-actions">
                  <button type="button" onClick={loadOrGenerate}>Thử lại</button>
                  <button type="button" onClick={close}>Đóng</button>
                </div>
              </div>
            ) : !currentQuestion ? (
              <div className="quick-test-loading">Không có câu hỏi phù hợp.</div>
            ) : (
              <>
                <div className="quick-test-count"><span>CÂU {step + 1}/{questions.length}</span><span><Clock3 size={13} /> khoảng 1 phút</span></div>
                <h3>{currentQuestion.q}</h3>
                <div className="quick-test-choices">
                  {(currentQuestion.type === 'true_false' ? ['Đúng', 'Sai'] : currentQuestion.choices).map(
                    (choice, index) => (
                      <button
                        type="button"
                        key={`${choice}-${index}`}
                        className={currentAnswer === String(index) ? 'selected' : ''}
                        onClick={() => setAnswers(v => ({ ...v, [step]: String(index) }))}
                      >
                        <span>{currentQuestion.type === 'true_false' ? (index === 0 ? '✓' : '✕') : String.fromCharCode(65 + index)}</span>{choice}
                      </button>
                    ),
                  )}
                </div>
                <div className="quick-test-actions">
                  <span>{step + 1} trên {questions.length}</span>
                  <button
                    type="button"
                    onClick={() => (step < questions.length - 1 ? setStep(v => v + 1) : void finish())}
                    disabled={!canAdvance}
                  >
                    {step < questions.length - 1 ? 'Câu tiếp theo' : 'Xem nhận xét'} <ChevronRight size={15} />
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="quick-test-result">
            <div className="quick-test-result-icon"><CheckCircle2 size={26} /></div>
            <p className="eyebrow">CHECK-IN HOÀN TẤT</p>
            <h2>{result.score}/{questions.length} câu đúng</h2>
            <strong>{result.feedback}</strong>
            <div className="quick-test-recommendation"><Lightbulb size={17} /><span>{result.recommendation}</span></div>
            <button type="button" onClick={close}>Đóng <ChevronRight size={15} /></button>
          </div>
        )}
      </section>
    </div>
  );
}
