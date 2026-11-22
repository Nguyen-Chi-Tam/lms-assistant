'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, CheckCircle2, ChevronRight, Lightbulb, LoaderCircle, Shuffle } from 'lucide-react';
import type { CourseSourceItem } from '@/app/types';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { PlayableAIFeedback } from '@/app/components/playable/PlayableAIFeedback';

export interface BingoCategory {
  id: string;
  label: string;
}

export interface BingoCard {
  id: string;
  term: string;
  validCategoryIds: string[];
  explanation: string;
}

export interface BingoData {
  categories: BingoCategory[];
  cards: BingoCard[];
}

interface BingoGameProps {
  courseId: number | string | undefined;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function fallbackBingoData(courseName: string): BingoData {
  return {
    categories: [
      { id: 'c1', label: 'HTTP Method' },
      { id: 'c2', label: 'Status Code' },
      { id: 'c3', label: 'Cấu trúc dữ liệu' },
      { id: 'c4', label: 'Cơ sở dữ liệu' },
      { id: 'c5', label: 'Bảo mật Web' },
      { id: 'c6', label: 'Frontend' },
      { id: 'c7', label: 'Backend' },
      { id: 'c8', label: 'Giao thức mạng' },
      { id: 'c9', label: 'Định dạng dữ liệu' },
      { id: 'c10', label: 'Kiến trúc phần mềm' },
      { id: 'c11', label: 'Quản lý phiên' },
      { id: 'c12', label: 'Tối ưu hiệu năng' },
    ],
    cards: [
      { id: 'k1', term: 'POST', validCategoryIds: ['c1'], explanation: 'POST là một phương thức HTTP dùng để gửi dữ liệu.' },
      { id: 'k2', term: '404 Not Found', validCategoryIds: ['c2'], explanation: '404 là mã trạng thái HTTP biểu thị không tìm thấy tài nguyên.' },
      { id: 'k3', term: 'B-Tree', validCategoryIds: ['c3', 'c4'], explanation: 'B-Tree là cấu trúc dữ liệu cây tìm kiếm phổ biến trong indexing cơ sở dữ liệu.' },
      { id: 'k4', term: 'PostgreSQL', validCategoryIds: ['c4'], explanation: 'PostgreSQL là hệ quản trị cơ sở dữ liệu quan hệ mã nguồn mở mạnh mẽ.' },
      { id: 'k5', term: 'JWT (JSON Web Token)', validCategoryIds: ['c5', 'c11'], explanation: 'JWT là chuẩn tạo access token dùng xác thực và quản lý phiên.' },
      { id: 'k6', term: 'Virtual DOM', validCategoryIds: ['c6'], explanation: 'Virtual DOM là kỹ thuật tối ưu giao diện nổi tiếng của React.' },
      { id: 'k7', term: 'Node.js Express', validCategoryIds: ['c7'], explanation: 'Express là web framework tối giản chạy trên Node.js backend.' },
      { id: 'k8', term: 'TCP/IP', validCategoryIds: ['c8'], explanation: 'TCP/IP là bộ giao thức truyền thông nền tảng của mạng Internet.' },
      { id: 'k9', term: 'JSON', validCategoryIds: ['c9'], explanation: 'JSON là định dạng chuẩn trao đổi dữ liệu dạng text.' },
      { id: 'k10', term: 'Microservices', validCategoryIds: ['c10'], explanation: 'Microservices là kiến trúc phân rã ứng dụng thành các dịch vụ độc lập.' },
      { id: 'k11', term: 'HTTP Cookie', validCategoryIds: ['c11'], explanation: 'Cookie được lưu ở trình duyệt để duy trì trạng thái phiên đăng nhập.' },
      { id: 'k12', term: 'Redis Caching', validCategoryIds: ['c12', 'c4'], explanation: 'Redis là bộ nhớ in-memory tốc độ cực cao dùng để caching.' },
      { id: 'k13', term: '200 OK', validCategoryIds: ['c2'], explanation: '200 OK biểu thị yêu cầu đã được xử lý thành công.' },
      { id: 'k14', term: 'HTTPS (TLS)', validCategoryIds: ['c5', 'c8'], explanation: 'HTTPS mã hóa đường truyền HTTP bằng giao thức TLS/SSL.' },
    ],
  };
}

export function BingoGame({ courseId, courseName, userId, sources }: BingoGameProps) {
  const [data, setData] = useState<BingoData | null>(null);
  const [queue, setQueue] = useState<BingoCard[]>([]);
  const [matchedMap, setMatchedMap] = useState<Record<string, BingoCard>>({});
  // Bảng đã ghép của ván đã kết thúc; null = ván cũ chưa lưu chi tiết nên không tô màu.
  const [summaryMatched, setSummaryMatched] = useState<Record<string, BingoCard> | null>(null);
  const [status, setStatus] = useState<'generating' | 'playing' | 'summary'>('generating');
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; correct: boolean } | null>(null);
  const [score, setScore] = useState(0);

