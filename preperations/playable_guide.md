# Hướng dẫn Kỹ thuật Phase 3: Playables trong Không gian Học tập (`lms-assistant`)

Tài liệu này hướng dẫn triển khai chi tiết phân hệ **6 trò chơi ôn tập hằng ngày (Playables)** tích hợp song song với tính năng **Tạo Đề Thi Trắc Nghiệm Tự Động** hiện có.

**Nguyên tắc kiến trúc của Phase 3:**
* **100% Client-Side & Stateless:** Chạy hoàn toàn trên trình duyệt bằng **Puter.js** và `localStorage`, không ghi thêm dữ liệu xuống Supabase hay Firestore.
* **1-Pass Generation (Không gọi AI cuối ván):** Puter.js chỉ được gọi **1 lần duy nhất** khi bắt đầu trò chơi để sinh toàn bộ dữ liệu kèm sẵn giải thích ngắn (`explanation`) cho từng câu.
* **Giới hạn 1 lượt/ngày/môn học:** Tối ưu trải nghiệm ôn tập hằng ngày và tránh quá tải hạn mức AI trên trình duyệt.

---

## 1. Cơ chế Giới hạn 1 Lượt/Ngày/Môn & Chống Gọi Trùng Puter (`lib/playable/playable-limit.ts`)

Quản lý trạng thái theo ngày trong `localStorage` để đảm bảo mỗi trò chơi chỉ được chơi 1 lượt/ngày cho mỗi môn học, đồng thời giữ lại bàn chơi đang dở nếu người dùng lỡ tay bấm `F5` giữa chừng (tránh mất lượt hoặc gọi lại Puter.js lần 2).

```ts
// lib/playable/playable-limit.ts
export type PlayableType =
  | "mystery_concept" // Đoán thuật ngữ ẩn (kiểu Statle)
  | "speed_matching"  // Nối cặp tốc độ 45s
  | "spot_the_bug"    // Bắt lỗi 1 chạm
  | "rapid_swipe"     // Thẻ quẹt Đúng/Sai 30s
  | "crossword"       // Ô chữ kiến thức
  | "concept_bingo";  // Bingo phân loại 4x3

export interface DailyPlayableRecord<T = unknown> {
  status: "in_progress" | "completed";
  data: T;              // Lưu bộ câu hỏi đã sinh để F5 giữa chừng vẫn chơi tiếp được
  score?: number;
  maxScore?: number;
  completedAt?: string;
}

function getTodayKey(): string {
  // Lấy ngày theo múi giờ local (YYYY-MM-DD)
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

export function getStorageKey(
  userId: number,
  courseId: number,
  type: PlayableType
): string {
  return `lms_play_${userId}_${courseId}_${type}_${getTodayKey()}`;
}

export function getDailyPlayable<T>(
  userId: number,
  courseId: number,
  type: PlayableType
): DailyPlayableRecord<T> | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(getStorageKey(userId, courseId, type));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DailyPlayableRecord<T>;
  } catch {
    return null;
  }
}

export function saveDailyPlayable<T>(
  userId: number,
  courseId: number,
  type: PlayableType,
  record: DailyPlayableRecord<T>
): void {
  if (typeof window === "undefined") return;
  // Tự động dọn các key của những ngày cũ để tránh đầy localStorage
  Object.keys(localStorage).forEach((k) => {
    if (k.startsWith("lms_play_") && !k.endsWith(getTodayKey())) {
      localStorage.removeItem(k);
    }
  });
  localStorage.setItem(getStorageKey(userId, courseId, type), JSON.stringify(record));
}
```

**Luồng kiểm soát trạng thái:**
1. Khi bấm **Chơi ngay**: Gọi `getDailyPlayable(userId, courseId, type)`.
2. Nếu `status === "completed"` $\rightarrow$ Khóa nút chơi, hiển thị kết quả đã đạt trong ngày hôm nay.
3. Nếu `status === "in_progress"` $\rightarrow$ Nạp lại `record.data` từ `localStorage` để tiếp tục ván chơi mà không gọi Puter.js.
4. Chỉ khi trả về `null` (chưa chơi hôm nay) mới gọi Puter.js sinh dữ liệu, lưu ngay với `status: "in_progress"`, và cập nhật thành `status: "completed"` khi kết thúc ván.

---

## 2. Bộ Sinh Dữ liệu 1-Pass từ Puter.js (`lib/playable/playable-generator.ts`)

