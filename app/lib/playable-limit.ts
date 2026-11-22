// app/lib/playable-limit.ts

export type PlayableType =
  | 'quiz'            // Trắc nghiệm 3 câu hỏi nhanh
  | 'mystery_concept' // Đoán thuật ngữ ẩn (kiểu Statle)
  | 'speed_matching'  // Nối cặp tốc độ 45s
  | 'spot_the_bug'    // Soi lỗi 1 chạm
  | 'rapid_swipe'     // Thẻ quẹt Đúng/Sai 30s
  | 'crossword'       // Ô chữ kiến thức
  | 'concept_bingo';  // Bingo phân loại 4x3

/** Nhận xét AI đã tạo cho ván chơi trong ngày, lưu chung với dữ liệu ván. */
export interface StoredPlayableAIFeedback {
  score: number;
  total: number;
  strengths: string;
  weaknesses: string;
  improved: string;
  not_improved: string;
  action_plan: string[];
  created_at: string;
}

export interface DailyPlayableRecord<T = unknown> {
  status: 'in_progress' | 'completed';
  data: T;              // Lưu bộ câu hỏi/dữ liệu đã sinh để F5 giữa chừng vẫn chơi tiếp được
  /** Chi tiết riêng của ván chơi (VD: cặp đã nối đúng / các lượt đoán) để màn kết thúc tô màu đúng-sai */
  detail?: unknown;
  score?: number;
  maxScore?: number;
  completedAt?: string;
  /** Nhận xét AI của ván này — tự động bị dọn cùng dữ liệu của ngày cũ. */
  aiFeedback?: StoredPlayableAIFeedback;
}

export function getTodayKey(): string {
  // Lấy ngày theo múi giờ local (YYYY-MM-DD)
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

export function getStorageKey(
  userId: number | string | undefined,
  courseId: number | string | undefined,
  type: PlayableType
): string {
  const uid = userId ?? 'anon';
  const cid = courseId ?? 'course';
  return `lms_play_${uid}_${cid}_${type}_${getTodayKey()}`;
}

/** Dọn toàn bộ dữ liệu ván chơi (kèm nhận xét AI) của những ngày trước. */
export function cleanupOldPlayables(): void {
  if (typeof window === 'undefined') return;
  try {
    const today = getTodayKey();
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith('lms_play_') && !k.endsWith(today)) {
        localStorage.removeItem(k);
      }
    });
  } catch {
    // private mode / storage bị chặn
  }
}

export function getDailyPlayable<T>(
  userId: number | string | undefined,
  courseId: number | string | undefined,
  type: PlayableType
): DailyPlayableRecord<T> | null {
  if (typeof window === 'undefined') return null;
  cleanupOldPlayables();
  const raw = localStorage.getItem(getStorageKey(userId, courseId, type));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DailyPlayableRecord<T>;
  } catch {
    return null;
  }
}

export function saveDailyPlayable<T>(
  userId: number | string | undefined,
  courseId: number | string | undefined,
  type: PlayableType,
  record: DailyPlayableRecord<T>
): void {
  if (typeof window === 'undefined') return;
  // Tự động dọn các key của những ngày cũ để tránh đầy localStorage
  cleanupOldPlayables();
  try {
    localStorage.setItem(getStorageKey(userId, courseId, type), JSON.stringify(record));
  } catch {
    // quota exceeded or private mode
  }
}

/** Lấy nhận xét AI đã lưu cùng ván chơi hôm nay (nếu có). */
export function getTodayPlayableFeedback(
  userId: number | string | undefined,
  courseId: number | string | undefined,
  type: PlayableType
): StoredPlayableAIFeedback | null {
  const record = getDailyPlayable<unknown>(userId, courseId, type);
  return record?.aiFeedback ?? null;
}

/** Ghi nhận xét AI vào đúng bản ghi ván chơi hôm nay, giữ nguyên dữ liệu ván đang có. */
export function saveTodayPlayableFeedback(
  userId: number | string | undefined,
  courseId: number | string | undefined,
  type: PlayableType,
  feedback: StoredPlayableAIFeedback
): void {
  if (typeof window === 'undefined') return;
  const existing = getDailyPlayable<unknown>(userId, courseId, type);
  saveDailyPlayable(userId, courseId, type, {
    ...(existing ?? { status: 'completed', data: null }),
    aiFeedback: feedback,
  });
}
