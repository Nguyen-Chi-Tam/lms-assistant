'use client';

import { askPuterJSON } from '@/app/lib/puter-client';
import { appendFeedbackHistory } from '@/app/lib/feedback-history';

export interface PlayableFeedback {
  id?: string;
  activity_type: string;
  score_label: string;
  ai_feedback: string;
  improvement_plan: string;
  created_at: string;
}

/** Safe wrapper: returns null when Puter isn't available so a game can fall back to local data. */
export async function askPuterJSONSafe<T>(prompt: string, model = 'gpt-4o-mini'): Promise<T | null> {
  try {
    return await askPuterJSON<T>(prompt, model);
  } catch {
    return null;
  }
}

/** Lưu nhận xét AI vào localStorage (chỉ tồn tại trong ngày, thay cho bảng Supabase đã gỡ bỏ). */
export async function submitPlayableFeedback(payload: {
  userId: number;
  courseId: number;
  courseName: string;
  feedback: PlayableFeedback;
}) {
  appendFeedbackHistory(payload.userId, payload.courseId, payload.feedback);
}