Mỗi prompt ép mô hình trả về JSON thuần kèm sẵn trường `explanation` (giải thích ngắn 1–2 câu) để UI hiển thị ngay lập tức khi người chơi trả lời sai hoặc hết giờ.

```ts
// lib/playable/playable-generator.ts
import { PlayableType } from "./playable-limit";

declare global {
  interface Window {
    puter?: {
      ai: {
        chat: (prompt: string, options?: { model?: string }) => Promise<unknown>;
      };
    };
  }
}

// Bóc tách JSON an toàn kể cả khi LLM bọc trong ```json ... ``` hoặc thêm lời dẫn
function parseAIJson<T>(rawResponse: unknown): T {
  const text =
    typeof rawResponse === "string"
      ? rawResponse
      : (rawResponse as { message?: { content?: string } })?.message?.content ??
        String(rawResponse);

  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const firstBracket = Math.min(
    cleaned.indexOf("{") === -1 ? Infinity : cleaned.indexOf("{"),
    cleaned.indexOf("[") === -1 ? Infinity : cleaned.indexOf("[")
  );
  const lastBracket = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));

  if (firstBracket === Infinity || lastBracket === -1) {
    throw new Error("AI không trả về định dạng JSON hợp lệ.");
  }
  return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1)) as T;
}

export async function generatePlayableData<T>(
  type: PlayableType,
  courseName: string,
  materialContext: string
): Promise<T> {
  if (typeof window === "undefined" || !window.puter) {
    throw new Error("Puter SDK chưa sẵn sàng trên trình duyệt.");
  }

  // Giới hạn ngữ cảnh tối đa 6000 ký tự để Puter phản hồi nhanh dưới 3 giây
  const context = materialContext.slice(0, 6000);
  const prompt = buildPromptByType(type, courseName, context);

  const response = await window.puter.ai.chat(prompt);
  return parseAIJson<T>(response);
}

function buildPromptByType(
  type: PlayableType,
  courseName: string,
  context: string
): string {
  const baseHeader = `Bạn là chuyên gia thiết kế trò chơi học thuật cho môn "${courseName}". Dựa vào tài liệu dưới đây, hãy tạo dữ liệu trò chơi bằng tiếng Việt (giữ nguyên thuật ngữ chuyên ngành tiếng Anh nếu cần).\nTÀI LIỆU:\n${context}\n\nYÊU CẦU BẮT BUỘC: Chỉ trả về duy nhất 1 object JSON hợp lệ, không markdown, không giải thích thêm.\n`;

  switch (type) {
    case "mystery_concept":
      return `${baseHeader}
Chọn 1 khái niệm/công nghệ/thuật toán quan trọng trong tài liệu làm đáp án bí mật. Tạo 5 gợi ý đi từ mơ hồ (tổng quan) đến đặc thù (chi tiết kỹ thuật), TUYỆT ĐỐI KHÔNG nhắc tên đáp án trong 5 gợi ý.
Schema JSON:
{
  "target": "Tên đáp án chuẩn",
  "acceptedAnswers": ["ten viet thuong", "ten viet tat hoac dong nghia"],
  "category": "Nhóm chủ đề (VD: Framework, Giao thức, Cấu trúc dữ liệu)",
  "clues": ["Gợi ý 1", "Gợi ý 2", "Gợi ý 3", "Gợi ý 4", "Gợi ý 5"],
  "explanation": "Giải thích tóm tắt 1-2 câu về đáp án."
}`;

    case "speed_matching":
      return `${baseHeader}
Tạo 8 cặp thuật ngữ - định nghĩa ngắn gọn để chơi nối cặp tốc độ 45 giây. Vế phải tối đa 8 từ.
Schema JSON:
{
  "pairs": [
    { "id": "1", "left": "Thuật ngữ / Hàm", "right": "Định nghĩa ngắn <= 8 từ" }
  ]
}`;

    case "spot_the_bug":
      return `${baseHeader}