  const initGame = useCallback((bingoData: BingoData) => {
    setData(bingoData);
    // Xáo trộn thẻ ngay khi bắt đầu để mỗi lượt chơi có thứ tự khác nhau.
    setQueue(shuffle(bingoData.cards));
    setMatchedMap({});
    setSummaryMatched(null);
    setStatus('playing');
    setFeedbackMsg(null);
  }, []);

  const loadOrGenerate = useCallback(async (forceNew = false) => {
    setStatus('generating');

    if (!forceNew) {
      const record = getDailyPlayable<BingoData>(userId, courseId, 'concept_bingo');
      if (record) {
        if (record.status === 'completed' && record.data) {
          setData(record.data);
          // Khôi phục bảng đã ghép để màn kết thúc vẫn tô xanh/đỏ đúng sau khi F5.
          const detail = record.detail as Record<string, BingoCard> | undefined;
          setSummaryMatched(detail && typeof detail === 'object' ? detail : null);
          setScore(record.score ?? 0);
          setStatus('summary');
          return;
        }
        if (record.status === 'in_progress' && record.data) {
          initGame(record.data);
          return;
        }
      }
    }

    let bingoData: BingoData | null = null;
    try {
      const materialContext = buildMaterialContext(sources);
      const res = await generatePlayableData<BingoData>(
        'concept_bingo',
        courseName,
        materialContext,
        Number(userId) || undefined
      );
      if (res?.categories?.length && res?.cards?.length) {
        bingoData = res;
      }
    } catch {
      // fallback
    }

    if (!bingoData) {
      bingoData = fallbackBingoData(courseName);
    }

    saveDailyPlayable(userId, courseId, 'concept_bingo', {
      status: 'in_progress',
      data: bingoData,
    });

    initGame(bingoData);
  }, [courseId, courseName, initGame, sources, userId]);

  useEffect(() => {
    void loadOrGenerate();
  }, [loadOrGenerate]);

  const currentCard = queue[0];

  const handleSelectCategory = (catId: string) => {
    if (!currentCard || status !== 'playing') return;

    const isValid = currentCard.validCategoryIds.includes(catId);
    if (isValid) {
      const newMap = { ...matchedMap, [catId]: currentCard };
      setMatchedMap(newMap);
      setFeedbackMsg({ text: `✓ Chính xác! ${currentCard.term} thuộc nhóm này.`, correct: true });

      // Lấy thẻ tiếp theo và xáo trộn phần còn lại của danh sách
      const nextQueue = shuffle(queue.slice(1));
      setQueue(nextQueue);

      // Nếu đã lấp đủ 12 ô hoặc hết thẻ
      if (Object.keys(newMap).length >= (data?.categories.length || 12) || nextQueue.length === 0) {
        finishGame(Object.keys(newMap).length, newMap);
      }
    } else {
      setFeedbackMsg({
        text: `✕ Chưa đúng! ${currentCard.term}: ${currentCard.explanation}`,
        correct: false,
      });
      // Đẩy thẻ xuống cuối để thử lại sau
      setQueue([...queue.slice(1), currentCard]);
    }

    setTimeout(() => setFeedbackMsg(null), 2500);
  };

