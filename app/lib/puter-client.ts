import { PUTER_DEFAULT_MODEL } from './puter-models';
import { getTodayKey } from './playable-limit';

const PUTER_PROMPT_DISMISSED_PREFIX = 'lms_puter_prompt_dismissed_';

export type PuterChatResponse = {
  message?: { content?: string };
  text?: string;
};

export type PuterStreamPart = {
  text?: string;
  message?: { content?: string };
};

export type PuterChatResult = PuterChatResponse | string | AsyncIterable<PuterStreamPart>;

declare global {
  interface Window {
    puter?: {
      ai?: {
        chat: (
          prompt: string,
          options?: { model?: string; stream?: boolean; temperature?: number; max_tokens?: number }
        ) => Promise<PuterChatResult>;
      };
      auth?: {
        isSignedIn: () => boolean;
        signIn: (options?: { attempt_temp_user_creation?: boolean; request_auth?: boolean }) => Promise<unknown>;
        signOut: () => Promise<void>;
        getUser: () => Promise<{ username?: string; email?: string } | null>;
      };
    };
  }
}

export interface PuterHealthCheckResult {
  ok: boolean;
  /** Whether the browser finished loading https://js.puter.com/v2/. */
  sdkLoaded: boolean;
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

function extractText(response: PuterChatResponse | string) {
  if (typeof response === 'string') return response;
  return response.message?.content || response.text || '';
}

function isAsyncIterable(value: unknown): value is AsyncIterable<PuterStreamPart> {
  return Boolean(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

function abortError() {
  const err = new Error('Đã dừng tạo câu trả lời.');
  err.name = 'AbortError';
  return err;
}

/**
 * The Puter <Script> is loaded with `strategy="afterInteractive"`, so the first
 * interaction can happen before `window.puter` is ready. Poll briefly instead of
 * failing the health check outright.
 */
export async function waitForPuterSdk(timeoutMs = 6000): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (window.puter?.ai?.chat) return true;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => window.setTimeout(resolve, 150));
    if (window.puter?.ai?.chat) return true;
  }
  return false;
}

/**
 * Checks synchronously whether the user is already signed in to Puter.
 * Safe to call at any time without triggering a sign-in popup.
 */
export function isPuterSignedIn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Boolean(window.puter?.auth?.isSignedIn?.());
  } catch {
    return false;
  }
}

/**
 * Waits for SDK to be ready and checks if the user is signed in to Puter.
 */
export async function checkIsPuterSignedIn(timeoutMs = 2000): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!window.puter?.auth?.isSignedIn) {
    await waitForPuterSdk(timeoutMs);
  }
  return isPuterSignedIn();
}

/**
 * Explicitly triggers the Puter sign-in popup.
 * Should be called directly from user interactions (e.g. click/select)
 * so browsers don't block the popup window.
 */
export async function signInPuter(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const ready = await waitForPuterSdk(3000);
  if (!ready || !window.puter?.auth?.signIn) {
    console.warn('Puter SDK chưa tải xong để mở đăng nhập.');
    return false;
  }
  try {
    await window.puter.auth.signIn();
    return isPuterSignedIn();
  } catch (err) {
    console.warn('Cửa sổ đăng nhập Puter bị đóng hoặc lỗi:', err);
    return false;
  }
}

function getPuterPromptDismissedKey(userId?: number | string): string {
  const uid = userId ?? 'anon';
  return `${PUTER_PROMPT_DISMISSED_PREFIX}${uid}_${getTodayKey()}`;
}

function cleanupOldPuterPrompts(): void {
  if (typeof window === 'undefined') return;
  try {
    const today = getTodayKey();
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith(PUTER_PROMPT_DISMISSED_PREFIX) && !k.endsWith(today)) {
        localStorage.removeItem(k);
      }
    });
  } catch {
    // private mode / storage blocked
  }
}

/**
 * Returns true if the user already dismissed the daily Puter sign-in suggestion today.
 */
export function hasDismissedPuterPromptToday(userId?: number | string): boolean {
  if (typeof window === 'undefined') return false;
  cleanupOldPuterPrompts();
  try {
    return localStorage.getItem(getPuterPromptDismissedKey(userId)) === '1';
  } catch {
    return false;
  }
}

/**
 * Marks the daily Puter sign-in suggestion as dismissed for today.
 */
export function dismissPuterPromptToday(userId?: number | string): void {
  if (typeof window === 'undefined') return;
  cleanupOldPuterPrompts();
  try {
    localStorage.setItem(getPuterPromptDismissedKey(userId), '1');
  } catch {
    // quota exceeded or private mode
  }
}

/**
 * Client-side health check for the Puter.js integration.
 * Sends a tiny prompt through `puter.ai.chat` and reports latency plus any error.
 * Does NOT call puter.ai.chat if user is not signed in, preventing unwanted popups.
 */
