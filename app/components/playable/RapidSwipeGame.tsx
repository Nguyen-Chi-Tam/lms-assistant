'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock3, Lightbulb, LoaderCircle, RefreshCw } from 'lucide-react';
import type { CourseSourceItem } from '@/app/types';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { PlayableAIFeedback } from '@/app/components/playable/PlayableAIFeedback';

export interface RapidSwipeCard {
  id: string;
  statement: string;
  isTrue: boolean;
  explanation: string;
}

/** Lựa chọn của người chơi cho từng thẻ, lưu kèm ván để màn kết thúc tô đúng/sai */
interface RapidSwipeResponse {
  index: number;
  saidTrue: boolean;
}

interface RapidSwipeGameProps {
  courseId: number | string | undefined;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
}

const CARD_COUNT = 12;
const TIME_LIMIT = 30;

function shuffle<T>(array: T[]): T[] {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function fallbackCards(courseName: string): RapidSwipeCard[] {
  return [
    { id: 'fb-0', statement: 'Phương thức GET dùng để lấy dữ liệu từ server mà không làm thay đổi trạng thái tài nguyên.', isTrue: true, explanation: 'GET là phương thức idempotent và an toàn để truy xuất dữ liệu.' },
    { id: 'fb-1', statement: 'Phương thức POST dùng để xóa hoàn toàn một tài nguyên trên hệ thống.', isTrue: false, explanation: 'DELETE mới là phương thức dùng để xóa tài nguyên; POST dùng để tạo mới hoặc gửi dữ liệu xử lý.' },
    { id: 'fb-2', statement: 'JSON là định dạng trao đổi dữ liệu dạng văn bản nhẹ, độc lập với ngôn ngữ lập trình.', isTrue: true, explanation: 'JSON được hỗ trợ nguyên bản trong hầu hết các ngôn ngữ hiện đại.' },
    { id: 'fb-3', statement: 'Mã HTTP status 404 có nghĩa là máy chủ gặp sự cố nội bộ không thể xử lý.', isTrue: false, explanation: '404 là Not Found (không tìm thấy); 500 mới là lỗi máy chủ nội bộ (Internal Server Error).' },
    { id: 'fb-4', statement: 'Từ khóa const trong JavaScript ngăn chặn việc gán lại định danh biến.', isTrue: true, explanation: 'const tạo liên kết cố định không thể tái chỉ định giá trị mới.' },
    { id: 'fb-5', statement: 'Giao thức HTTP là giao thức có lưu trữ trạng thái phiên mặc định giữa các request.', isTrue: false, explanation: 'HTTP bản chất là stateless; để lưu trạng thái người ta dùng cookie, session hoặc token.' },
    { id: 'fb-6', statement: 'Cơ chế CORS do trình duyệt thực thi nhằm bảo vệ người dùng khỏi các yêu cầu trái phép giữa các origin.', isTrue: true, explanation: 'CORS là chính sách bảo mật phía client (trình duyệt).' },
    { id: 'fb-7', statement: 'Chỉ số Index trong cơ sở dữ liệu luôn làm tăng tốc độ của cả thao tác đọc lẫn ghi dữ liệu.', isTrue: false, explanation: 'Index tăng tốc độ đọc nhưng làm chậm thao tác ghi (INSERT/UPDATE/DELETE) do phải cập nhật cây chỉ mục.' },
    { id: 'fb-8', statement: 'RESTful API thường sử dụng các mã HTTP status chuẩn để báo cáo kết quả thực thi.', isTrue: true, explanation: 'REST tận dụng các mã 2xx, 4xx, 5xx để biểu thị kết quả yêu cầu.' },
    { id: 'fb-9', statement: 'Bộ nhớ đệm (Cache) giúp giảm tải cho server và rút ngắn thời gian phản hồi cho client.', isTrue: true, explanation: 'Cache lưu kết quả tạm thời ở RAM hoặc CDN để phục vụ nhanh chóng.' },
    { id: 'fb-10', statement: 'Mô hình MVC chia ứng dụng thành 3 thành phần: Module, View và Component.', isTrue: false, explanation: 'MVC là Model - View - Controller.' },
    { id: 'fb-11', statement: 'Mã hóa một chiều (hashing) như bcrypt thích hợp dùng để lưu trữ mật khẩu người dùng.', isTrue: true, explanation: 'Hash không thể giải mã ngược trực tiếp nên rất an toàn cho mật khẩu.' },
  ];
}

export function RapidSwipeGame({ courseId, courseName, userId, sources }: RapidSwipeGameProps) {
  const [cards, setCards] = useState<RapidSwipeCard[]>([]);
  const [cardIndex, setCardIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(TIME_LIMIT);
  const [score, setScore] = useState(0);
  const [responses, setResponses] = useState<RapidSwipeResponse[]>([]);
  // null = ván cũ chưa lưu chi tiết từng câu, không tô màu để tránh báo sai toàn bộ.
  const [summaryAnswers, setSummaryAnswers] = useState<RapidSwipeResponse[] | null>(null);
  const [status, setStatus] = useState<'generating' | 'playing' | 'summary'>('generating');
  const [feedbackFlash, setFeedbackFlash] = useState<'correct' | 'wrong' | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Gesture handling
  const pointerStartX = useRef<number | null>(null);

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const finishGame = useCallback((finalScoreVal: number, items: RapidSwipeCard[], finalResponses: RapidSwipeResponse[]) => {
    stopTimer();
    setScore(finalScoreVal);
    setSummaryAnswers(finalResponses);
    setStatus('summary');

    // Lưu hoàn thành vào localStorage, không ghi database
    saveDailyPlayable(userId, courseId, 'rapid_swipe', {
      status: 'completed',
      data: items,
      detail: { responses: finalResponses },
      score: finalScoreVal,
      maxScore: items.length,
      completedAt: new Date().toISOString(),
    });
  }, [courseId, userId]);

  const initGame = useCallback((items: RapidSwipeCard[]) => {
    setCards(items);
    setCardIndex(0);
    setTimeLeft(TIME_LIMIT);
    setScore(0);
    setResponses([]);
    setSummaryAnswers(null);
    setStatus('playing');
    setFeedbackFlash(null);

    stopTimer();
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          stopTimer();
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }, []);

  const loadOrGenerate = useCallback(async (forceNew = false) => {
    setStatus('generating');

    if (!forceNew) {
      const record = getDailyPlayable<RapidSwipeCard[]>(userId, courseId, 'rapid_swipe');
      if (record) {
        if (record.status === 'completed') {
          setCards(record.data || []);
          const detail = record.detail as { responses?: RapidSwipeResponse[] } | undefined;
          setSummaryAnswers(Array.isArray(detail?.responses) ? detail.responses : null);
          setScore(record.score ?? 0);
          setStatus('summary');
          return;
        }
        if (record.status === 'in_progress' && record.data?.length) {
          initGame(record.data);
          return;
        }
      }
    }

    let items: RapidSwipeCard[] = [];
    try {
      const materialContext = buildMaterialContext(sources);
      const res = await generatePlayableData<{ cards: Array<{ id: string; statement: string; isTrue: boolean; explanation?: string }> }>(
        'rapid_swipe',
        courseName,
        materialContext,
        Number(userId) || undefined
      );
      if (res?.cards?.length) {
        items = res.cards.slice(0, CARD_COUNT).map((c, i) => ({
          id: c.id || `card-${i}`,
          statement: c.statement,
          isTrue: Boolean(c.isTrue),
          explanation: c.explanation || '',
        }));
      }
    } catch {
      // fallback
    }

    if (!items.length) {
      items = shuffle(fallbackCards(courseName));
    } else {
      items = shuffle(items);
    }

    saveDailyPlayable(userId, courseId, 'rapid_swipe', {
      status: 'in_progress',
      data: items,
    });

    initGame(items);
  }, [courseId, courseName, initGame, sources, userId]);

  useEffect(() => {
    void loadOrGenerate();
    return stopTimer;
  }, [loadOrGenerate]);

  // Check timeout
  useEffect(() => {
    if (timeLeft === 0 && status === 'playing') {
      finishGame(score, cards, responses);
    }
  }, [timeLeft, status, score, cards, responses, finishGame]);

  const handleAnswer = useCallback((saidTrue: boolean) => {
    if (status !== 'playing' || cardIndex >= cards.length) return;
    const currentCard = cards[cardIndex];
    const isCorrect = saidTrue === currentCard.isTrue;

    setFeedbackFlash(isCorrect ? 'correct' : 'wrong');
    setTimeout(() => setFeedbackFlash(null), 350);

    const nextScore = isCorrect ? score + 1 : score;
    if (isCorrect) {
      setScore(nextScore);
    }

    const nextResponses = [...responses, { index: cardIndex, saidTrue }];
    setResponses(nextResponses);

    const nextIdx = cardIndex + 1;
    if (nextIdx >= cards.length) {
      finishGame(nextScore, cards, nextResponses);
    } else {
      setCardIndex(nextIdx);
    }
  }, [cardIndex, cards, finishGame, responses, score, status]);

  // Phím tắt bàn phím mũi tên Trái (Sai) / Phải (Đúng)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (status !== 'playing') return;
      if (e.key === 'ArrowLeft') {
        handleAnswer(false);
      } else if (e.key === 'ArrowRight') {
        handleAnswer(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleAnswer, status]);

  const handlePointerDown = (e: React.PointerEvent) => {
    pointerStartX.current = e.clientX;
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (pointerStartX.current === null) return;
    const diff = e.clientX - pointerStartX.current;
    pointerStartX.current = null;
    if (diff > 60) {
      handleAnswer(true); // Quẹt phải -> Đúng
    } else if (diff < -60) {
      handleAnswer(false); // Quẹt trái -> Sai
    }
  };

  if (status === 'generating') {
    return (
      <div className="playable-panel">
        <div className="playable-loading">
          <LoaderCircle className="playable-spin" size={22} /> Đang chuẩn bị 12 thẻ quẹt Đúng/Sai…
        </div>
      </div>
    );
  }

  const currentCard = cards[cardIndex];

  const feedbackText =
    score >= 10
      ? `Phản xạ siêu tốc! Bạn trả lời đúng ${score}/${cards.length} mệnh đề.`
      : score >= 7
      ? `Khá nhạy bén! Bạn đã phán đoán đúng ${score}/${cards.length} nhận định.`
      : `Bạn đúng ${score}/${cards.length} câu. Hãy đọc phần giải thích các nhận định sai bên dưới để tránh bẫy lý thuyết.`;

  // null = ván cũ chưa lưu chi tiết, không tô màu đúng/sai.
  const answerByIndex = summaryAnswers
    ? new Map(summaryAnswers.map((r) => [r.index, r.saidTrue]))
    : null;

  const aiSessionSummary = [
    `Kết quả: ${score}/${cards.length} câu đúng, còn ${timeLeft}s.`,
    ...cards.map((card, i) => {
      const userSaid = answerByIndex?.get(i);
      const answered = answerByIndex !== null && userSaid !== undefined;
      const isRight = answered && userSaid === card.isTrue;
      return [
        `Câu ${i + 1}: ${card.statement}`,
        `- Đáp án đúng: ${card.isTrue ? 'ĐÚNG' : 'SAI'}`,
        `- Bạn chọn: ${answered ? (userSaid ? 'ĐÚNG' : 'SAI') : 'chưa trả lời'}`,
        `- Kết quả: ${answered ? (isRight ? 'đúng' : 'sai') : 'chưa trả lời'}`,
        `- Giải thích: ${card.explanation}`,
      ].join('\n');
    }),
  ].join('\n\n');

  return (
    <div className="playable-panel">
      <div className="playable-header">
        <div className="playable-title">
          <RefreshCw size={19} />
          <span>Thẻ quẹt Đúng/Sai 30s</span>
        </div>
        <div className="playable-timer">
          <Clock3 size={16} /> {timeLeft}s
        </div>
      </div>

      {status !== 'summary' && currentCard ? (
        <div className="playable-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="playable-sub">Quẹt Trái = SAI | Quẹt Phải = ĐÚNG (hoặc bấm nút)</span>
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#b92b47' }}>
              {cardIndex + 1}/{cards.length}
            </span>
          </div>

          <div
            className="playable-card"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            style={{ cursor: 'grab', userSelect: 'none', touchAction: 'pan-y' }}
          >
            {feedbackFlash && (
              <div className={`playable-flash ${feedbackFlash}`}>
                {feedbackFlash === 'correct' ? 'CHÍNH XÁC!' : 'SAI RỒI!'}
              </div>
            )}
            <div className={`playable-card-face ${feedbackFlash || ''}`}>
              <div className="playable-card-tag">Mệnh đề nhận định</div>
              <p className="playable-card-statement">{currentCard.statement}</p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '0.4rem' }}>
            <button
              type="button"
              style={{
                padding: '12px',
                borderRadius: '12px',
                border: '1px solid rgba(244,63,94,0.4)',
                background: 'rgba(244,63,94,0.15)',
                color: '#fda4af',
                fontSize: '15px',
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}
              onClick={() => handleAnswer(false)}
            >
              ✕ SAI (Trái)
            </button>
            <button
              type="button"
              style={{
                padding: '12px',
                borderRadius: '12px',
                border: '1px solid rgba(34,197,94,0.4)',
                background: 'rgba(34,197,94,0.15)',
                color: '#86efac',
                fontSize: '15px',
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}
              onClick={() => handleAnswer(true)}
            >
              ✓ ĐÚNG (Phải)
            </button>
          </div>
        </div>
      ) : (
        <div className="playable-summary">
          <div className="playable-summary-icon">
            <CheckCircle2 size={26} />
          </div>
          <p className="playable-eyebrow">TỔNG KẾT PHẢN XẠ NHANH</p>
          <h2>
            {score}/{cards.length} câu đúng ({timeLeft}s còn lại)
          </h2>
          <div className="playable-ai-feedback">
            <Lightbulb size={17} />
            <span>{feedbackText}</span>
          </div>

          <PlayableAIFeedback
            courseId={courseId}
            courseName={courseName}
            userId={userId}
            activityType="rapid_swipe"
            activityLabel="Thẻ quẹt Đúng/Sai 30s"
            score={score}
            total={cards.length}
            sessionSummary={aiSessionSummary}
          />

          <div className="playable-review">
            <span className="playable-mistake-label">Chi tiết nhận định (xanh = bạn đúng, đỏ = bạn sai):</span>
            <div className="playable-review-list">
              {cards.map((c, i) => {
                const userSaid = answerByIndex?.get(i);
                const answered = answerByIndex !== null && userSaid !== undefined;
                const isRight = answered && userSaid === c.isTrue;
                const state = !answered ? 'unknown' : isRight ? 'correct' : 'wrong';
                return (
                  <div key={c.id || i} className={`swipe-review-item ${state}`}>
                    <div className="swipe-review-title">
                      {i + 1}. {c.statement}
                    </div>
                    <div className="swipe-review-meta">
                      <span className="swipe-truth">{c.isTrue ? 'ĐÚNG' : 'SAI'}</span>
                      {answered && (
                        <span className={`swipe-user ${isRight ? 'right' : 'wrong'}`}>
                          Bạn chọn: {userSaid ? 'ĐÚNG' : 'SAI'} {isRight ? '✓' : '✕'}
                        </span>
                      )}
                      {answerByIndex !== null && !answered && (
                        <span className="swipe-user unknown">Chưa trả lời</span>
                      )}
                      {c.explanation && <span className="swipe-review-exp">{c.explanation}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