  const handleSkip = () => {
    if (queue.length <= 1) return;
    // Xáo trộn các thẻ còn lại, đẩy thẻ hiện tại xuống cuối để không lặp lại ngay.
    setQueue([...shuffle(queue.slice(1)), queue[0]]);
  };

  const finishGame = (finalScoreVal: number, map: Record<string, BingoCard>) => {
    setScore(finalScoreVal);
    setSummaryMatched(map);
    setStatus('summary');

    // Lưu kết quả hoàn thành vào localStorage, không ghi database
    if (data) {
      saveDailyPlayable(userId, courseId, 'concept_bingo', {
        status: 'completed',
        data,
        detail: map,
        score: finalScoreVal,
        maxScore: data.categories.length,
        completedAt: new Date().toISOString(),
      });
    }
  };

  if (status === 'generating' || !data) {
    return (
      <div className="playable-panel">
        <div className="playable-loading">
          <LoaderCircle className="playable-spin" size={22} /> Đang chuẩn bị bàn chơi Bingo phân loại khái niệm…
        </div>
      </div>
    );
  }

  const matchedCount =
    status === 'summary'
      ? summaryMatched
        ? Object.keys(summaryMatched).length
        : score
      : Object.keys(matchedMap).length;

  const aiSessionSummary = [
    `Kết quả: ${score}/${data.categories.length} ô Bingo hoàn tất.`,
    `Các ô đã ghép đúng: ${
      summaryMatched
        ? data.categories
            .map((category) => {
              const card = summaryMatched[category.id];
              return card ? `${category.label} → ${card.term}` : '';
            })
            .filter(Boolean)
            .join('; ') || 'không có'
        : 'không có dữ liệu chi tiết'
    }.`,
    `Các ô chưa ghép: ${
      summaryMatched
        ? data.categories
            .filter((category) => !summaryMatched[category.id])
            .map((category) => category.label)
            .join('; ') || 'không có'
        : 'không có dữ liệu chi tiết'
    }.`,
    `Toàn bộ nhóm tiêu chí: ${data.categories.map((category) => category.label).join('; ')}.`,
  ].join('\n');

