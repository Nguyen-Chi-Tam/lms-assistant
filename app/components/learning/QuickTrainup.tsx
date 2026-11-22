'use client';

import { useEffect, useState } from 'react';
import { defaultQuiz } from '@/app/mock-data';
import type { QuizQuestion, QuizResponse } from '@/app/types';

export function QuickTrainup({ notify }: { notify: (s: string) => void }) {
  const [questions, setQuestions] = useState<QuizQuestion[]>(defaultQuiz);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [saved, setSaved] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(0);

  const generate = async () => {
    setLoading(true);
    setDone(false);
    setStep(0);
    setAnswers([]);
    setSaved(false);
    setStartedAt(() => Date.now());
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: 'Kiến thức tổng hợp',
          count: 5,
        }),
      });
      const data = (await res.json()) as QuizResponse;
      if (!res.ok) throw new Error(data.error);
      if (data.questions) setQuestions(data.questions);
      notify(data.mode === 'ai' ? 'Đã tạo quiz mới bằng AI' : 'Đã tạo quiz luyện tập');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Không thể tạo quiz');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void generate();
  }, []);

  const choose = (n: number) => {
    const a = [...answers];
    a[step] = n;
    setAnswers(a);
  };

  const score = answers.filter((a, i) => a === questions[i]?.answer).length;

  const finish = async () => {
    setDurationMinutes(Math.max(1, Math.round((Date.now() - startedAt) / 60000)));
    setDone(true);
    const duration = Math.round((Date.now() - startedAt) / 1000);
    try {
      const res = await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseCode: 'QUIZ',
          topic: 'Kiến thức tổng hợp',
          score,
          total: questions.length,
          durationSeconds: duration,
        }),
      });
      if (res.ok) setSaved(true);
    } catch {
      // offline progress
    }
  };

  const next = () => {
    if (step < questions.length - 1) setStep(step + 1);
    else void finish();
  };

  if (done) {
    return (
      <div className="workspace-page fade-in">
        <div className="result-card">
          <div className="result-ring">
            <span>
              {score}/{questions.length}
            </span>
          </div>
          <p className="eyebrow">HOÀN THÀNH BÀI LUYỆN</p>
          <h1>{score === questions.length ? 'Kết quả tốt' : 'Kết quả trung bình'}</h1>
          <p>Bạn trả lời đúng {score}/{questions.length} câu.</p>

          <div className="result-stats">
            <div>
              <b>{Math.round((score / questions.length) * 100)}%</b>
              <small>Chính xác</small>
            </div>
            <div>
              <b>{durationMinutes} phút</b>
              <small>Thời gian</small>
            </div>
            <div>
              <b>+{score * 10}</b>
              <small>XP nhận được</small>
            </div>
          </div>

          <div className="save-result">
            {saved ? '✓ Kết quả đã lưu vào tiến độ' : 'Kết quả hiển thị cục bộ'}
          </div>
          <button onClick={() => void generate()}>Tạo bài mới</button>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-page fade-in">
      <div className="workspace-title">
        <div>
          <p className="eyebrow">QUIZ DO AI TẠO</p>
          <h1>Luyện tập trước kỳ thi</h1>
          <p>Câu hỏi trắc nghiệm tạo từ tài liệu học tập của bạn.</p>
        </div>
        <button className="primary-action" onClick={() => void generate()} disabled={loading}>
          ✦ {loading ? 'Đang tạo…' : 'Tạo bộ câu hỏi mới'}
        </button>
      </div>

      <div className="quiz-layout">
        <aside className="quiz-info">
          <div className="quiz-icon">◎</div>
          <h2>Bộ câu hỏi trắc nghiệm</h2>
          <p>{questions.length} câu · Khoảng 5 phút</p>
          <div className="quiz-progress">
            <i style={{ width: `${((step + 1) / questions.length) * 100}%` }} />
          </div>
          <small>
            Tiến độ {step + 1}/{questions.length}
          </small>
          <hr />
          <div className="practice-note">ⓘ Bài tự luyện không tính vào điểm Moodle.</div>
        </aside>

        <section className="question-card">
          {loading ? (
            <div className="artifact-loading">
              <span className="bot-avatar">✦</span>
              <h3>AI đang tạo câu hỏi…</h3>
            </div>
          ) : (
            <>
              <div className="question-count">
                <span>
                  CÂU {step + 1} / {questions.length}
                </span>
                <small>CHỌN MỘT ĐÁP ÁN</small>
              </div>
              <h2>{questions[step]?.q}</h2>

              <div className="choices">
                {questions[step]?.choices?.map((c, i) => (
                  <button key={c} className={answers[step] === i ? 'chosen' : ''} onClick={() => choose(i)}>
                    <b>{String.fromCharCode(65 + i)}</b>
                    <span>{c}</span>
                    <i>{answers[step] === i ? '✓' : ''}</i>
                  </button>
                ))}
              </div>

              <div className="question-actions">
                <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
                  ← Quay lại
                </button>
                <button className="next" onClick={next} disabled={answers[step] === undefined}>
                  {step === questions.length - 1 ? 'Hoàn thành' : 'Câu tiếp theo'} →
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