export async function checkPuterHealth(
  model = PUTER_DEFAULT_MODEL,
  timeoutMs = 25000
): Promise<PuterHealthCheckResult> {
  const startedAt = Date.now();
  const sdkLoaded = await waitForPuterSdk();

  if (!sdkLoaded || typeof window === 'undefined' || !window.puter?.ai?.chat) {
    return {
      ok: false,
      sdkLoaded: false,
      model,
      latencyMs: Date.now() - startedAt,
      error: 'Không tải được Puter SDK từ js.puter.com.',
    };
  }

  // Prevent auto sign-in popup if user is not signed in to Puter
  if (!isPuterSignedIn()) {
    return {
      ok: false,
      sdkLoaded: true,
      model,
      latencyMs: 0,
      error: 'Chưa đăng nhập Puter (cần đăng nhập để sử dụng)',
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Puter không phản hồi sau ${Math.round(timeoutMs / 1000)} giây.`)),
        timeoutMs
      );
    });

    const response = await Promise.race([
      window.puter.ai.chat('Health check: trả lời ngắn gọn "Puter OK".', { model }),
      timeout,
    ]);

    const reply = extractText(response as PuterChatResponse | string).trim();
    if (!reply) {
      return {
        ok: false,
        sdkLoaded: true,
        model,
        latencyMs: Date.now() - startedAt,
        error: 'Puter trả về phản hồi rỗng.',
      };
    }

    return {
      ok: true,
      sdkLoaded: true,
      model,
      latencyMs: Date.now() - startedAt,
      reply: reply.slice(0, 160),
    };
  } catch (err) {
    return {
      ok: false,
      sdkLoaded: true,
      model,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Streams a tutor answer from Puter.js directly in the browser.
 * Falls back to a non-streaming call when the selected model does not support streaming.
 */
export async function askPuterStream(
  system: string,
  userPrompt: string,
  opts: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    onDelta: (delta: string) => void;
  }
): Promise<string> {
  if (typeof window === 'undefined' || !window.puter?.ai?.chat) {
    throw new Error('Puter SDK chưa sẵn sàng trên trình duyệt.');
  }
  if (!(await waitForPuterSdk())) {
    throw new Error('Không tải được Puter SDK từ js.puter.com.');
  }
  if (!isPuterSignedIn()) {
    throw new Error('Chưa đăng nhập tài khoản Puter để sử dụng model này.');
  }

  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw abortError();
  };
  throwIfAborted();

  const prompt = `${system}\n\n${userPrompt}`;
  const optionsBase = {
    model: opts.model,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
  };
  let streamed = '';

  try {
    const streamResult = await window.puter.ai.chat(prompt, { ...optionsBase, stream: true });

    if (isAsyncIterable(streamResult)) {
      for await (const part of streamResult) {
        throwIfAborted();
        const delta = typeof part === 'string'
          ? part
          : part?.text || part?.message?.content || '';
        if (delta) {
          streamed += delta;
          opts.onDelta(delta);
        }
      }
    } else if (streamResult && typeof streamResult !== 'string') {
      const full = extractText(streamResult as PuterChatResponse).trim();
      if (full) {
        streamed = full;
        opts.onDelta(full);
      }
    } else if (typeof streamResult === 'string' && streamResult.trim()) {
      streamed = streamResult;
      opts.onDelta(streamResult);
    }
  } catch (err) {
    if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw abortError();
    // Streaming can be rejected by models/proxies that only support the blocking API.
    if (streamed.trim()) throw err;
  }

  throwIfAborted();

  if (streamed.trim()) return streamed;

  // Blocking fallback (also covers empty streams).
  const response = await window.puter.ai.chat(prompt, optionsBase);
  const full = extractText(response as PuterChatResponse | string).trim();
  if (!full) throw new Error('Puter không trả về nội dung trả lời.');
  opts.onDelta(full);
  return full;
}

export async function askPuterJSON<T>(prompt: string, model = PUTER_DEFAULT_MODEL): Promise<T> {
  if (typeof window === 'undefined' || !window.puter?.ai?.chat) {
    throw new Error('Puter SDK chưa sẵn sàng trên trình duyệt.');
  }
  if (!isPuterSignedIn()) {
    throw new Error('Chưa đăng nhập tài khoản Puter.');
  }

  const response = await window.puter.ai.chat(
    `${prompt}\n\nYÊU CẦU BẮT BUỘC: Chỉ trả về duy nhất một chuỗi JSON hợp lệ, không bọc trong markdown \`\`\`json, không giải thích thêm.`,
    { model }
  );
  const rawText = extractText(response as PuterChatResponse | string).replace(/```json|```/g, '').trim();
  if (!rawText) throw new Error('Puter không trả về dữ liệu JSON.');

  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error('Puter trả về JSON không hợp lệ.');
  }
}
