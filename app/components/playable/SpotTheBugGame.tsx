'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bug, CheckCircle2, ChevronRight, Lightbulb, LoaderCircle } from 'lucide-react';
import type { CourseSourceItem } from '@/app/types';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { PlayableAIFeedback } from '@/app/components/playable/PlayableAIFeedback';

export interface SpotTheBugChallenge {
  prompt: string;
  tokens: string[];
  bugIndex: number;
  fixOptions: string[];
  correctFixIndex: number;
  explanation: string;
}

interface SpotTheBugGameProps {
  courseId: number | string | undefined;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
}

/** Kết quả từng thử thách, lưu kèm ván chơi để màn kết thúc tô xanh/đỏ sau khi F5 */
interface SpotTheBugResult {
  challenge: SpotTheBugChallenge;
  userBugIndex: number | null;
  userFixIndex: number | null;
  isCorrect: boolean;
}

const CHALLENGE_COUNT = 5;

function fallbackChallenges(courseName: string): SpotTheBugChallenge[] {
  return [
    {
      prompt: 'Chạm vào đoạn gây lỗi cú pháp/logic',
      tokens: ['const', 'x', '=', '10', ';', 'x', '=', '20', ';'],
      bugIndex: 6,
      fixOptions: ['let x = 20;', 'const x = 20;', 'x == 20;'],
      correctFixIndex: 0,
      explanation: 'Biến khai báo bằng const không thể gán lại giá trị; cần khai báo bằng let nếu muốn thay đổi.',
    },
    {
      prompt: 'Chạm vào phần gây lỗi xử lý bất đồng bộ',
      tokens: ['async', 'function', 'load()', '{', 'const', 'res', '=', 'fetch("/api")', ';', 'return', 'res.json()', ';', '}'],
      bugIndex: 7,
      fixOptions: ['await fetch("/api")', 'fetch("/api").sync()', 'fetchSync("/api")'],
      correctFixIndex: 0,
      explanation: 'fetch trả về một Promise nên cần có từ khóa await trước hàm gọi.',
    },
    {
      prompt: 'Chạm vào toán tử so sánh sai bản chất',
      tokens: ['if', '(', 'status', '=', '200', ')', '{', 'console.log("OK")', '}'],
      bugIndex: 3,
      fixOptions: ['===', '!=', '+='],
      correctFixIndex: 0,
      explanation: 'Dấu = là toán tử gán; để so sánh bằng cần dùng === hoặc ==.',
    },
    {
      prompt: 'Chạm vào lệnh trả về kết quả bị thiếu',
      tokens: ['function', 'tong(a, b)', '{', 'a', '+', 'b', ';', '}'],
      bugIndex: 5,
      fixOptions: ['return a + b;', 'yield a + b;', 'print(a + b);'],
      correctFixIndex: 0,
      explanation: 'Hàm cần từ khóa return để trả giá trị tính toán ra bên ngoài.',
    },
    {
      prompt: 'Chạm vào khai báo mảng sai cú pháp',
      tokens: ['const', 'ds', '=', '(', '1,', '2,', '3', ')', ';'],
      bugIndex: 3,
      fixOptions: ['[ 1, 2, 3 ]', '{ 1, 2, 3 }', '< 1, 2, 3 >'],
      correctFixIndex: 0,
      explanation: 'Trong JavaScript, mảng được định nghĩa bằng cặp ngoặc vuông [].',
    },
  ];
}