Tạo 5 thử thách tìm lỗi sai. Mỗi thử thách chia 1 đoạn code ngắn hoặc 1 phát biểu lý thuyết thành mảng các đoạn nhỏ (tokens), trong đó có đúng 1 phần tử bị lỗi logic/cú pháp/sai bản chất.
Schema JSON:
{
  "challenges": [
    {
      "prompt": "Yêu cầu ngắn gọn (VD: Chạm vào phần gây lỗi)",
      "tokens": ["đoạn 1", "đoạn 2", "đoạn lỗi", "đoạn 4"],
      "bugIndex": 2,
      "fixOptions": ["Cách sửa A", "Cách sửa B", "Cách sửa C"],
      "correctFixIndex": 0,
      "explanation": "Giải thích ngắn vì sao sai."
    }
  ]
}`;

    case "rapid_swipe":
      return `${baseHeader}
Tạo 12 mệnh đề nhận định ngắn (1 câu/mệnh đề) để chơi quẹt Đúng/Sai trong 30 giây. Tỷ lệ 6 câu đúng, 6 câu sai.
Schema JSON:
{
  "cards": [
    {
      "id": "1",
      "statement": "Mệnh đề nhận định ngắn gọn",
      "isTrue": true,
      "explanation": "Giải thích ngắn gọn."
    }
  ]
}`;

    case "crossword":
      return `${baseHeader}
Tạo 8 từ khóa quan trọng trong tài liệu để xếp ô chữ. Từ khóa BẮT BUỘC viết IN HOA, liền không dấu, không khoảng trắng, không ký tự đặc biệt, độ dài 4-12 ký tự.
Schema JSON:
{
  "words": [
    { "word": "CAPACITOR", "clue": "Gợi ý định nghĩa ngắn gọn" }
  ]
}`;

    case "concept_bingo":
      return `${baseHeader}
Tạo bàn chơi Bingo phân loại gồm đúng 12 nhóm tiêu chí (categories) riêng biệt và 15 thẻ khái niệm/ví dụ (cards) thuộc về các nhóm đó (12 thẻ khớp 12 ô + 3 thẻ dự phòng khi người chơi bấm Skip).
Schema JSON:
{
  "categories": [
    { "id": "c1", "label": "Tên nhóm tiêu chí ngắn" }
  ],
  "cards": [
    {
      "id": "k1",
      "term": "Tên khái niệm / ví dụ",
      "validCategoryIds": ["c1"],
      "explanation": "Giải thích ngắn vì sao thuộc nhóm này."
    }
  ]
}`;
  }
}
```

---

## 3. Chi tiết Cài đặt Từng Trò chơi

### 3.1. Đoán thuật ngữ ẩn (`MysteryConceptGame.tsx` — Kiểu Statle)
* **Hiển thị khởi đầu:** Chủ đề (`category`), 5 khung gợi ý (mở sẵn `clues[0]`, 4 khung còn lại khóa với nhãn *"Đoán sai để mở khóa"*), và 5 biểu tượng mạng.
* **Xử lý khi người chơi nhập đáp án và bấm Kiểm tra:**
  * Chuẩn hóa chuỗi (`input.trim().toLowerCase()`), đối chiếu với mảng `acceptedAnswers`.
  * **Đoán đúng:** Mở toàn bộ 5 gợi ý, hiển thị thẻ chúc mừng + `explanation`, lưu `status: "completed"`.
  * **Đoán sai:** Tăng `wrongCount`, mở khóa `clues[wrongCount]`. Tại **lượt sai thứ 3** (còn 2 mạng cuối), hiển thị thêm mặt nạ ký tự tự động tạo từ `target` (ví dụ: `Capacitor` $\rightarrow$ `C _ _ _ _ _ _ _ r`).
  * **Hết 5 mạng:** Công bố đáp án `target` + `explanation` và lưu `status: "completed"` (`score: 0`).

```ts
// Helper tạo gợi ý mặt nạ ký tự ở lượt sai thứ 3
export function buildWordMask(target: string): string {
  return target
    .split(" ")
    .map((word) => {
      if (word.length <= 2) return word[0] + "_".repeat(word.length - 1);
      return `${word[0]} ${"_ ".repeat(word.length - 2)}${word[word.length - 1]}`;
    })
    .join("   ");
}
```

### 3.2. Thuật toán Xếp lưới Ô chữ Tự động (`lib/playable/crossword-layout.ts`)
Thay vì để AI tự tính tọa độ lưới 2D (dễ gây lệch chữ), thuật toán dưới đây nhận danh sách `{ word, clue }` từ Puter.js và tự dựng lưới giao cắt trên trình duyệt trong $< 5\text{ms}$, đồng thời xuất ra trường `unlockedBy` phục vụ 3 cấp độ khó (**Dễ**: mở hết gợi ý; **Bình thường / Khó**: giải xong từ gốc mới mở khóa gợi ý từ giao cắt).

