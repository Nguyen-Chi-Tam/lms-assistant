'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock3, ChevronRight, Lightbulb, LoaderCircle, Shuffle } from 'lucide-react';
import type { CourseSourceItem } from '@/app/types';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { PlayableAIFeedback } from '@/app/components/playable/PlayableAIFeedback';

export interface SpeedMatchingItem {
  id: string;
  left: string;
  right: string;
}

/** Kết quả từng ván để màn tổng kết tô xanh cặp đã nối đúng và đỏ cặp còn thiếu */
interface SpeedMatchRoundResult {
  matchedPairIds: string[];
  mistakes: Array<{ left: string; right: string }>;
}

interface SpeedMatchingGameProps {
  courseId: number | string | undefined;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
}

type Sel = { pairId: string; value: string } | null;

const PAIR_COUNT = 8;
const TIME_LIMIT = 45;

function fallbackPairs(courseName: string): SpeedMatchingItem[] {
  const base = [
    ['GET', 'Lấy dữ liệu từ server'],
    ['POST', 'Gửi dữ liệu tạo mới'],
    ['PUT', 'Cập nhật toàn bộ tài nguyên'],
    ['DELETE', 'Xóa tài nguyên'],
    ['PATCH', 'Cập nhật phần tài nguyên'],
    ['200 OK', 'Thành công'],
    ['201 Created', 'Đã tạo thành công'],
    ['404 Not Found', 'Không tìm thấy'],
  ];
  return base.map(([left, right], i) => ({ id: `fb-${i}`, left, right }));
}

