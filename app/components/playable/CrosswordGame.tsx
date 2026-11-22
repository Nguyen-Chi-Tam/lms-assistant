'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, Lightbulb, LoaderCircle, LayoutGrid } from 'lucide-react';
import type { CourseSourceItem } from '@/app/types';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { generateCrosswordGrid, type PlacedWord } from '@/app/lib/crossword-layout';
import { PlayableAIFeedback } from '@/app/components/playable/PlayableAIFeedback';

interface CrosswordGameProps {
  courseId: number | string | undefined;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
}

// Số từ khóa ứng viên xin từ AI (chọn ngẫu nhiên 6-9 từ để xếp lưới)
const CANDIDATE_WORD_COUNT = 12;
const MIN_TOTAL_WORDS = 6;
const MAX_TOTAL_WORDS = 9;
const MIN_ACROSS_WORDS = 3;
const MIN_DOWN_WORDS = 3;

interface CrosswordPlan {
  words: Array<{ word: string; clue: string }>;
  acrossCount: number;
  downCount: number;
}

export function removeVietnameseTones(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]/g, '');
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Chọn ngẫu nhiên tổng số từ (6-9), số từ ngang (tối thiểu 3) và số từ dọc = tổng - ngang.
 */
function createCrosswordPlan(rawWords: Array<{ word: string; clue: string }>): CrosswordPlan {
  const seen = new Set<string>();
  const candidates: Array<{ word: string; clue: string }> = [];

  for (const item of rawWords) {
    if (!item?.word || !item?.clue) continue;
    const word = removeVietnameseTones(item.word).toUpperCase();
    if (word.length < 3 || word.length > 12) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    candidates.push({ word, clue: item.clue });
  }

  if (candidates.length === 0) {
    return { words: [], acrossCount: 0, downCount: 0 };
  }

  const words = shuffle(candidates);
  const maxTotal = Math.min(MAX_TOTAL_WORDS, words.length);
  const minTotal = Math.min(MIN_TOTAL_WORDS, maxTotal);
  const total = randomInt(minTotal, maxTotal);

  // Ngang tối thiểu 3 từ, dọc = tổng - ngang. Giữ tối thiểu 3 từ dọc để lưới
  // luôn cân đối và luôn xếp đủ tổng 6-9 từ.
  const acrossMin = Math.min(MIN_ACROSS_WORDS, Math.max(1, total - 1));
  const acrossMax = Math.max(acrossMin, total - MIN_DOWN_WORDS);
  const acrossCount = randomInt(acrossMin, acrossMax);

  return { words, acrossCount, downCount: Math.max(0, total - acrossCount) };
}

function normalizePlan(raw: unknown): CrosswordPlan | null {
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    return createCrosswordPlan(raw as Array<{ word: string; clue: string }>);
  }
  if (raw && typeof raw === 'object') {
    const plan = raw as Partial<CrosswordPlan>;
    if (Array.isArray(plan.words) && plan.words.length > 0) {
      return {
        words: plan.words,
        acrossCount: typeof plan.acrossCount === 'number' ? plan.acrossCount : 0,
        downCount: typeof plan.downCount === 'number' ? plan.downCount : 0,
      };
    }
  }
  return null;
}

function fallbackWords(courseName: string): Array<{ word: string; clue: string }> {
  return [
    { word: 'DATABASE', clue: 'Hệ thống lưu trữ và quản lý dữ liệu có cấu trúc' },
    { word: 'BACKEND', clue: 'Phần xử lý logic và cơ sở dữ liệu trên máy chủ' },
    { word: 'FRONTEND', clue: 'Giao diện tương tác trực tiếp với người dùng' },
    { word: 'CLIENT', clue: 'Phía máy trạm gửi yêu cầu lên máy chủ' },
    { word: 'SERVER', clue: 'Máy chủ phản hồi các yêu cầu từ mạng' },
    { word: 'ROUTER', clue: 'Thành phần điều hướng đường dẫn URL đến controller' },
    { word: 'SCHEMA', clue: 'Bản thiết kế cấu trúc dữ liệu hoặc bảng' },
    { word: 'TOKEN', clue: 'Chuỗi ký tự đại diện xác thực danh tính người dùng' },
    { word: 'ALGORITHM', clue: 'Quy trình từng bước để giải một bài toán' },
    { word: 'COMPILER', clue: 'Chương trình chuyển mã nguồn thành mã máy' },
    { word: 'VARIABLE', clue: 'Vùng nhớ có tên dùng để lưu giá trị trong chương trình' },
    { word: 'PROTOCOL', clue: 'Bộ quy tắc truyền thông giữa các hệ thống' },
  ];
}