```ts
// lib/playable/crossword-layout.ts
export interface PlacedWord {
  id: number;
  word: string;
  clue: string;
  row: number;
  col: number;
  direction: "across" | "down";
  unlockedBy?: number; // ID của từ cần giải trước để mở gợi ý (dùng cho mode Normal/Hard)
}

export function generateCrosswordGrid(
  rawWords: { word: string; clue: string }[]
): { grid: (string | null)[][]; placedWords: PlacedWord[] } {
  const SIZE = 15;
  const grid: (string | null)[][] = Array.from({ length: SIZE }, () =>
    Array(SIZE).fill(null)
  );
  const sorted = [...rawWords]
    .map((w) => ({ ...w, word: w.word.toUpperCase().replace(/[^A-Z0-9]/g, "") }))
    .filter((w) => w.word.length >= 3 && w.word.length <= 12)
    .sort((a, b) => b.word.length - a.word.length);

  const placedWords: PlacedWord[] = [];
  if (sorted.length === 0) return { grid, placedWords };

  // Đặt từ dài nhất nằm ngang ở giữa lưới
  const first = sorted[0];
  const startRow = Math.floor(SIZE / 2);
  const startCol = Math.floor((SIZE - first.word.length) / 2);
  for (let i = 0; i < first.word.length; i++) {
    grid[startRow][startCol + i] = first.word[i];
  }
  placedWords.push({
    id: 1,
    ...first,
    row: startRow,
    col: startCol,
    direction: "across",
  });

  // Tìm điểm giao cắt cho các từ còn lại
  for (let wIdx = 1; wIdx < sorted.length; wIdx++) {
    const candidate = sorted[wIdx];
    let placed = false;

    for (const existing of placedWords) {
      if (placed) break;
      const newDir = existing.direction === "across" ? "down" : "across";

      for (let i = 0; i < existing.word.length; i++) {
        if (placed) break;
        for (let j = 0; j < candidate.word.length; j++) {
          if (existing.word[i] !== candidate.word[j]) continue;

          const intersectR =
            existing.direction === "across" ? existing.row : existing.row + i;
          const intersectC =
            existing.direction === "across" ? existing.col + i : existing.col;
          const r = newDir === "down" ? intersectR - j : intersectR;
          const c = newDir === "across" ? intersectC - j : intersectC;

          if (canPlaceWord(grid, candidate.word, r, c, newDir)) {
            for (let k = 0; k < candidate.word.length; k++) {
              const curR = newDir === "down" ? r + k : r;
              const curC = newDir === "across" ? c + k : c;
              grid[curR][curC] = candidate.word[k];
            }
            placedWords.push({
              id: placedWords.length + 1,
              ...candidate,
              row: r,
              col: c,
              direction: newDir,
              unlockedBy: existing.id,
            });
            placed = true;
            break;
          }
        }
      }
    }
  }

  return { grid, placedWords };
}

function canPlaceWord(
  grid: (string | null)[][],
  word: string,
  row: number,
  col: number,
  dir: "across" | "down"
): boolean {
  const SIZE = grid.length;
  if (row < 0 || col < 0) return false;
  if (dir === "across" && col + word.length > SIZE) return false;
  if (dir === "down" && row + word.length > SIZE) return false;

  // Kiểm tra ô liền trước và liền sau từ không bị dính chữ khác
  const beforeR = dir === "down" ? row - 1 : row;
  const beforeC = dir === "across" ? col - 1 : col;
  const afterR = dir === "down" ? row + word.length : row;
  const afterC = dir === "across" ? col + word.length : col;
  if (beforeR >= 0 && beforeC >= 0 && grid[beforeR][beforeC] !== null) return false;
  if (afterR < SIZE && afterC < SIZE && grid[afterR][afterC] !== null) return false;

  let intersections = 0;
  for (let k = 0; k < word.length; k++) {
    const r = dir === "down" ? row + k : row;
    const c = dir === "across" ? col + k : col;
    const cell = grid[r][c];

    if (cell !== null) {
      if (cell !== word[k]) return false;
      intersections++;
    } else {
      // Không để hai từ song song dính sát nhau
      const adj1 = dir === "across" ? grid[r - 1]?.[c] : grid[r]?.[c - 1];
      const adj2 = dir === "across" ? grid[r + 1]?.[c] : grid[r]?.[c + 1];
      if (adj1 !== null && adj1 !== undefined) return false;
      if (adj2 !== null && adj2 !== undefined) return false;
    }
  }
  return intersections === 1;
}
```

