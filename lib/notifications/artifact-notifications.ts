import { adminMessaging } from '@/lib/firebase-admin';
import { supabaseAdmin } from '@/lib/supabase';
import { getDb } from '@/db';
import { fcmTokens } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Event-driven notification for AI-generated learning artifacts.
 *
 * The heavy AI work already happens inside the route handler. Once the artifact
 * has been persisted, the route schedules `sendArtifactReadyNotification` with
 * Next.js `after()` so the push is delivered after the HTTP response without
 * being frozen/killed by a serverless runtime (Vercel, Netlify, ...).
 */

export interface ArtifactReadyNotificationInput {
  userId: number;
  artifactType: string;
  /** Human readable artifact name (lesson topic, quiz name, ...). */
  artifactName?: string;
  artifactId?: string | null;
  /** Moodle quiz attempt id, used to auto-open the saved diagnosis. */
  attemptId?: number | string | null;
  courseId?: number | string | null;
  courseCode?: string;
  courseName?: string;
  /** Override the deep-link the notification opens. */
  url?: string;
  /** Override the notification tag (used by the service worker for dedupe). */
  tag?: string;
}

export interface ArtifactNotificationResult {
  sent: number;
  failed?: number;
  skipped?: 'missing_user' | 'no_tokens' | 'error';
  error?: string;
}

const ARTIFACT_COPY: Record<string, { title: string; body: (name: string) => string }> = {
  quiz_analysis: {
    title: 'Chẩn đoán bài thi đã xong',
    body: name => `Bản phân tích "${name}" đã ra lò. Nhấn để xem các lỗ hổng kiến thức và lộ trình khắc phục.`,
  },
  summary: {
    title: 'Tóm tắt bài học đã xong',
    body: name => `Bản tóm tắt "${name}" đã sẵn sàng. Nhấn để mở và ôn tập ngay.`,
  },
  mindmap: {
    title: 'Mindmap đã xong',
    body: name => `Sơ đồ tư duy "${name}" đã sẵn sàng. Nhấn để xem và tương tác.`,
  },
  flashcard: {
    title: 'Bộ flashcards đã xong',
    body: name => `Bộ thẻ ghi nhớ "${name}" đã sẵn sàng. Nhấn để bắt đầu ôn tập.`,
  },
  flashcards: {
    title: 'Bộ flashcards đã xong',
    body: name => `Bộ thẻ ghi nhớ "${name}" đã sẵn sàng. Nhấn để bắt đầu ôn tập.`,
  },
  slide: {
    title: 'Slide bài giảng đã xong',
    body: name => `Bộ slide "${name}" đã sẵn sàng. Nhấn để mở bài trình chiếu.`,
  },
  slides: {
    title: 'Slide bài giảng đã xong',
    body: name => `Bộ slide "${name}" đã sẵn sàng. Nhấn để mở bài trình chiếu.`,
  },
};

function resolveCopy(artifactType: string, artifactName?: string) {
  const copy = ARTIFACT_COPY[artifactType];
  const name = (artifactName || '').trim() || 'học liệu của bạn';
  return copy
    ? { title: copy.title, body: copy.body(name) }
    : { title: 'Học liệu AI đã sẵn sàng', body: `"${name}" đã được tạo xong. Nhấn để mở và xem ngay.` };
}

function buildCourseUrl(input: ArtifactReadyNotificationInput): string {
  if (input.url) return input.url;

  const params = new URLSearchParams();
  if (input.courseCode) params.set('code', input.courseCode);
  if (input.courseName) params.set('name', input.courseName);
  if (input.courseId) params.set('id', String(input.courseId));

  const toolKey: Record<string, string> = {
    summary: 'Tóm tắt',
    mindmap: 'Mindmap',
    flashcard: 'Flashcard',
    flashcards: 'Flashcard',
    slide: 'Slide',
    slides: 'Slide',
  };
  const tool = toolKey[input.artifactType];
  if (tool) params.set('tool', tool);
  if (input.artifactType === 'quiz_analysis' && input.attemptId) {
    params.set('analysisAttempt', String(input.attemptId));
  }

  const query = params.toString();
  return query ? `/course?${query}` : '/home';
}

async function getFcmTokensForUser(userId: number): Promise<string[]> {
  const tokens = new Set<string>();

  // 1. Supabase (same source the scheduled notification service uses)
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('fcm_tokens')
        .select('token')
        .eq('user_id', userId);
      if (!error) {
        for (const row of data || []) {
          if (row?.token) tokens.add(String(row.token));
        }
      }
    } catch (err) {
      console.warn('[ArtifactNotify] Supabase token lookup failed:', err);
    }
  }

  // 2. Drizzle/Postgres fallback (e.g. local deployments without Supabase)
  if (tokens.size === 0) {
    try {
      const db = getDb();
      if (db) {
        const rows = await db
          .select({ token: fcmTokens.token })
          .from(fcmTokens)
          .where(eq(fcmTokens.userId, userId));
        for (const row of rows) {
          if (row?.token) tokens.add(String(row.token));
        }
      }
    } catch (err) {
      console.warn('[ArtifactNotify] Postgres token lookup failed:', err);
    }
  }

  return Array.from(tokens);
}

/**
 * Send a real-time push notification telling the student that an AI artifact
 * has finished generating. Never throws: callers may fire-and-forget it from
 * `after()` without risking an unhandled rejection after the response.
 */
export async function sendArtifactReadyNotification(
  input: ArtifactReadyNotificationInput
): Promise<ArtifactNotificationResult> {
  const userId = Number(input.userId);
  if (!userId || userId <= 0) {
    return { sent: 0, skipped: 'missing_user' };
  }

  try {
    const tokens = await getFcmTokensForUser(userId);
    if (tokens.length === 0) {
      return { sent: 0, skipped: 'no_tokens' };
    }

    const { title, body } = resolveCopy(input.artifactType, input.artifactName);
    const url = buildCourseUrl(input);
    const tag =
      input.tag ||
      `artifact-${input.artifactType}-${input.artifactId || `${userId}-${Date.now()}`}`;

    const result = await adminMessaging.sendEachForMulticast({
      notification: { title, body },
      data: {
        type: 'artifact_ready',
        artifactType: input.artifactType,
        artifactId: input.artifactId ? String(input.artifactId) : '',
        moodleCourseId: input.courseId ? String(input.courseId) : '',
        tag,
        url,
        title,
        body,
      },
      tokens,
    });

    // Prune tokens Firebase reports as invalid so future artifact pushes stay clean.
    const invalidTokens: string[] = [];
    result.responses?.forEach((response, index) => {
      const errorCode = (response.error as { code?: string })?.code;
      if (
        !response.success &&
        (errorCode === 'messaging/registration-token-not-registered' ||
          errorCode === 'messaging/invalid-registration-token')
      ) {
        invalidTokens.push(tokens[index]);
      }
    });

    if (invalidTokens.length > 0 && supabaseAdmin) {
      try {
        await supabaseAdmin.from('fcm_tokens').delete().in('token', invalidTokens);
      } catch (err) {
        console.warn('[ArtifactNotify] Failed to prune invalid FCM tokens:', err);
      }
    }

    return { sent: result.successCount, failed: result.failureCount };
  } catch (error) {
    console.warn('[ArtifactNotify] Failed to send artifact-ready push:', error);
    return {
      sent: 0,
      skipped: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
