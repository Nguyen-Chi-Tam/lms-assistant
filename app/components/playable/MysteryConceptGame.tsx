'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  HelpCircle,
  Lightbulb,
  LoaderCircle,
  Lock,
  Send,
  SkipForward,
  Sparkles,
  Unlock,
  XCircle,
} from 'lucide-react';
import type { CourseSourceItem } from '@/app/types';
import { getDailyPlayable, saveDailyPlayable } from '@/app/lib/playable-limit';
import { buildMaterialContext, generatePlayableData } from '@/app/lib/playable-generator';
import { PlayableAIFeedback } from '@/app/components/playable/PlayableAIFeedback';

export interface MysteryConceptPuzzle {
  vagueQuestion: string;
  target: string;
  acceptedAnswers: string[];
  category: string;
  clues: string[];
  explanation: string;
}

export interface MysteryTurn {
  type: 'guess' | 'skip';
  value?: string;
}

export interface MysteryConceptSession {
  puzzle: MysteryConceptPuzzle;
  history: MysteryTurn[];
  isWon: boolean;
}

interface MysteryConceptGameProps {
  courseId: number | string | undefined;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
}

const TOTAL_CLUES = 10;
const MAX_SKIPS = 3;
const MAX_SCORE = 100;
const MIN_SCORE = 10;
const SCORE_PENALTY = 10;

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[-_/\\.,()]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function removeVietnameseTones(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function isGuessCorrect(userGuess: string, puzzle: MysteryConceptPuzzle): boolean {
  const cleanGuess = normalizeText(userGuess);
  if (!cleanGuess) return false;

  const noToneGuess = removeVietnameseTones(cleanGuess);
  const candidates = [puzzle.target, ...(puzzle.acceptedAnswers || [])];

  return candidates.some((answer) => {
    const cleanAnswer = normalizeText(answer);
    if (!cleanAnswer) return false;
    return cleanGuess === cleanAnswer || noToneGuess === removeVietnameseTones(cleanAnswer);
  });
}

function calculateScore(won: boolean, failedTurns: number): number {
  if (!won) return 0;
  return Math.max(MIN_SCORE, MAX_SCORE - failedTurns * SCORE_PENALTY);
}

function fallbackPuzzle(courseName: string): MysteryConceptPuzzle {
  return {
    vagueQuestion:
      'Tôi âm thầm giữ cho mọi thứ luôn nhất quán và có thể tìm lại được. Tôi là ai?',
    target: 'Cơ sở dữ liệu',
    acceptedAnswers: ['co so du lieu', 'csdl', 'database', 'db'],
    category: `Nền tảng kiến thức · ${courseName}`,
    clues: [
      'Tôi xuất hiện trong hầu hết hệ thống phần mềm nhưng người dùng cuối hiếm khi nhìn thấy tôi.',
      'Tôi sống trên máy chủ và làm việc với các bảng, hàng và cột.',
      'Các ứng dụng hỏi tôi bằng ngôn ngữ truy vấn thay vì đọc tệp trực tiếp.',
      'Tôi giữ dữ liệu không bị trùng lặp và duy trì ràng buộc giữa các thực thể.',
      'Tôi hỗ trợ giao dịch: hoặc tất cả thay đổi được lưu, hoặc không thay đổi nào.',
      'Tôi thường dùng chỉ mục để tăng tốc tìm kiếm.',
      'Tôi có nhiều dạng như quan hệ, tài liệu hay khóa-giá trị.',
      'MySQL, PostgreSQL và MongoDB là những hệ quản trị của tôi.',
      'Sao lưu và phục hồi là nghiệp vụ gắn liền với tôi.',
      'Nếu tôi hỏng, toàn bộ ứng dụng có thể mất dữ liệu.',
    ],
    explanation:
      'Cơ sở dữ liệu là hệ thống lưu trữ, tổ chức và truy xuất dữ liệu có cấu trúc, đảm bảo tính nhất quán và toàn vẹn cho ứng dụng.',
  };
}

function normalizeGeneratedPuzzle(
  raw: Partial<MysteryConceptPuzzle> | null | undefined,
  courseName: string
): MysteryConceptPuzzle {
  const clues = Array.isArray(raw?.clues)
    ? raw.clues
        .filter((clue): clue is string => typeof clue === 'string' && clue.trim().length > 0)
        .map((clue) => clue.trim())
        .slice(0, TOTAL_CLUES)
    : [];
  const target = typeof raw?.target === 'string' ? raw.target.trim() : '';

  // The 10-clue board is core to the game, so fall back if the model returns an incomplete set.
  if (!target || clues.length < TOTAL_CLUES) {
    return fallbackPuzzle(courseName);
  }

  const acceptedAnswers = Array.isArray(raw?.acceptedAnswers)
    ? raw.acceptedAnswers.filter(
        (answer): answer is string => typeof answer === 'string' && answer.trim().length > 0
      )
    : [];

  const category =
    typeof raw?.category === 'string' && raw.category.trim() ? raw.category.trim() : 'Kiến thức môn học';

  return {
    vagueQuestion:
      typeof raw?.vagueQuestion === 'string' && raw.vagueQuestion.trim()
        ? raw.vagueQuestion.trim()
        : `Tôi là một khái niệm quan trọng thuộc lĩnh vực ${category}. Bạn có đoán ra tôi là ai không?`,
    target,
    acceptedAnswers: acceptedAnswers.map((answer) => answer.trim()),
    category,
    clues,
    explanation:
      typeof raw?.explanation === 'string' && raw.explanation.trim()
        ? raw.explanation.trim()
        : `Đáp án là ${target}.`,
  };
}

export function MysteryConceptGame({ courseId, courseName, userId, sources }: MysteryConceptGameProps) {
  const [session, setSession] = useState<MysteryConceptSession | null>(null);
  const [status, setStatus] = useState<'generating' | 'playing' | 'summary'>('generating');
  const [inputValue, setInputValue] = useState('');
  const [shakeInput, setShakeInput] = useState(false);
  const [score, setScore] = useState(0);

  const loadOrGenerate = useCallback(async (forceNew = false) => {
    setStatus('generating');

    if (!forceNew) {
      const record = getDailyPlayable<MysteryConceptSession>(userId, courseId, 'mystery_concept');
      if (record?.data?.puzzle?.clues?.length) {
        setSession(record.data);
        if (record.status === 'completed') {
          setScore(record.score ?? 0);
          setStatus('summary');
        } else {
          setStatus('playing');
        }
        return;
      }
    }

    let puzzle: MysteryConceptPuzzle | null = null;
    try {
      const materialContext = buildMaterialContext(sources);
      const res = await generatePlayableData<Partial<MysteryConceptPuzzle>>(
        'mystery_concept',
        courseName,
        materialContext,
        Number(userId) || undefined
      );
      puzzle = normalizeGeneratedPuzzle(res, courseName);
    } catch {
      // fallback
    }

    const nextSession: MysteryConceptSession = {
      puzzle: puzzle ?? fallbackPuzzle(courseName),
      history: [],
      isWon: false,
    };

    setSession(nextSession);
    setStatus('playing');
    saveDailyPlayable(userId, courseId, 'mystery_concept', {
      status: 'in_progress',
      data: nextSession,
    });
  }, [courseId, courseName, sources, userId]);

  useEffect(() => {
    void loadOrGenerate();
  }, [loadOrGenerate]);

  if (status === 'generating' || !session) {
    return (
      <div className="playable-panel">
        <div className="playable-loading">
          <LoaderCircle className="playable-spin" size={22} /> Đang chuẩn bị 10 gợi ý cho thuật ngữ bí mật…
        </div>
      </div>
    );
  }

  const { puzzle, history, isWon } = session;
  const failedTurns = isWon ? Math.max(0, history.length - 1) : history.length;
  const skipsUsed = history.filter((turn) => turn.type === 'skip').length;
  const skipsRemaining = Math.max(0, MAX_SKIPS - skipsUsed);
  const openedCount = Math.min(TOTAL_CLUES, failedTurns + 1);
  const finished = status === 'summary';
  const canSkip = !finished && skipsRemaining > 0 && openedCount < TOTAL_CLUES;

  const commitTurn = (turn: MysteryTurn, won: boolean) => {
    const nextFailedTurns = won ? failedTurns : failedTurns + 1;
    const gameEnded = won || nextFailedTurns >= TOTAL_CLUES;
    const nextSession: MysteryConceptSession = {
      puzzle,
      history: [...history, turn],
      isWon: won,
    };

    setSession(nextSession);

    if (gameEnded) {
      const finalScore = calculateScore(won, nextFailedTurns);
      setScore(finalScore);
      setStatus('summary');
      saveDailyPlayable(userId, courseId, 'mystery_concept', {
        status: 'completed',
        data: nextSession,
        score: finalScore,
        maxScore: MAX_SCORE,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    saveDailyPlayable(userId, courseId, 'mystery_concept', {
      status: 'in_progress',
      data: nextSession,
    });
  };

  const handleGuessSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (finished) return;

    const trimmed = inputValue.trim();
    if (!trimmed) return;

    const isDuplicate = history.some(
      (turn) =>
        turn.type === 'guess' &&
        typeof turn.value === 'string' &&
        normalizeText(turn.value) === normalizeText(trimmed)
    );
    if (isDuplicate) {
      setShakeInput(true);
      setTimeout(() => setShakeInput(false), 400);
      return;
    }

    const correct = isGuessCorrect(trimmed, puzzle);
    setInputValue('');

    if (!correct) {
      setShakeInput(true);
      setTimeout(() => setShakeInput(false), 400);
    }

    commitTurn({ type: 'guess', value: trimmed }, correct);
  };

  const handleSkip = () => {
    if (!canSkip) return;
    setInputValue('');
    commitTurn({ type: 'skip' }, false);
  };

  // Right answers in green, wrong guesses in red — shared by the play view and the end screen.
  const renderTurnChips = () => (
    <div className="mystery-history-chips">
      {history.map((turn, index) => {
        if (turn.type === 'skip') {
          return (
            <span key={index} className="mystery-turn skip">
              <SkipForward size={12} /> Bỏ qua (Lượt {index + 1})
            </span>
          );
        }

        const isWinningTurn = isWon && index === history.length - 1;
        return (
          <span key={index} className={`mystery-turn ${isWinningTurn ? 'win' : 'wrong'}`}>
            {isWinningTurn ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            {turn.value}
          </span>
        );
      })}
    </div>
  );

  const aiSessionSummary = [
    `Kết quả: ${isWon ? `đoán đúng với ${score}/${MAX_SCORE} điểm` : 'không đoán đúng, 0 điểm'}.`,
    `Đáp án đúng: ${puzzle.target}.`,
    `Số gợi ý đã mở: ${openedCount}/${TOTAL_CLUES}.`,
    `Các lượt đoán/bỏ qua: ${
      history.length
        ? history
            .map((turn, index) =>
              turn.type === 'skip' ? `Lượt ${index + 1}: bỏ qua` : `Lượt ${index + 1}: "${turn.value}"`
            )
            .join('; ')
        : 'không có'
    }.`,
    `Giải thích đáp án: ${puzzle.explanation}`,
  ].join('\n');

  return (
    <div className="playable-panel">
      <div className="playable-header">
        <div className="playable-title">
          <HelpCircle size={20} />
          <span>Đoán thuật ngữ ẩn</span>
        </div>
        <div style={{ color: '#cbd5e1', fontSize: '13px', fontWeight: 700 }}>
          Gợi ý {openedCount}/{TOTAL_CLUES}
        </div>
      </div>

      {status !== 'summary' ? (
        <div className="playable-body">
          <p className="playable-sub">
            {courseName} · Đoán càng sớm điểm càng cao · Mỗi lượt sai hoặc bỏ qua mở thêm 1 gợi ý
          </p>

          <div className="mystery-question">
            <div className="mystery-question-head">
              <span className="mystery-eyebrow">
                <HelpCircle size={13} /> Câu hỏi mở đầu
              </span>
              <span className="mystery-chip">Lĩnh vực: {puzzle.category}</span>
            </div>
            <p className="mystery-question-text">“{puzzle.vagueQuestion}”</p>
          </div>

          <div className="mystery-clue-grid">
            {puzzle.clues.map((clue, index) => {
              const opened = index < openedCount;
              return (
                <div key={index} className={`mystery-clue ${opened ? 'opened' : 'locked'}`}>
                  <div className="mystery-clue-icon">
                    {opened ? <Unlock size={13} /> : <Lock size={13} />}
                  </div>
                  <div className="mystery-clue-content">
                    <span className="mystery-clue-label">Gợi ý #{index + 1}</span>
                    <p>
                      {opened
                        ? clue
                        : `Đang úp · mở sau ${index} lượt đoán sai hoặc bỏ qua`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {history.length > 0 && (
            <div className="mystery-history">
              <span className="playable-mistake-label">Diễn biến lượt chơi:</span>
              {renderTurnChips()}
            </div>
          )}

          <form className={`mystery-form ${shakeInput ? 'shake' : ''}`} onSubmit={handleGuessSubmit}>
            <input
              type="text"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Nhập tên thuật ngữ hoặc khái niệm bí mật…"
              className="mystery-input"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <div className="mystery-form-actions">
              <button
                type="button"
                className="playable-btn ghost mystery-skip-btn"
                onClick={handleSkip}
                disabled={!canSkip}
                title={
                  canSkip
                    ? 'Bỏ qua lượt này để mở gợi ý tiếp theo'
                    : 'Đã hết lượt bỏ qua hoặc đã mở hết gợi ý'
                }
              >
                <SkipForward size={14} /> Bỏ qua ({skipsRemaining})
              </button>
              <button
                type="submit"
                className="playable-btn primary"
                disabled={!inputValue.trim()}
              >
                <Send size={14} /> Kiểm tra
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="playable-summary">
          <div className={`playable-summary-icon ${isWon ? 'won' : 'lost'}`}>
            {isWon ? <CheckCircle2 size={26} /> : <XCircle size={26} />}
          </div>
          <p className="playable-eyebrow">KẾT QUẢ ĐOÁN THUẬT NGỮ</p>
          <h2>
            {isWon ? `Chính xác! ${score}/${MAX_SCORE} điểm` : `0/${MAX_SCORE} điểm`}
          </h2>
          <div className="playable-ai-feedback">
            <Lightbulb size={17} />
            <span>
              {isWon
                ? `Bạn đoán trúng tại Gợi ý #${openedCount}. ${
                    TOTAL_CLUES - openedCount > 0
                      ? `${TOTAL_CLUES - openedCount} gợi ý còn lại đã được mở tự động để bạn đối chiếu.`
                      : 'Bạn đã dùng trọn 10 gợi ý để tìm ra đáp án.'
                  }`
                : `Bạn đã dùng hết ${TOTAL_CLUES} lượt thử. Đáp án và toàn bộ gợi ý ở bên dưới.`}
            </span>
          </div>
          <div className="playable-recommendation">
            <Sparkles size={17} />
            <span>
              <strong style={{ color: '#b92b47' }}>Đáp án: {puzzle.target}.</strong>{' '}
              {puzzle.explanation}
            </span>
          </div>

          <PlayableAIFeedback
            courseId={courseId}
            courseName={courseName}
            userId={userId}
            activityType="mystery_concept"
            activityLabel="Đoán thuật ngữ ẩn"
            score={score}
            total={MAX_SCORE}
            sessionSummary={aiSessionSummary}
          />

          {history.length > 0 && (
            <div className="mystery-guess-log">
              <span className="playable-mistake-label">
                Các lượt đoán của bạn ({history.length}) — đúng màu xanh, sai màu đỏ:
              </span>
              {renderTurnChips()}
            </div>
          )}

          <div className="playable-review">
            <span className="playable-mistake-label">Toàn bộ {TOTAL_CLUES} gợi ý của khái niệm:</span>
            <div className="playable-review-list">
              {puzzle.clues.map((clue, index) => {
                const openedDuringPlay = index < openedCount;
                return (
                  <div
                    key={index}
                    className={`mystery-review-item ${openedDuringPlay ? 'opened' : 'auto-revealed'}`}
                  >
                    <span className="mystery-review-num">#{index + 1}</span>
                    <span className="mystery-review-text">{clue}</span>
                    {!openedDuringPlay && (
                      <span className="mystery-auto-tag">Tự động mở khi hoàn thành</span>
                    )}
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