export function SpotTheBugGame({ courseId, courseName, userId, sources }: SpotTheBugGameProps) {
  const [challenges, setChallenges] = useState<SpotTheBugChallenge[]>([]);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<'pick-bug' | 'pick-fix' | 'revealed'>('pick-bug');
  const [selectedBug, setSelectedBug] = useState<number | null>(null);
  const [selectedFix, setSelectedFix] = useState<number | null>(null);
  const [results, setResults] = useState<SpotTheBugResult[]>([]);
  const [status, setStatus] = useState<'generating' | 'playing' | 'summary'>('generating');
  const [finalScore, setFinalScore] = useState<number>(0);

  const initGame = useCallback((items: SpotTheBugChallenge[]) => {
    setChallenges(items);
    setIndex(0);
    setPhase('pick-bug');
    setSelectedBug(null);
    setSelectedFix(null);
    setResults([]);
    setStatus('playing');
  }, []);

  const loadOrGenerate = useCallback(async (forceNew = false) => {
    setStatus('generating');

    if (!forceNew) {
      const record = getDailyPlayable<SpotTheBugChallenge[]>(userId, courseId, 'spot_the_bug');
      if (record) {
        if (record.status === 'completed') {
          setChallenges(record.data || []);
          const detail = record.detail as SpotTheBugResult[] | undefined;
          setResults(Array.isArray(detail) ? detail : []);
          setFinalScore(record.score ?? record.data?.length ?? 0);
          setStatus('summary');
          return;
        }
        if (record.status === 'in_progress' && record.data?.length) {
          initGame(record.data);
          return;
        }
      }
    }

    let items: SpotTheBugChallenge[] = [];
    try {
      const materialContext = buildMaterialContext(sources);
      const res = await generatePlayableData<{ challenges: SpotTheBugChallenge[] }>(
        'spot_the_bug',
        courseName,
        materialContext,
        Number(userId) || undefined
      );
      if (res?.challenges?.length) {
        items = res.challenges.slice(0, CHALLENGE_COUNT);
      }
    } catch {
      // fallback
    }

    if (!items.length) {
      items = fallbackChallenges(courseName);
    }

    saveDailyPlayable(userId, courseId, 'spot_the_bug', {
      status: 'in_progress',
      data: items,
    });

    initGame(items);
  }, [courseId, courseName, initGame, sources, userId]);

  useEffect(() => {
    void loadOrGenerate();
  }, [loadOrGenerate]);

  const currentChallenge = challenges[index];

  const handleTapToken = (tokenIndex: number) => {
    if (phase !== 'pick-bug' || selectedBug !== null) return;
    setSelectedBug(tokenIndex);

    if (tokenIndex === currentChallenge.bugIndex) {
      // Tìm đúng vị trí lỗi -> chuyển sang bước chọn cách sửa
      setPhase('pick-fix');
    } else {
      // Chạm sai -> ghi nhận câu sai và hiển thị giải thích ngay
      setPhase('revealed');
      const itemResult = {
        challenge: currentChallenge,
        userBugIndex: tokenIndex,
        userFixIndex: null,
        isCorrect: false,
      };
      setResults((prev) => [...prev, itemResult]);
    }
  };

  const handleTapFix = (fixIdx: number) => {
    if (phase !== 'pick-fix' || selectedFix !== null) return;
    setSelectedFix(fixIdx);
    setPhase('revealed');

    const isCorrect = fixIdx === currentChallenge.correctFixIndex;
    const itemResult = {
      challenge: currentChallenge,
      userBugIndex: selectedBug,
      userFixIndex: fixIdx,
      isCorrect,
    };
    setResults((prev) => [...prev, itemResult]);
  };

  const nextChallenge = () => {
    if (index < challenges.length - 1) {
      setIndex((i) => i + 1);
      setPhase('pick-bug');
      setSelectedBug(null);
      setSelectedFix(null);
    } else {
      // Hoàn tất toàn bộ thử thách
      const correctCount = results.filter((r) => r.isCorrect).length;
      setFinalScore(correctCount);
      setStatus('summary');

      saveDailyPlayable(userId, courseId, 'spot_the_bug', {
        status: 'completed',
        data: challenges,
        detail: results,
        score: correctCount,
        maxScore: challenges.length,
        completedAt: new Date().toISOString(),
      });
    }
  };

  if (status === 'generating') {
    return (
      <div className="playable-panel">
        <div className="playable-loading">
          <LoaderCircle className="playable-spin" size={22} /> Đang chuẩn bị thử thách soi lỗi từ tài liệu…
        </div>
      </div>
    );
  }

  const feedbackText =
    finalScore === challenges.length
      ? `Tuyệt vời! Bạn đã soi lỗi chuẩn xác cả ${challenges.length}/${challenges.length} thử thách.`
      : finalScore >= Math.floor(challenges.length * 0.6)
      ? `Khá tốt! Bạn đã vượt qua ${finalScore}/${challenges.length} câu. Kỹ năng soi lỗi đang tiến bộ rõ rệt.`
      : `Bạn đúng ${finalScore}/${challenges.length} câu. Hãy đọc kỹ phần giải thích của từng lỗi bên dưới để rút kinh nghiệm.`;

  const aiSessionSummary = [
    `Kết quả: ${finalScore}/${challenges.length} câu đúng.`,
    ...challenges.map((challenge, i) => {
      const result = results[i];
      const chosenBug =
        result?.userBugIndex !== null && result?.userBugIndex !== undefined
          ? challenge.tokens[result.userBugIndex] || 'không xác định'
          : 'không chọn';
      const chosenFix =
        result?.userFixIndex !== null && result?.userFixIndex !== undefined
          ? challenge.fixOptions[result.userFixIndex] || 'không xác định'
          : 'không chọn';
      return [
        `Câu ${i + 1}: ${challenge.prompt}`,
        `- Khối lỗi đúng: ${challenge.tokens[challenge.bugIndex]}`,
        `- Bạn chọn khối: ${chosenBug}`,
        `- Cách sửa đúng: ${challenge.fixOptions[challenge.correctFixIndex]}`,
        `- Bạn chọn cách sửa: ${chosenFix}`,
        `- Kết quả: ${result?.isCorrect ? 'đúng' : 'sai'}`,
        `- Giải thích: ${challenge.explanation}`,
      ].join('\n');
    }),
  ].join('\n\n');

  return (
    <div className="playable-panel">
      <div className="playable-header">
        <div className="playable-title">
          <Bug size={20} />
          <span>Soi lỗi 1 chạm</span>
        </div>
        <div style={{ color: '#cbd5e1', fontSize: '13px', fontWeight: 700 }}>
          Câu {index + 1}/{challenges.length}
        </div>
      </div>

      {status !== 'summary' && currentChallenge ? (
        <div className="playable-body">
          <p className="playable-sub">{courseName} · Chạm vào khối lỗi trong câu hoặc mã lệnh bên dưới</p>
          <p className="playable-instruction">{currentChallenge.prompt}</p>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
              padding: '12px',
              borderRadius: '12px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            {currentChallenge.tokens.map((token, idx) => {
              const isSelected = selectedBug === idx;
              const isBug = idx === currentChallenge.bugIndex;
              let borderCol = 'rgba(255,255,255,0.15)';
              let bg = 'rgba(255,255,255,0.06)';
              let col = '#f8fafc';

              if (phase === 'revealed') {
                if (isBug) {
                  borderCol = '#22c55e';
                  bg = 'rgba(34,197,94,0.2)';
                } else if (isSelected && !isBug) {
                  borderCol = '#f43f5e';
                  bg = 'rgba(244,63,94,0.2)';
                }
              } else if (isSelected) {
                borderCol = '#b92b47';
                bg = 'rgba(185, 43, 71,0.25)';
              }

              return (
                <button
                  key={`token-${idx}`}
                  type="button"
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: `1px solid ${borderCol}`,
                    background: bg,
                    color: col,
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    cursor: phase === 'pick-bug' ? 'pointer' : 'default',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => handleTapToken(idx)}
                  disabled={phase !== 'pick-bug'}
                >
                  {token}
                </button>
              );
            })}
          </div>

          {phase === 'pick-fix' && (
            <div className="playable-fix">
              <span className="playable-fix-label">Chính xác! Chọn cách sửa chuẩn:</span>
              {currentChallenge.fixOptions.map((opt, fixIdx) => (
                <button
                  key={`fix-${fixIdx}`}
                  type="button"
                  className="playable-fix-btn"
                  onClick={() => handleTapFix(fixIdx)}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}

          {phase === 'revealed' && (
            <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: `1px solid ${results[results.length - 1]?.isCorrect ? 'rgba(34,197,94,0.3)' : 'rgba(244,63,94,0.3)'}`,
                  background: results[results.length - 1]?.isCorrect ? 'rgba(34,197,94,0.1)' : 'rgba(244,63,94,0.1)',
                  fontSize: '12.5px',
                  color: '#e2e8f0',
                  lineHeight: '1.5',
                }}
              >
                <strong style={{ color: results[results.length - 1]?.isCorrect ? '#4ade80' : '#fb7185' }}>
                  {results[results.length - 1]?.isCorrect ? '✓ Soi lỗi chính xác! ' : '✕ Chưa chính xác: '}
                </strong>
                {currentChallenge.explanation}
              </div>
              <button type="button" className="playable-btn primary" onClick={nextChallenge} style={{ alignSelf: 'flex-end' }}>
                {index < challenges.length - 1 ? 'Câu tiếp theo' : 'Xem tổng kết'} <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="playable-summary">
          <div className="playable-summary-icon">
            <CheckCircle2 size={26} />
          </div>
          <p className="playable-eyebrow">KẾT QUẢ SOI LỖI HÔM NAY</p>
          <h2>
            {finalScore}/{challenges.length} câu hoàn hảo
          </h2>
          <div className="playable-ai-feedback">
            <Lightbulb size={17} />
            <span>{feedbackText}</span>
          </div>

          <PlayableAIFeedback
            courseId={courseId}
            courseName={courseName}
            userId={userId}
            activityType="spot_the_bug"
            activityLabel="Soi lỗi 1 chạm"
            score={finalScore}
            total={challenges.length}
            sessionSummary={aiSessionSummary}
          />

          <div className="playable-review">
            <span className="playable-mistake-label">Chi tiết các lỗi học thuật (xanh = bạn đúng, đỏ = bạn sai):</span>
            <div className="playable-review-list">
              {challenges.map((c, i) => {
                const r = results[i];
                const state = !r ? 'unknown' : r.isCorrect ? 'correct' : 'wrong';
                return (
                  <div key={i} className={`bug-review-item ${state}`}>
                    <div className="bug-review-head">
                      {r && (
                        <span className="bug-review-tag">{r.isCorrect ? '✓ Đúng' : '✕ Sai'}</span>
                      )}
                      <span className="bug-review-title">
                        Thử thách {i + 1}: {c.prompt}
                      </span>
                    </div>
                    <div>
                      <strong>Lỗi:</strong> <code>{c.tokens[c.bugIndex]}</code> → <strong>Sửa:</strong>{' '}
                      <code>{c.fixOptions[c.correctFixIndex]}</code>
                    </div>
                    {state === 'wrong' && r && (
                      <div className="bug-review-pick">
                        Bạn chọn:{' '}
                        {r.userBugIndex !== null && <code>{c.tokens[r.userBugIndex]}</code>}
                        {r.userFixIndex !== null && (
                          <>
                            {' → '}
                            <code>{c.fixOptions[r.userFixIndex]}</code>
                          </>
                        )}
                      </div>
                    )}
                    <div className="bug-review-exp">{c.explanation}</div>
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
