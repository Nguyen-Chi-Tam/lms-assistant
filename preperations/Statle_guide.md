# Hướng dẫn Triển khai Chi tiết: Đoán Thuật ngữ Ẩn (`mystery_concept` — Cơ chế 10 Gợi ý)

Tài liệu này cập nhật thiết kế luật chơi, prompt Puter.js và mã nguồn React hoàn chỉnh cho trò chơi **Đoán thuật ngữ ẩn** vận hành theo cơ chế mở 10 dữ kiện (lấy cảm hứng từ vòng đoán từ khóa của *Vì bạn xứng đáng*) trong Không gian học tập của `lms-assistant`.

---

## 1. Luật chơi & Cơ chế Vận hành

1. **Khởi đầu ván chơi (Mở 1 — Úp 9):**
   * Hệ thống đưa ra **1 câu hỏi mở đầu thật mơ hồ** (`vagueQuestion`) kèm nhãn chủ đề (`category`).
   * Mở sẵn **Gợi ý #1** (dữ kiện rộng và mơ hồ nhất), đồng thời **úp kín 9 gợi ý còn lại** (từ Gợi ý #2 đến Gợi ý #10).
2. **Vòng lặp đoán đáp án & Bỏ qua (Tối đa $10$ lượt):**
   * Ở mỗi lượt, người chơi có 2 lựa chọn:
     * **Nhập đáp án & bấm Kiểm tra:** Nếu sai, hệ thống ghi nhận đáp án sai và **mở tiếp 1 gợi ý kế tiếp**.
     * **Bấm Bỏ qua (tối đa $3$ lượt):** Không cần nhập đáp án, hệ thống bỏ qua lượt hiện tại và **mở ngay gợi ý tiếp theo** để thu hẹp phạm vi. (Khi đã dùng hết $3$ lượt bỏ qua hoặc đã mở tới Gợi ý #10, nút *Bỏ qua* sẽ khóa lại).
   * Tổng số lượt thử tối đa tương ứng với $10$ gợi ý: nếu đã mở hết cả $10$ gợi ý mà lượt đoán cuối vẫn sai, trò chơi kết thúc với $0$ điểm và công bố đáp án.
3. **Màn hình kết thúc khi đoán đúng:**
   * Ngay khi người chơi đoán trúng đáp án ở bất kỳ gợi ý thứ $k$ nào ($1 \le k \le 10$), màn hình chiến thắng sẽ **tự động lật mở toàn bộ các gợi ý còn lại chưa mở** (gắn nhãn *"Tự động mở khi hoàn thành"*) để sinh viên đối chiếu trọn vẹn $10$ đặc điểm của khái niệm, kèm giải thích tổng kết (`explanation`) và khóa lượt chơi trong ngày (`status: "completed"`).
4. **Thang điểm khuyến khích đoán sớm:**
   * Đoán trúng ngay tại Gợi ý #1 đạt tối đa $100$ điểm; mỗi lượt đoán sai hoặc bỏ qua trừ $10$ điểm (tối thiểu $10$ điểm nếu đoán đúng ở Gợi ý #10):
     $$\text{Score} = \max(10,\; 100 - \text{wrongOrSkipCount} \times 10)$$

---

## 2. Cấu trúc Dữ liệu & Prompt Puter.js (`types/mystery-concept.ts`)

### 2.1. Định nghĩa TypeScript
```ts
// types/mystery-concept.ts
export interface MysteryConceptData {
  vagueQuestion: string;     // 1 câu hỏi mở đầu thật mơ hồ (VD: "Tôi là một cơ chế âm thầm giữ cho dữ liệu luôn nhất quán, tôi là ai?")
  target: string;            // Đáp án chuẩn hiển thị khi kết thúc
  acceptedAnswers: string[]; // Các biến thể chấp nhận đúng (viết thường, viết tắt, không dấu...)
  category: string;          // Nhóm lĩnh vực (VD: "Cơ sở dữ liệu", "Kinh tế vi mô", "Luật dân sự")
  clues: string[];           // Mảng đúng 10 gợi ý sắp xếp từ siêu mơ hồ (#1) -> rất cụ thể (#10)
  explanation: string;       // Giải thích tóm tắt 1-2 câu về bản chất đối tượng
}

export interface GuessTurn {
  type: "guess" | "skip";
  value?: string;            // Nội dung đã nhập nếu type === "guess"
}

export interface MysteryConceptSession {
  puzzle: MysteryConceptData;
  history: GuessTurn[];      // Lưu toàn bộ lịch sử từng lượt để F5 giữa chừng vẫn khôi phục nguyên trạng
  isWon: boolean;
}
```

### 2.2. Prompt 1-Pass cho Puter.js (Đa chuyên ngành)
```ts
// lib/mystery-concept-prompt.ts
export function buildMysteryConceptPrompt(
  courseName: string,
  materialContext: string
): string {
  return `
Bạn là người dẫn chương trình thiết kế trò chơi "Đoán thuật ngữ ẩn" (10 gợi ý) cho môn "${courseName}".
Dựa vào tài liệu học tập bên dưới, hãy chọn DUY NHẤT 1 đối tượng kiến thức cốt lõi (khái niệm, thuật toán, giao thức, học thuyết, quy định, cấu trúc hoặc hiện tượng) làm đáp án bí mật.

QUY TẮC THIẾT KẾ CÂU HỎI & 10 GỢI Ý (BẮT BUỘC):
1. "vagueQuestion": Viết 1 câu hỏi mở đầu thật mơ hồ, mang tính đố vui tổng quát để khơi gợi tò mò (tuyệt đối không để lộ tên hay từ khóa đặc trưng).
2. "clues": Tạo ĐÚNG 10 gợi ý ngắn gọn (mỗi gợi ý 1 câu), sắp xếp tăng dần độ rõ ràng:
   - Gợi ý 1-3: Rất mơ hồ (bối cảnh xuất hiện, vai trò chung, lĩnh vực áp dụng).
   - Gợi ý 4-7: Thu hẹp dần (đặc điểm hoạt động, cấu trúc, điểm khác biệt với khái niệm tương tự).
   - Gợi ý 8-10: Rất sát đáp án (tình huống sử dụng điển hình, dấu hiệu nhận biết đặc thù nhất).
3. TUYỆT ĐỐI KHÔNG chứa từ khóa đáp án ("target") hoặc từ viết tắt của nó trong "vagueQuestion" và cả 10 "clues".
4. "target" ngắn gọn từ 1 đến 4 từ (tối đa 30 ký tự). "acceptedAnswers" liệt kê đầy đủ các biến thể viết thường, viết tắt hoặc thuật ngữ tương đương.
5. Chỉ trả về duy nhất 1 object JSON hợp lệ, không bọc markdown, không giải thích thêm:

{
  "vagueQuestion": "Câu hỏi mở đầu thật mơ hồ...",
  "target": "Tên đáp án chuẩn",
  "acceptedAnswers": ["dap an 1", "dap an 2"],
  "category": "Nhóm chủ đề ngắn gọn",
  "clues": [
    "Gợi ý 1 (Mơ hồ nhất)",
    "Gợi ý 2",
    "Gợi ý 3",
    "Gợi ý 4",
    "Gợi ý 5",
    "Gợi ý 6",
    "Gợi ý 7",
    "Gợi ý 8",
    "Gợi ý 9",
    "Gợi ý 10 (Sát đáp án nhất)"
  ],
  "explanation": "Giải thích súc tích 1-2 câu tổng kết lại khái niệm này."
}

TÀI LIỆU MÔN HỌC:
${materialContext.slice(0, 6000)}
`;
}
```

---

## 3. Thuật toán Chuẩn hóa Đáp án (`lib/mystery-concept-utils.ts`)

```ts
// lib/mystery-concept-utils.ts
import { MysteryConceptData } from "@/types/mystery-concept";

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[-_/\\.,()]+/g, " ")
    .replace(/\s+/g, " ");
}

export function removeVietnameseTones(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function isGuessCorrect(userGuess: string, puzzle: MysteryConceptData): boolean {
  const cleanGuess = normalizeText(userGuess);
  if (!cleanGuess) return false;

  const noToneGuess = removeVietnameseTones(cleanGuess);
  const candidates = [puzzle.target, ...(puzzle.acceptedAnswers || [])];

  return candidates.some((ans) => {
    const cleanAns = normalizeText(ans);
    if (!cleanAns) return false;
    return (
      cleanGuess === cleanAns ||
      noToneGuess === removeVietnameseTones(cleanAns)
    );
  });
}
```

---

## 4. Mã nguồn Component Giao diện (`components/playables/MysteryConceptGame.tsx`)

Component dưới đây quản lý trọn vẹn luồng **mở 1 — úp 9**, nút **Bỏ qua (tối đa 3 lượt)**, tự động **mở các gợi ý còn lại khi đoán đúng** và lưu trạng thái vào `localStorage` để chống mất lượt khi `F5`:

```tsx
"use client";

import React, { useState } from "react";
import {
  HelpCircle,
  Lock,
  Unlock,
  Send,
  SkipForward,
  CheckCircle2,
  XCircle,
  Sparkles,
  ArrowLeft,
  Eye,
} from "lucide-react";
import { MysteryConceptSession, GuessTurn } from "@/types/mystery-concept";
import { isGuessCorrect } from "@/lib/mystery-concept-utils";
import { saveDailyPlayable } from "@/lib/playable-limit";

interface MysteryConceptGameProps {
  userId: number;
  courseId: number;
  courseName: string;
  initialSession: MysteryConceptSession;
  onBack: () => void;
}

const TOTAL_CLUES = 10;
const MAX_SKIPS = 3;

export function MysteryConceptGame({
  userId,
  courseId,
  courseName,
  initialSession,
  onBack,
}: MysteryConceptGameProps) {
  const [session, setSession] = useState<MysteryConceptSession>(initialSession);
  const [inputValue, setInputValue] = useState("");
  const [shakeInput, setShakeInput] = useState(false);

  const { puzzle, history, isWon } = session;

  // Số lượt đã dùng (đoán sai hoặc bỏ qua) trước khi thắng hoặc kết thúc
  const wrongOrSkipCount = isWon ? Math.max(0, history.length - 1) : history.length;
  const skipsUsed = history.filter((turn) => turn.type === "skip").length;
  const skipsRemaining = Math.max(0, MAX_SKIPS - skipsUsed);

  // Số gợi ý đã được mở trong quá trình chơi (tối thiểu 1, tối đa 10)
  const openedDuringPlayCount = Math.min(TOTAL_CLUES, wrongOrSkipCount + 1);

  // Kết thúc khi đoán đúng HOẶC đã dùng hết cả 10 lượt tương ứng 10 gợi ý
  const isFinished = isWon || wrongOrSkipCount >= TOTAL_CLUES;

  // Chỉ được bỏ qua khi chưa kết thúc, còn lượt skip (<= 3) và vẫn còn gợi ý đang úp (< 10)
  const canSkip = !isFinished && skipsRemaining > 0 && openedDuringPlayCount < TOTAL_CLUES;

  const calculateScore = (won: boolean, failedTurns: number): number => {
    if (!won) return 0;
    return Math.max(10, 100 - failedTurns * 10);
  };

  const commitTurn = (turn: GuessTurn, won: boolean) => {
    const nextHistory = [...history, turn];
    const nextFailedTurns = won ? wrongOrSkipCount : wrongOrSkipCount + 1;
    const gameEnded = won || nextFailedTurns >= TOTAL_CLUES;

    const updatedSession: MysteryConceptSession = {
      puzzle,
      history: nextHistory,
      isWon: won,
    };

    setSession(updatedSession);

    saveDailyPlayable<MysteryConceptSession>(userId, courseId, "mystery_concept", {
      status: gameEnded ? "completed" : "in_progress",
      data: updatedSession,
      ...(gameEnded
        ? {
            score: calculateScore(won, nextFailedTurns),
            maxScore: 100,
            completedAt: new Date().toISOString(),
          }
        : {}),
    });
  };

  const handleGuessSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed || isFinished) return;

    // Chặn nhập trùng đáp án đã thử trước đó
    if (
      history.some(
        (t) => t.type === "guess" && t.value?.toLowerCase() === trimmed.toLowerCase()
      )
    ) {
      setShakeInput(true);
      setTimeout(() => setShakeInput(false), 400);
      return;
    }

    const correct = isGuessCorrect(trimmed, puzzle);
    setInputValue("");

    if (!correct) {
      setShakeInput(true);
      setTimeout(() => setShakeInput(false), 400);
    }

    commitTurn({ type: "guess", value: trimmed }, correct);
  };

  const handleSkipTurn = () => {
    if (!canSkip) return;
    setInputValue("");
    commitTurn({ type: "skip" }, false);
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-5 text-zinc-100">
      {/* Thanh điều hướng & Chỉ số lượt */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 text-zinc-300 transition cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Quay lại danh mục trò chơi
        </button>

        <div className="flex items-center gap-4 text-xs">
          <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300">
            Gợi ý đã mở:{" "}
            <strong className="text-fuchsia-400">
              {openedDuringPlayCount}/{TOTAL_CLUES}
            </strong>
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300">
            Bỏ qua còn lại:{" "}
            <strong className={skipsRemaining > 0 ? "text-amber-400" : "text-zinc-500"}>
              {skipsRemaining}/{MAX_SKIPS}
            </strong>
          </span>
        </div>
      </div>

      {/* Câu hỏi mở đầu mơ hồ */}
      <div className="p-5 rounded-2xl bg-gradient-to-br from-fuchsia-950/35 via-zinc-900/90 to-zinc-900/90 border border-fuchsia-500/30 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-fuchsia-400 text-xs font-semibold uppercase tracking-wider">
            <HelpCircle className="w-4 h-4" />
            <span>Câu hỏi mở đầu • {courseName}</span>
          </div>
          <span className="px-2.5 py-0.5 text-xs font-medium rounded-full bg-fuchsia-500/15 border border-fuchsia-500/30 text-fuchsia-300">
            Lĩnh vực: {puzzle.category}
          </span>
        </div>
        <p className="text-base md:text-lg font-medium text-zinc-100 leading-relaxed">
          “{puzzle.vagueQuestion}”
        </p>
      </div>

      {/* Lưới 10 Gợi ý (Mở 1 - Úp 9; Tự động mở nốt khi đoán đúng) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {puzzle.clues.slice(0, TOTAL_CLUES).map((clue, index) => {
          const openedNormally = index < openedDuringPlayCount;
          const revealedAtVictory = isWon && !openedNormally;
          const isVisible = openedNormally || revealedAtVictory;

          return (
            <div
              key={index}
              className={`p-3.5 rounded-xl border transition-all ${
                revealedAtVictory
                  ? "bg-emerald-950/20 border-emerald-500/30 text-zinc-200"
                  : openedNormally
                  ? "bg-zinc-900/90 border-fuchsia-500/35 text-zinc-100"
                  : "bg-zinc-950/50 border-zinc-800/70 text-zinc-500"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <div
                  className={`mt-0.5 p-1.5 rounded-lg shrink-0 ${
                    revealedAtVictory
                      ? "bg-emerald-500/20 text-emerald-300"
                      : openedNormally
                      ? "bg-fuchsia-500/20 text-fuchsia-300"
                      : "bg-zinc-800/80 text-zinc-500"
                  }`}
                >
                  {revealedAtVictory ? (
                    <Eye className="w-3.5 h-3.5" />
                  ) : openedNormally ? (
                    <Unlock className="w-3.5 h-3.5" />
                  ) : (
                    <Lock className="w-3.5 h-3.5" />
                  )}
                </div>

                <div className="flex-1 text-xs md:text-sm leading-relaxed">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="font-semibold text-[11px] uppercase tracking-wider text-zinc-400">
                      Gợi ý #{index + 1}
                    </span>
                    {revealedAtVictory && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        Chưa dùng • Mở tự động
                      </span>
                    )}
                  </div>

                  {isVisible ? (
                    <p>{clue}</p>
                  ) : (
                    <p className="italic text-zinc-600">Đang úp — Mở ở lượt thứ {index}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Lịch sử các lượt đã đoán / bỏ qua */}
      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-400">Diễn biến lượt chơi:</span>
          {history.map((turn, idx) => {
            if (turn.type === "skip") {
              return (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/10 border border-amber-500/30 text-amber-300"
                >
                  <SkipForward className="w-3 h-3" />
                  Bỏ qua (Lượt {idx + 1})
                </span>
              );
            }

            const isWinningTurn = isWon && idx === history.length - 1;
            return (
              <span
                key={idx}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${
                  isWinningTurn
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                    : "bg-rose-500/10 border-rose-500/30 text-rose-300 line-through"
                }`}
              >
                {isWinningTurn ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                {turn.value}
              </span>
            );
          })}
        </div>
      )}

      {/* Khu vực nhập đáp án + Nút Bỏ qua HOẶC Màn hình kết thúc */}
      {!isFinished ? (
        <form
          onSubmit={handleGuessSubmit}
          className={`flex flex-col sm:flex-row gap-2.5 ${shakeInput ? "animate-bounce" : ""}`}
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Nhập tên thuật ngữ hoặc khái niệm bí mật..."
            className="flex-1 px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 focus:border-fuchsia-500 focus:outline-none text-sm text-zinc-100 placeholder:text-zinc-500"
            autoFocus
          />

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSkipTurn}
              disabled={!canSkip}
              title={
                canSkip
                  ? "Bỏ qua lượt này để mở gợi ý tiếp theo"
                  : "Đã hết lượt bỏ qua hoặc đã mở hết gợi ý"
              }
              className="inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 disabled:opacity-40 text-amber-300 text-sm font-medium transition cursor-pointer"
            >
              <SkipForward className="w-4 h-4" />
              Bỏ qua ({skipsRemaining})
            </button>

            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 disabled:opacity-40 text-white text-sm font-semibold transition cursor-pointer"
            >
              <Send className="w-4 h-4" />
              Kiểm tra
            </button>
          </div>
        </form>
      ) : (
        <div
          className={`p-5 rounded-2xl border space-y-3 ${
            isWon
              ? "bg-emerald-950/30 border-emerald-500/40"
              : "bg-rose-950/30 border-rose-500/40"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-base">
              <Sparkles
                className={`w-5 h-5 ${isWon ? "text-emerald-400" : "text-rose-400"}`}
              />
              <span className={isWon ? "text-emerald-300" : "text-rose-300"}>
                {isWon
                  ? `Chính xác! Bạn đoán trúng tại Gợi ý #${openedDuringPlayCount} (Đã mở toàn bộ ${
                      TOTAL_CLUES - openedDuringPlayCount
                    } gợi ý còn lại)`
                  : `Đã dùng hết ${TOTAL_CLUES} lượt thử!`}
              </span>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-zinc-900 border border-zinc-700 text-zinc-200">
              {calculateScore(isWon, wrongOrSkipCount)} / 100 điểm
            </span>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-950/70 border border-zinc-800">
            <div className="text-xs text-zinc-400 mb-1">Đáp án chuẩn:</div>
            <div className="text-lg font-bold text-fuchsia-300">{puzzle.target}</div>
            <p className="text-sm text-zinc-300 mt-1.5 leading-relaxed">
              {puzzle.explanation}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
```