  return (
    <div className="playable-panel">
      <div className="playable-header">
        <div className="playable-title">
          <BookOpen size={20} />
          <span>Bingo phân loại 4x3</span>
        </div>
        <div style={{ color: '#fbbf24', fontSize: '13px', fontWeight: 800 }}>
          {matchedCount}/{data.categories.length} ô
        </div>
      </div>

      {status !== 'summary' ? (
        <div className="playable-body">
          <p className="playable-sub">
            {courseName} · Xếp thẻ khái niệm hiện tại vào đúng nhóm tiêu chí trên lưới Bingo
          </p>

          {/* Thẻ khái niệm cần ghép */}
          {currentCard ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(185, 43, 71,0.2), rgba(219,63,138,0.1))',
                border: '1px solid rgba(185, 43, 71,0.4)',
              }}
            >
              <div>
                <span style={{ fontSize: '11px', color: '#b92b47', fontWeight: 800, textTransform: 'uppercase' }}>
                  Thẻ cần phân loại:
                </span>
                <div style={{ fontSize: '17px', fontWeight: 800, color: '#fff', marginTop: '2px' }}>
                  {currentCard.term}
                </div>
              </div>
              <button
                type="button"
                className="playable-btn ghost"
                onClick={handleSkip}
                style={{ flex: '0 0 auto', padding: '6px 12px' }}
              >
                <Shuffle size={14} /> Đổi thẻ khác
              </button>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: '#cbd5e1' }}>Đã hết thẻ bài!</div>
          )}

          {feedbackMsg && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: 1.4,
                background: feedbackMsg.correct ? 'rgba(34,197,94,0.15)' : 'rgba(244,63,94,0.15)',
                border: `1px solid ${feedbackMsg.correct ? 'rgba(34,197,94,0.3)' : 'rgba(244,63,94,0.3)'}`,
                color: feedbackMsg.correct ? '#4ade80' : '#fb7185',
              }}
            >
              {feedbackMsg.text}
            </div>
          )}

          {/* Lưới phân loại 4x3 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '8px',
              marginTop: '0.4rem',
            }}
          >
            {data.categories.map((cat) => {
              const matchedCard = matchedMap[cat.id];
              const isFilled = Boolean(matchedCard);

              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => !isFilled && handleSelectCategory(cat.id)}
                  disabled={isFilled}
                  style={{
                    minHeight: '68px',
                    padding: '8px',
                    borderRadius: '10px',
                    border: `1px solid ${isFilled ? '#22c55e' : 'rgba(255,255,255,0.12)'}`,
                    background: isFilled ? 'rgba(34,197,94,0.18)' : 'rgba(255,255,255,0.04)',
                    color: isFilled ? '#86efac' : '#cbd5e1',
                    fontSize: '12px',
                    fontWeight: 700,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: isFilled ? 'default' : 'pointer',
                    transition: 'all 0.15s ease',
                    textAlign: 'center',
                  }}
                >
                  <span style={{ fontSize: '11px', color: isFilled ? '#4ade80' : '#b92b47', fontWeight: 800 }}>
                    {cat.label}
                  </span>
                  {matchedCard ? (
                    <span style={{ fontSize: '12.5px', color: '#fff', marginTop: '4px', fontWeight: 800 }}>
                      ✓ {matchedCard.term}
                    </span>
                  ) : (
                    <span style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>[Trống]</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="playable-actions" style={{ marginTop: '0.6rem' }}>
            <button
              type="button"
              className="playable-btn primary"
              onClick={() => finishGame(matchedCount, matchedMap)}
            >
              Nộp bài ({matchedCount}/{data.categories.length} ô) <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div className="playable-summary">
          <div className="playable-summary-icon">
            <CheckCircle2 size={26} />
          </div>
          <p className="playable-eyebrow">KẾT QUẢ BINGO HÔM NAY</p>
          <h2>
            {score}/{data.categories.length} ô Bingo hoàn tất
          </h2>
          <div className="playable-ai-feedback">
            <Lightbulb size={17} />
            <span>
              {score >= data.categories.length
                ? 'Xuất sắc! Bạn đã lấp đầy 100% bảng Bingo phân loại khái niệm.'
                : `Bạn đã phân loại chính xác ${score}/${data.categories.length} ô khái niệm.`}
            </span>
          </div>

          <PlayableAIFeedback
            courseId={courseId}
            courseName={courseName}
            userId={userId}
            activityType="concept_bingo"
            activityLabel="Bingo phân loại"
            score={score}
            total={data.categories.length}
            sessionSummary={aiSessionSummary}
          />

          <div className="playable-review">
            <span className="playable-mistake-label">Chi tiết bảng phân loại (xanh = đã ghép, đỏ = chưa ghép):</span>
            <div className="playable-review-list">
              {data.categories.map((cat) => {
                const c = summaryMatched ? summaryMatched[cat.id] : undefined;
                const known = summaryMatched !== null;
                const state = !known ? 'unknown' : c ? 'filled' : 'empty';
                return (
                  <div key={cat.id} className={`bingo-review-item ${state}`}>
                    {known && (
                      <span className="bingo-review-tag">{c ? '✓ Đã ghép' : '✕ Chưa ghép'}</span>
                    )}
                    <span>
                      <strong style={{ color: !known ? '#b92b47' : c ? '#4ade80' : '#fb7185' }}>
                        {cat.label}:
                      </strong>{' '}
                      {c ? (
                        `${c.term} — ${c.explanation}`
                      ) : (
                        <span style={{ color: '#94a3b8' }}>Chưa ghép</span>
                      )}
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