### 3.3. Thiết kế State & Tương tác 4 Trò chơi Còn lại

| Component | Cấu trúc State & Cơ chế Tương tác |
| :--- | :--- |
| **`SpeedMatchingGame.tsx`** | • `visiblePairs` (5 cặp trên 2 cột, xáo trộn thứ tự), `queue` (3 cặp dự bị), `timeLeft = 45`.<br>• Chọn 1 thẻ trái + 1 thẻ phải: khớp $\rightarrow$ khóa xanh và thay thế cặp đó bằng phần tử đầu của `queue`; lệch $\rightarrow$ rung đỏ 300ms và trừ $2\text{s}$ (`Math.max(0, t - 2)`). |
| **`SpotTheBugGame.tsx`** | • `currentIndex` ($0 \dots 4$), `step: "find_bug" \| "pick_fix" \| "revealed"`.<br>• Bước `find_bug`: Render `tokens` thành các khối bấm được. Chạm đúng `bugIndex` $\rightarrow$ mở 3 nút `fixOptions`; chạm sai $\rightarrow$ tô đỏ khối đó, hiện ngay `explanation` rồi sang câu kế. |
| **`RapidSwipeGame.tsx`** | • `cardIndex` ($0 \dots 11$), `timeLeft = 30`, `streak`.<br>• Hỗ trợ cả 3 thao tác: bấm nút **Sai / Đúng**, kéo thả chuột/cảm ứng (`onPointerDown` / `onPointerUp` khi lệch $> 60\text{px}$), và phím mũi tên `ArrowLeft` / `ArrowRight`. |
| **`ConceptBingoGame.tsx`** | • Lưới $4 \times 3$ (12 ô `categories`), `matchedMap: Record<categoryId, card>`, `timeLeft` (`null` \| `90` \| `60`).<br>• Nút **Skip** đẩy thẻ hiện tại xuống cuối hàng đợi `cards` để bốc thẻ tiếp theo; chạm đúng ô phân loại trong lưới $4 \times 3$ sẽ khóa thẻ vào ô đó cho đến khi lấp đủ $12/12$ ô. |

---

## 4. Tích hợp vào Giao diện Không gian Học tập Hiện có

Giữ nguyên bố cục 2 cột hiện tại của trang Không gian học tập:

1. **Dùng chung cột Nguồn tài liệu bên trái:**
   * Gom văn bản trích xuất của các tài liệu đang được đánh dấu (`checkedMaterials`) thành chuỗi `materialContext`.
   * Nếu chưa chọn tài liệu nào, khóa nút bắt đầu trò chơi và hiển thị thông báo *"Vui lòng chọn ít nhất 1 nguồn tài liệu bên trái"*.
2. **Đặt thanh chuyển Tab ngay đầu khung bên phải:**
   * **Tab 1 — `Tạo đề trắc nghiệm`:** Giữ nguyên 100% giao diện tạo đề 10–50 câu hiện tại.
   * **Tab 2 — `Trò chơi ôn tập hằng ngày`:** Hiển thị lưới 6 thẻ trò chơi (`Đoán thuật ngữ ẩn`, `Ô chữ kiến thức`, `Bingo phân loại 4x3`, `Nối cặp tốc độ 45s`, `Bắt lỗi 1 chạm`, `Thẻ quẹt Đúng/Sai 30s`).
3. **Hiển thị trạng thái lượt chơi trên từng thẻ:**
   * Khi component mount, gọi `getDailyPlayable(userId, courseId, type)` để gắn nhãn trạng thái lên từng thẻ:
     * Chưa chơi: Badge xanh **`1 lượt hôm nay`** $\rightarrow$ bấm vào gọi `generatePlayableData()` từ Puter.js.
     * Đang chơi dở: Badge vàng **`Tiếp tục ván dở`** $\rightarrow$ nạp lại ngay từ `localStorage` không tốn lượt AI.
     * Đã hoàn thành: Badge xám **`Đã xong hôm nay`** kèm điểm số $\rightarrow$ khóa nút chơi đến ngày hôm sau.