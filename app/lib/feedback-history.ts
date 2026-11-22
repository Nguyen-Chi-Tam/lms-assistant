'use client';

import type { ActivityFeedbackItem } from '@/app/types';

const FEEDBACK_PREFIX = 'lms_fb_';
const MAX_ITEMS = 10;

/** Ngày theo múi giờ local (YYYY-MM-DD) — khớp với cơ chế dọn dẹp của playable-limit. */
function getTodayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

function getStorageKey(
  userId: number | string | undefined,
  courseId: number | string | undefined
): string {
  return `${FEEDBACK_PREFIX}${userId ?? 'anon'}_${courseId ?? 'course'}_${getTodayKey()}`;
}

/** Xóa lịch sử phản hồi của những ngày trước (chỉ giữ lại dữ liệu trong ngày). */
function cleanupOldFeedback(): void {
  if (typeof window === 'undefined') return;
  try {
    const today = getTodayKey();
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith(FEEDBACK_PREFIX) && !key.endsWith(today)) {
        localStorage.removeItem(key);
      }
    });
  } catch {
    // private mode / storage bị chặn
  }
}

/** Lấy lịch sử nhận xét AI của người dùng trong khóa học, giới hạn trong ngày hiện tại. */
export function getTodayFeedbackHistory(
  userId: number | string | undefined,
  courseId: number | string | undefined
): ActivityFeedbackItem[] {
  if (typeof window === 'undefined') return [];
  cleanupOldFeedback();
  try {
    const raw = localStorage.getItem(getStorageKey(userId, courseId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ActivityFeedbackItem[]) : [];
  } catch {
    return [];
  }
}

export type NewFeedbackInput = {
  id?: string;
  activity_type: string;
  score_label?: string;
  ai_feedback: string;
  improvement_plan?: string;
  created_at?: string;
};

/**
 * Nối một nhận xét vào lịch sử localStorage (tối đa 10 mục gần nhất).
 * Dữ liệu tự động hết hạn sang ngày mới nhờ cleanupOldFeedback().
 */
export function appendFeedbackHistory(
  userId: number | string | undefined,
  courseId: number | string | undefined,
  input: NewFeedbackInput
): ActivityFeedbackItem[] {
  if (typeof window === 'undefined') return [];

  const item: ActivityFeedbackItem = {
    id: input.id || `fb_${Date.now()}`,
    activity_type: input.activity_type,
    score_label: input.score_label || '',
    ai_feedback: String(input.ai_feedback || '').trim(),
    improvement_plan: input.improvement_plan || '',
    created_at: input.created_at || new Date().toISOString(),
  };

  const history = [...getTodayFeedbackHistory(userId, courseId), item].slice(-MAX_ITEMS);
  try {
    localStorage.setItem(getStorageKey(userId, courseId), JSON.stringify(history));
  } catch {
    // quota exceeded or private mode — vẫn trả về history trong bộ nhớ
  }
  return history;
}