export function SpeedMatchingGame({ courseId, courseName, userId, sources }: SpeedMatchingGameProps) {
  const [pairs, setPairs] = useState<SpeedMatchingItem[]>([]);
  const [leftPool, setLeftPool] = useState<Array<{ value: string; pairId: string }>>([]);
  const [rightPool, setRightPool] = useState<Array<{ value: string; pairId: string }>>([]);
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [selLeft, setSelLeft] = useState<Sel>(null);
  const [selRight, setSelRight] = useState<Sel>(null);
  const [mistakes, setMistakes] = useState<Array<{ left: string; right: string }>>([]);
  const [timeLeft, setTimeLeft] = useState(TIME_LIMIT);
  const [status, setStatus] = useState<'generating' | 'playing' | 'won' | 'lost' | 'summary'>('generating');
  const [finalScore, setFinalScore] = useState<number>(0);
  const [roundResult, setRoundResult] = useState<SpeedMatchRoundResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearSelections = () => {
    setSelLeft(null);
    setSelRight(null);
  };

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const initGameWithPairs = useCallback((items: SpeedMatchingItem[]) => {
    setPairs(items);
    setLeftPool(items.map((p) => ({ value: p.left, pairId: p.id })).sort(() => Math.random() - 0.5));
    setRightPool(items.map((p) => ({ value: p.right, pairId: p.id })).sort(() => Math.random() - 0.5));
    setMatched(new Set());
    setMistakes([]);
    setTimeLeft(TIME_LIMIT);
    setStatus('playing');
    stopTimer();
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          stopTimer();
          setStatus('lost');
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }, []);

  const loadOrGenerate = useCallback(async (forceNew = false) => {
    setStatus('generating');

    // 1. Kiểm tra Daily Record nếu không ép tạo mới
    if (!forceNew) {
      const record = getDailyPlayable<SpeedMatchingItem[]>(userId, courseId, 'speed_matching');
      if (record) {
        if (record.status === 'completed') {
          setPairs(record.data || []);
          setRoundResult((record.detail as SpeedMatchRoundResult | undefined) ?? null);
          setFinalScore(record.score ?? record.data?.length ?? 0);
          setStatus('summary');
          return;
        }
        if (record.status === 'in_progress' && record.data?.length) {
          initGameWithPairs(record.data);
          return;
        }
      }
    }

    // 2. Sinh dữ liệu 1-pass qua Puter
    let items: SpeedMatchingItem[] = [];
    try {
      const materialContext = buildMaterialContext(sources);
      const res = await generatePlayableData<{ pairs: SpeedMatchingItem[] }>(
        'speed_matching',
        courseName,
        materialContext,
        Number(userId) || undefined
      );
      if (res?.pairs?.length) {
        items = res.pairs
          .filter((pair) => pair?.left?.trim() && pair?.right?.trim())
          .slice(0, PAIR_COUNT)
          .map((pair, index) => ({
            id: `pair-${index}`,
            left: pair.left.trim(),
            right: pair.right.trim(),
          }));
      }
    } catch {
      // fallback
    }

    if (!items.length) {
      items = fallbackPairs(courseName);
    }

    // Lưu ngay trạng thái in_progress để F5 không mất lượt
    saveDailyPlayable(userId, courseId, 'speed_matching', {
      status: 'in_progress',
      data: items,
    });

    initGameWithPairs(items);
  }, [courseId, courseName, initGameWithPairs, sources, userId]);

  useEffect(() => {
    void loadOrGenerate();
    return stopTimer;
  }, [loadOrGenerate]);

  useEffect(() => {
    if (matched.size >= pairs.length && pairs.length > 0 && status === 'playing') {
      stopTimer();
      setStatus('won');
    }
  }, [matched, pairs.length, status]);

  // Hiển thị toàn bộ cặp cùng lúc; cặp đã nối vẫn giữ nguyên vị trí và tô xanh
  // để bàn chơi không bị xáo trộn giữa chừng.
  const leftItems = leftPool;
  const rightItems = rightPool;

  const handleTap = (side: 'left' | 'right', item: { pairId: string; value: string }) => {
    if (status !== 'playing' || matched.has(item.pairId)) return;

    if (side === 'left') {
      setSelLeft({ pairId: item.pairId, value: item.value });
      if (selRight) {
        if (selRight.pairId === item.pairId) {
          setMatched((m) => new Set(m).add(item.pairId));
        } else {
          setMistakes((m) => [...m, { left: item.value, right: selRight.value }]);
          setTimeLeft((t) => Math.max(0, t - 2));
        }
        clearSelections();
      }
    } else {
      setSelRight({ pairId: item.pairId, value: item.value });
      if (selLeft) {
        if (selLeft.pairId === item.pairId) {
          setMatched((m) => new Set(m).add(item.pairId));
        } else {
          setMistakes((m) => [...m, { left: selLeft.value, right: item.value }]);
          setTimeLeft((t) => Math.max(0, t - 2));
        }
        clearSelections();
      }
    }
  };

  const finish = () => {
    stopTimer();
    const score = matched.size;
    const result: SpeedMatchRoundResult = {
      matchedPairIds: Array.from(matched),
      mistakes,
    };
    setFinalScore(score);
    setRoundResult(result);
    setStatus('summary');

    // Lưu hoàn thành vào localStorage theo đúng guide, skip backend db
    saveDailyPlayable(userId, courseId, 'speed_matching', {
      status: 'completed',
      data: pairs,
      detail: result,
      score,
      maxScore: pairs.length,
      completedAt: new Date().toISOString(),
    });
  };

  if (status === 'generating') {
    return (
      <div className="playable-panel">
        <div className="playable-loading">
          <LoaderCircle className="playable-spin" size={22} /> Đang chuẩn bị câu hỏi nối cặp từ tài liệu…
        </div>
      </div>
    );
  }

  const feedbackText =
    finalScore === pairs.length
      ? `Xuất sắc! Bạn đã nối chính xác toàn bộ ${pairs.length}/${pairs.length} cặp khái niệm.`
      : finalScore >= Math.floor(pairs.length * 0.7)
      ? `Khá tốt! Bạn đã nối đúng ${finalScore}/${pairs.length} cặp khái niệm.`
      : `Bạn đã nối đúng ${finalScore}/${pairs.length} cặp. Hãy xem lại các cặp chưa khớp bên dưới để ghi nhớ sâu hơn.`;

  const recommendationText =
    finalScore === pairs.length
      ? `Bạn đã nắm chắc phản xạ từ khóa của ${courseName}. Hãy chuyển sang các trò chơi thử thách cao hơn.`
      : `Dành 2 phút đọc lại các thuật ngữ nhầm lẫn và hoàn thành lượt chơi vào ngày mai.`;

  // null = ván cũ chưa lưu chi tiết, hiển thị trung tính thay vì báo sai toàn bộ
  const matchedIds = roundResult ? new Set(roundResult.matchedPairIds) : null;

  const aiSessionSummary = [
    `Kết quả: ${finalScore}/${pairs.length} cặp đúng.`,
    `Các cặp đã nối đúng: ${
      matchedIds
        ? pairs
            .filter((pair) => matchedIds.has(pair.id))
            .map((pair) => `${pair.left} → ${pair.right}`)
            .join('; ') || 'không có'
        : 'không có dữ liệu chi tiết'
    }.`,
    `Các cặp chưa nối đúng: ${
      matchedIds
        ? pairs
            .filter((pair) => !matchedIds.has(pair.id))
            .map((pair) => `${pair.left} → ${pair.right}`)
            .join('; ') || 'không có'
        : 'không có dữ liệu chi tiết'
    }.`,
    `Các lần ghép sai: ${
      roundResult?.mistakes?.length
        ? roundResult.mistakes.map((mistake) => `${mistake.left} ✕ ${mistake.right}`).join('; ')
        : 'không có'
    }.`,
  ].join('\n');

  return (
    <div className="playable-panel">
      <div className="playable-header">
        <div className="playable-title">
          <Shuffle size={20} />
          <span>Nối cặp tốc độ</span>
        </div>
        <div className="playable-timer">
          <Clock3 size={16} /> {timeLeft}s
        </div>
      </div>

      {status !== 'summary' ? (
        <div className="playable-body">
          <p className="playable-sub">
            {courseName} · Nối đúng các cặp thuật ngữ và định nghĩa trước khi hết giờ (sai trừ 2s) · Đã nối{' '}
            {matched.size}/{pairs.length}
          </p>
          <div className="playable-grid">
            <div className="playable-column">
              <span className="playable-col-label">Thuật ngữ</span>
              {leftItems.map((item) => {
                const isMatched = matched.has(item.pairId);
                const isSelected = selLeft?.pairId === item.pairId;
                return (
                  <button
                    key={`left-${item.pairId}`}
                    type="button"
                    className={`playable-token ${isMatched ? 'matched' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleTap('left', item)}
                    disabled={isMatched}
                  >
                    {item.value}
                  </button>
                );
              })}
            </div>
            <div className="playable-column">
              <span className="playable-col-label">Định nghĩa</span>
              {rightItems.map((item) => {
                const isMatched = matched.has(item.pairId);
                const isSelected = selRight?.pairId === item.pairId;
                return (
                  <button
                    key={`right-${item.pairId}`}
                    type="button"
                    className={`playable-token ${isMatched ? 'matched' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleTap('right', item)}
                    disabled={isMatched}
                  >
                    {item.value}
                  </button>
                );
              })}
            </div>
          </div>

          {mistakes.length > 0 && (
            <div className="playable-mistakes">
              <span className="playable-mistake-label">Lệch cặp ({mistakes.length}):</span>
              {mistakes.slice(-3).map((m, i) => (
                <span key={i} className="playable-mistake-chip">
                  {m.left} ✕ {m.right}
                </span>
              ))}
            </div>
          )}

          <div className="playable-actions">
            {(status === 'won' || status === 'lost' || matched.size === pairs.length) && (
              <button type="button" className="playable-btn primary" onClick={finish}>
                Xem kết quả <ChevronRight size={15} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="playable-summary">
          <div className="playable-summary-icon">
            <CheckCircle2 size={26} />
          </div>
          <p className="playable-eyebrow">KẾT QUẢ HÔM NAY</p>
          <h2>
            {finalScore}/{pairs.length} cặp đúng
          </h2>
          <div className="playable-ai-feedback">
            <Lightbulb size={17} />
            <span>{feedbackText}</span>
          </div>
          <div className="playable-recommendation">
            <Lightbulb size={17} />
            <span>{recommendationText}</span>
          </div>

          <PlayableAIFeedback
            courseId={courseId}
            courseName={courseName}
            userId={userId}
            activityType="speed_matching"
            activityLabel="Nối cặp tốc độ"
            score={finalScore}
            total={pairs.length}
            sessionSummary={aiSessionSummary}
          />

          {/* Hiển thị bảng tra cứu đáp án đầy đủ, tô xanh cặp đã nối đúng và đỏ cặp còn thiếu */}
          <div className="playable-review">
            <span className="playable-mistake-label">Bảng tra cứu thuật ngữ:</span>
            <div className="playable-review-list">
              {pairs.map((p) => {
                const state = matchedIds ? (matchedIds.has(p.id) ? 'matched' : 'missed') : 'unknown';
                return (
                  <div key={p.id} className={`speed-review-item ${state}`}>
                    {state !== 'unknown' && (
                      <span className="speed-review-tag">
                        {state === 'matched' ? '✓ Đúng' : '✕ Chưa khớp'}
                      </span>
                    )}
                    <span>
                      <strong style={{ color: state === 'missed' ? '#fb7185' : '#b92b47' }}>{p.left}:</strong>{' '}
                      {p.right}
                    </span>
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