/** Bổ sung từ dự phòng nếu AI trả về ít từ hơn mức cần cho kế hoạch 6-9 từ. */
function fillCandidateWords(
  words: Array<{ word: string; clue: string }>,
  courseName: string,
  target: number
): Array<{ word: string; clue: string }> {
  if (words.length >= target) return words;

  const seen = new Set(words.map((w) => removeVietnameseTones(w.word).toUpperCase()));
  const result = [...words];
  for (const fallback of fallbackWords(courseName)) {
    if (result.length >= target) break;
    const normalized = removeVietnameseTones(fallback.word).toUpperCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(fallback);
  }
  return result;
}

export function CrosswordGame({ courseId, courseName, userId, sources }: CrosswordGameProps) {
  const [placedWords, setPlacedWords] = useState<PlacedWord[]>([]);
  const [grid, setGrid] = useState<(string | null)[][]>([]);
  const [userInputs, setUserInputs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'generating' | 'playing' | 'summary'>('generating');
  const [score, setScore] = useState(0);
  // Từ đã giải đúng của ván kết thúc; null = ván cũ chưa lưu chi tiết nên không tô màu.
  const [summaryCorrectWords, setSummaryCorrectWords] = useState<string[] | null>(null);
  const [currentDirection, setCurrentDirection] = useState<'across' | 'down'>('across');
  const [activeCell, setActiveCell] = useState<{ r: number; c: number } | null>(null);

  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const lastAutoAdvanceTimeRef = useRef<number>(0);

  const initGameWithPlan = useCallback((plan: CrosswordPlan) => {
    const layout = generateCrosswordGrid(plan.words, {
      acrossCount: plan.acrossCount,
      downCount: plan.downCount,
    });
    setPlacedWords(layout.placedWords);
    setGrid(layout.grid);
    setUserInputs({});
    setCurrentDirection('across');
    setActiveCell(null);
    setSummaryCorrectWords(null);
    setStatus('playing');
  }, []);

  const loadOrGenerate = useCallback(async (forceNew = false) => {
    setStatus('generating');

    if (!forceNew) {
      const record = getDailyPlayable<CrosswordPlan | Array<{ word: string; clue: string }>>(
        userId,
        courseId,
        'crossword'
      );
      if (record) {
        const plan = normalizePlan(record.data);
        if (plan) {
          if (record.status === 'completed') {
            initGameWithPlan(plan);
            const detail = record.detail as { correctWords?: string[] } | undefined;
            setSummaryCorrectWords(Array.isArray(detail?.correctWords) ? detail.correctWords : null);
            setScore(record.score ?? 0);
            setStatus('summary');
            return;
          }
          if (record.status === 'in_progress') {
            initGameWithPlan(plan);
            return;
          }
        }
      }
    }

    let items: Array<{ word: string; clue: string }> = [];
    try {
      const materialContext = buildMaterialContext(sources);
      const res = await generatePlayableData<{ words: Array<{ word: string; clue: string }> }>(
        'crossword',
        courseName,
        materialContext,
        Number(userId) || undefined
      );
      if (res?.words?.length) {
        items = res.words.slice(0, CANDIDATE_WORD_COUNT);
      }
    } catch {
      // fallback
    }

    if (!items.length) {
      items = fallbackWords(courseName);
    } else {
      items = fillCandidateWords(items, courseName, MAX_TOTAL_WORDS);
    }

    const plan = createCrosswordPlan(items);

    saveDailyPlayable(userId, courseId, 'crossword', {
      status: 'in_progress',
      data: plan,
    });

    initGameWithPlan(plan);
  }, [courseId, courseName, initGameWithPlan, sources, userId]);

  useEffect(() => {
    void loadOrGenerate();
  }, [loadOrGenerate]);

  const handleCellFocus = (r: number, c: number) => {
    setActiveCell({ r, c });
    const hasAcross = placedWords.some(
      (w) => w.direction === 'across' && w.row === r && c >= w.col && c < w.col + w.word.length
    );
    const hasDown = placedWords.some(
      (w) => w.direction === 'down' && w.col === c && r >= w.row && r < w.row + w.word.length
    );
    if (hasAcross && !hasDown) {
      setCurrentDirection('across');
    } else if (hasDown && !hasAcross) {
      setCurrentDirection('down');
    }
  };

  const setCellAndAdvance = (r: number, c: number, char: string) => {
    const clean = removeVietnameseTones(char).slice(-1).toUpperCase();
    if (!clean) return;

    setUserInputs((prev) => ({ ...prev, [`${r}_${c}`]: clean }));

    // Tự động tìm ô kế tiếp
    let nextR = r;
    let nextC = c;
    if (currentDirection === 'across') {
      if (grid[r]?.[c + 1]) {
        nextC = c + 1;
      } else if (grid[r + 1]?.[c]) {
        nextR = r + 1;
        setCurrentDirection('down');
      }
    } else {
      if (grid[r + 1]?.[c]) {
        nextR = r + 1;
      } else if (grid[r]?.[c + 1]) {
        nextC = c + 1;
        setCurrentDirection('across');
      }
    }

    if (nextR !== r || nextC !== c) {
      lastAutoAdvanceTimeRef.current = Date.now();
      setTimeout(() => {
        const nextInput = inputRefs.current[`${nextR}_${nextC}`];
        if (nextInput) {
          nextInput.focus();
          nextInput.select();
        }
      }, 10);
    }
  };

  const getCharFromKey = (e: React.KeyboardEvent): string | null => {
    if (e.ctrlKey || e.altKey || e.metaKey) return null;

    // Phím chữ cái Latin đơn hoặc số
    if (/^[a-zA-Z0-9]$/.test(e.key)) {
      return e.key.toUpperCase();
    }
    // Sử dụng e.code để bắt đúng phím vật lý độc lập với bộ gõ tiếng Việt (UniKey/EVKey)
    if (e.code.startsWith('Key') && e.code.length === 4) {
      return e.code.slice(3).toUpperCase();
    }
    if (e.code.startsWith('Digit') && e.code.length === 6) {
      return e.code.slice(5);
    }
    return null;
  };

  const handleKeyDown = (r: number, c: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    // 1. Phím ký tự chữ/số: chặn bộ gõ IME can thiệp ghép dấu bằng cách xử lý trực tiếp
    const char = getCharFromKey(e);
    if (char) {
      e.preventDefault();
      setCellAndAdvance(r, c, char);
      return;
    }

    // 2. Xử lý Backspace thông minh, chặn Backspace giả mạo do UniKey/EVKey gửi tự động
    if (e.key === 'Backspace') {
      // Nếu Backspace xảy ra ngay sau khi tự động chuyển ô (< 280ms), đó là Backspace do bộ gõ tiếng Việt gửi -> Bỏ qua
      if (Date.now() - lastAutoAdvanceTimeRef.current < 280) {
        e.preventDefault();
        return;
      }

      // Nếu ô hiện tại có chữ -> xóa chữ ô hiện tại và giữ nguyên vị trí
      if (userInputs[`${r}_${c}`]) {
        e.preventDefault();
        setUserInputs((prev) => ({ ...prev, [`${r}_${c}`]: '' }));
        return;
      }

      // Nếu ô hiện tại đã trống -> lùi về ô trước và xóa chữ ô đó
      e.preventDefault();
      const prevR = currentDirection === 'down' ? r - 1 : r;
      const prevC = currentDirection === 'across' ? c - 1 : c;
      if (grid[prevR]?.[prevC]) {
        setUserInputs((prev) => ({ ...prev, [`${prevR}_${prevC}`]: '' }));
        const prevInput = inputRefs.current[`${prevR}_${prevC}`];
        if (prevInput) {
          prevInput.focus();
          prevInput.select();
        }
      }
      return;
    }

    // 3. Phím điều hướng mũi tên
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setCurrentDirection('across');
      if (grid[r]?.[c + 1]) inputRefs.current[`${r}_${c + 1}`]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setCurrentDirection('across');
      if (grid[r]?.[c - 1]) inputRefs.current[`${r}_${c - 1}`]?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCurrentDirection('down');
      if (grid[r + 1]?.[c]) inputRefs.current[`${r + 1}_${c}`]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCurrentDirection('down');
      if (grid[r - 1]?.[c]) inputRefs.current[`${r - 1}_${c}`]?.focus();
    }
  };

  const handleCellChange = (r: number, c: number, val: string) => {
    // Bỏ qua nếu sự kiện change xảy ra do bộ gõ tiếng Việt can thiệp ngay sau auto-advance
    if (Date.now() - lastAutoAdvanceTimeRef.current < 280) {
      return;
    }
    const clean = removeVietnameseTones(val).slice(-1).toUpperCase();
    if (!clean) {
      setUserInputs((prev) => ({ ...prev, [`${r}_${c}`]: '' }));
      return;
    }
    setCellAndAdvance(r, c, clean);
  };

  const handleCompositionEnd = (r: number, c: number, e: React.CompositionEvent<HTMLInputElement>) => {
    const clean = removeVietnameseTones(e.data).slice(-1).toUpperCase();
    if (clean) {
      setCellAndAdvance(r, c, clean);
    }
  };

  const handlePaste = (r: number, c: number, e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const cleanText = removeVietnameseTones(text).toUpperCase();
    if (!cleanText) return;

    const updates: Record<string, string> = {};
    let curR = r;
    let curC = c;
    for (let i = 0; i < cleanText.length; i++) {
      if (!grid[curR]?.[curC]) break;
      updates[`${curR}_${curC}`] = cleanText[i];
      if (currentDirection === 'across') {
        curC++;
      } else {
        curR++;
      }
    }
    setUserInputs((prev) => ({ ...prev, ...updates }));
    const lastR = currentDirection === 'down' ? curR - 1 : curR;
    const lastC = currentDirection === 'across' ? curC - 1 : curC;
    inputRefs.current[`${lastR}_${lastC}`]?.focus();
  };

  const handleSelectWord = (w: PlacedWord) => {
    setCurrentDirection(w.direction);
    const firstCellInput = inputRefs.current[`${w.row}_${w.col}`];
    if (firstCellInput) {
      firstCellInput.focus();
      firstCellInput.select();
    }
  };

  const finishGame = () => {
    const correctWords: string[] = [];
    for (const pw of placedWords) {
      let isAllCorrect = true;
      for (let k = 0; k < pw.word.length; k++) {
        const curR = pw.direction === 'down' ? pw.row + k : pw.row;
        const curC = pw.direction === 'across' ? pw.col + k : pw.col;
        const typed = (userInputs[`${curR}_${curC}`] || '').toUpperCase();
        if (typed !== pw.word[k]) {
          isAllCorrect = false;
          break;
        }
      }
      if (isAllCorrect) correctWords.push(pw.word);
    }

    const correctWordsCount = correctWords.length;
    setScore(correctWordsCount);
    setSummaryCorrectWords(correctWords);
    setStatus('summary');

    // Lưu hoàn thành vào localStorage, không ghi database
    saveDailyPlayable(userId, courseId, 'crossword', {
      status: 'completed',
      data: {
        words: placedWords.map((pw) => ({ word: pw.word, clue: pw.clue })),
        acrossCount: placedWords.filter((pw) => pw.direction === 'across').length,
        downCount: placedWords.filter((pw) => pw.direction === 'down').length,
      },
      detail: { correctWords },
      score: correctWordsCount,
      maxScore: placedWords.length,
      completedAt: new Date().toISOString(),
    });
  };

  const aiSessionSummary = [
    `Kết quả: ${score}/${placedWords.length} từ khóa chính xác.`,
    `Từ đã giải đúng: ${
      summaryCorrectWords?.length ? summaryCorrectWords.join(', ') : 'không có'
    }.`,
    `Từ chưa giải đúng: ${
      summaryCorrectWords
        ? placedWords
            .filter((word) => !summaryCorrectWords.includes(word.word))
            .map((word) => `${word.word} (${word.clue})`)
            .join('; ') || 'không có'
        : 'không có dữ liệu chi tiết'
    }.`,
    `Danh sách toàn bộ từ khóa: ${placedWords
      .map((word) => `${word.id}. ${word.word} — ${word.clue}`)
      .join('; ')}.`,
  ].join('\n');

  if (status === 'generating') {
    return (
      <div className="playable-panel">
        <div className="playable-loading">
          <LoaderCircle className="playable-spin" size={22} /> Đang tự động xếp lưới ô chữ từ tài liệu…
        </div>
      </div>
    );
  }

  // Lọc lấy bounding box ô chứa chữ để vẽ lưới vừa vặn
  let minR = 15, maxR = 0, minC = 15, maxC = 0;
  placedWords.forEach((pw) => {
    minR = Math.min(minR, pw.row);
    minC = Math.min(minC, pw.col);
    if (pw.direction === 'across') {
      maxR = Math.max(maxR, pw.row);
      maxC = Math.max(maxC, pw.col + pw.word.length - 1);
    } else {
      maxR = Math.max(maxR, pw.row + pw.word.length - 1);
      maxC = Math.max(maxC, pw.col);
    }
  });

  if (minR > maxR) {
    minR = 0; maxR = 10; minC = 0; maxC = 10;
  }

  const acrossWords = placedWords.filter((w) => w.direction === 'across');
  const downWords = placedWords.filter((w) => w.direction === 'down');

  return (
    <div className="playable-panel">
      <div className="playable-header">
        <div className="playable-title">
          <LayoutGrid size={20} />
          <span>Ô chữ từ khóa</span>
        </div>
        <div style={{ color: '#cbd5e1', fontSize: '13px', fontWeight: 700 }}>
          {placedWords.length} từ khóa · Hướng: {currentDirection === 'across' ? 'Ngang →' : 'Dọc ↓'}
        </div>
      </div>

      {status !== 'summary' ? (
        <div className="playable-body">
          <p className="playable-sub">
            {courseName} · Tự động chuyển ô kế tiếp, chống xung đột UniKey/EVKey, phím mũi tên điều hướng
          </p>

          <div className="crossword-wrapper" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Lưới ô chữ */}
            <div
              className="crossword-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${maxC - minC + 1}, 32px)`,
                gridTemplateRows: `repeat(${maxR - minR + 1}, 32px)`,
                gap: '3px',
                alignSelf: 'center',
                overflowX: 'auto',
              }}
            >
              {Array.from({ length: maxR - minR + 1 }).map((_, rIdx) => {
                const r = minR + rIdx;
                return Array.from({ length: maxC - minC + 1 }).map((_, cIdx) => {
                  const c = minC + cIdx;
                  const letter = grid[r]?.[c];
                  if (!letter) {
                    return (
                      <div
                        key={`cell-${r}-${c}`}
                        style={{ width: '32px', height: '32px', background: 'transparent' }}
                      />
                    );
                  }

                  const wordStartingHere = placedWords.find((w) => w.row === r && w.col === c);
                  const typed = userInputs[`${r}_${c}`] || '';
                  const isActive = activeCell?.r === r && activeCell?.c === c;

                  return (
                    <div
                      key={`cell-${r}-${c}`}
                      className="crossword-cell filled"
                      style={{
                        position: 'relative',
                        width: '32px',
                        height: '32px',
                        border: isActive ? '1px solid #b92b47' : undefined,
                        boxShadow: isActive ? '0 0 8px rgba(185, 43, 71,0.5)' : undefined,
                      }}
                    >
                      {wordStartingHere && (
                        <span className="crossword-number">{wordStartingHere.id}</span>
                      )}
                      <input
                        ref={(el) => {
                          inputRefs.current[`${r}_${c}`] = el;
                        }}
                        type="text"
                        inputMode="text"
                        autoCapitalize="characters"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={2}
                        className="crossword-input"
                        value={typed}
                        onFocus={() => handleCellFocus(r, c)}
                        onChange={(e) => handleCellChange(r, c, e.target.value)}
                        onKeyDown={(e) => handleKeyDown(r, c, e)}
                        onCompositionEnd={(e) => handleCompositionEnd(r, c, e)}
                        onPaste={(e) => handlePaste(r, c, e)}
                        style={{ width: '100%', height: '100%', textAlign: 'center' }}
                      />
                    </div>
                  );
                });
              })}
            </div>

            {/* Danh sách gợi ý */}
            <div className="crossword-clues">
              {acrossWords.length > 0 && (
                <div className="crossword-clue-group">
                  <span className="crossword-clue-title">Ngang</span>
                  {acrossWords.map((w) => (
                    <div
                      key={w.id}
                      className="crossword-clue-item"
                      onClick={() => handleSelectWord(w)}
                      style={{ cursor: 'pointer', borderRadius: '4px', padding: '2px 4px' }}
                      title="Bấm để chuyển tới ô bắt đầu từ này"
                    >
                      <span className="crossword-clue-num">{w.id}.</span>
                      <span>
                        {w.clue} ({w.word.length} chữ cái)
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {downWords.length > 0 && (
                <div className="crossword-clue-group">
                  <span className="crossword-clue-title">Dọc</span>
                  {downWords.map((w) => (
                    <div
                      key={w.id}
                      className="crossword-clue-item"
                      onClick={() => handleSelectWord(w)}
                      style={{ cursor: 'pointer', borderRadius: '4px', padding: '2px 4px' }}
                      title="Bấm để chuyển tới ô bắt đầu từ này"
                    >
                      <span className="crossword-clue-num">{w.id}.</span>
                      <span>
                        {w.clue} ({w.word.length} chữ cái)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="playable-actions">
            <button type="button" className="playable-btn primary" onClick={finishGame}>
              Kiểm tra & Nộp bài <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div className="playable-summary">
          <div className="playable-summary-icon">
            <CheckCircle2 size={26} />
          </div>
          <p className="playable-eyebrow">KẾT QUẢ Ô CHỮ HÔM NAY</p>
          <h2>
            {score}/{placedWords.length} từ khóa chính xác
          </h2>
          <div className="playable-ai-feedback">
            <Lightbulb size={17} />
            <span>
              {score === placedWords.length
                ? 'Tuyệt đỉnh! Bạn đã giải chính xác toàn bộ ô chữ kiến thức.'
                : `Bạn đã giải đúng ${score}/${placedWords.length} từ. Tra cứu đáp án chi tiết phía dưới.`}
            </span>
          </div>

          <PlayableAIFeedback
            courseId={courseId}
            courseName={courseName}
            userId={userId}
            activityType="crossword"
            activityLabel="Ô chữ kiến thức"
            score={score}
            total={placedWords.length}
            sessionSummary={aiSessionSummary}
          />

          <div className="playable-review">
            <span className="playable-mistake-label">Đáp án ô chữ (xanh = bạn giải đúng, đỏ = chưa đúng):</span>
            <div className="playable-review-list">
              {placedWords.map((w) => {
                const known = summaryCorrectWords !== null;
                const solved = known && summaryCorrectWords.includes(w.word);
                const state = !known ? 'unknown' : solved ? 'correct' : 'wrong';
                return (
                  <div key={w.id} className={`crossword-review-item ${state}`}>
                    {known && <span className="crossword-review-tag">{solved ? '✓ Đúng' : '✕ Sai'}</span>}
                    <span>
                      <strong style={{ color: !known ? '#b92b47' : solved ? '#4ade80' : '#fb7185' }}>
                        {w.id}. {w.word} ({w.direction === 'across' ? 'Ngang' : 'Dọc'}):
                      </strong>{' '}
                      {w.clue}
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
