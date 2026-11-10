import OpenAI from 'openai';
import { runtimeEnv } from '@/db/runtime';
import type {
  GenerateTextOptions,
  GenerateTextStreamOptions,
  GenerateTextResult,
} from './registry';
import { isQuotaExhaustedError, blockProviderUntilTomorrow, setLastProviderError } from './registry';
import { stripFluff } from '@/lib/anti-fluff';

const systemClientMap = new Map<string, OpenAI>();
const systemKeyBlockedUntil = new Map<string, number>();
let systemRoundRobinPointer = 0;

const userKeyBlockedUntil = new Map<string, number>();
const userClientMap = new Map<string, OpenAI>();

function getUserOpenRouterClient(key: string): OpenAI {
  let client = userClientMap.get(key);
  if (!client) {
    client = new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://lms-assistant.edu.vn',
        'X-Title': 'LMS Assistant',
      },
    });
    userClientMap.set(key, client);
  }
  return client;
}

export const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-27b';
export const OPENROUTER_BACKUP_MODELS = [
  'nvidia/nemotron-3.5-lightning:free',
  'liquid/lfm-2.5-2.6b:free',
  'google/gemma-4-31b-it:free',
];

/**
 * Maps legacy OpenRouter model slugs that were retired from the free tier
 * to their current replacements. (e.g. 'qwen/qwen3.8-27b:free' was removed by
 * OpenRouter and the model moved to the paid tier under 'qwen/qwen3.8-27b'.)
 */
const OPENROUTER_MODEL_SLUG_MAP: Record<string, string> = {
  'qwen/qwen3.8-27b:free': 'qwen/qwen3.8-27b',
};

export function normalizeOpenRouterModel(modelId: string): string {
  const cleanId = (modelId || '').trim();
  const mapped = OPENROUTER_MODEL_SLUG_MAP[cleanId];
  if (mapped) {
    console.warn(`[OpenRouter] Legacy model slug "${cleanId}" is no longer available. Normalized to "${mapped}".`);
    return mapped;
  }
  return cleanId;
}

export function isOpenRouterModelUnavailableError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const errStr = `${String((err as any)?.message || err || '')} ${String((err as any)?.error?.message || '')}`.toLowerCase();
  return (
    status === 404 ||
    errStr.includes('unavailable for free') ||
    errStr.includes('model not found') ||
    errStr.includes('no such model') ||
    errStr.includes('does not exist') ||
    errStr.includes('not available')
  );
}

export function isOpenRouterRateLimitError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const errStr = `${String((err as any)?.message || err || '')} ${String((err as any)?.error?.message || '')}`.toLowerCase();
  return (
    status === 429 ||
    errStr.includes('rate limit') ||
    errStr.includes('rate_limit') ||
    errStr.includes('429') ||
    errStr.includes('too many requests')
  );
}

export function getOpenRouterApiKeys(): string[] {
  const env = runtimeEnv();
  const configured = [
    env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEYS,
    env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY,
  ];
  const keys: string[] = [];

  for (const value of configured) {
    for (const key of (value || '').split(/[\r\n,;]+/).map(item => item.trim())) {
      if (
        key &&
        !key.startsWith('sk-or-your') &&
        key !== 'sk-or-...' &&
        key !== 'your-openrouter-key' &&
        !keys.includes(key)
      ) {
        keys.push(key);
      }
    }
  }
  return keys;
}

// Kept for compatibility with callers outside this module.
export function getOpenRouterApiKey(): string {
  return getOpenRouterApiKeys()[0] || '';
}

export function isOpenRouterAvailable(): boolean {
  return getOpenRouterApiKeys().length > 0;
}

export function getOpenRouterClient(): OpenAI | null {
  const keys = getOpenRouterApiKeys();
  const activeKeys = keys.filter(key => Date.now() >= (systemKeyBlockedUntil.get(key) || 0));
  const key = activeKeys[systemRoundRobinPointer++ % activeKeys.length];
  if (!key) return null;

  let client = systemClientMap.get(key);
  if (!client) {
    client = new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://lms-assistant.edu.vn',
        'X-Title': 'LMS Assistant',
      },
    });
    systemClientMap.set(key, client);
  }
  return client;
}

function prepareOpenRouterMessages(
  system: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  userPrompt: string,
  jsonMode?: boolean
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  let effectiveSystem = system;
  if (jsonMode) {
    effectiveSystem +=
      '\n\nQUAN TRỌNG: Bạn BẮT BUỘC chỉ trả về định dạng JSON hợp lệ duy nhất. Tuyệt đối không chèn thêm bất kỳ văn bản, lời chào, lời kết luận hay cú pháp markdown bao bọc nào.';
  }

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: effectiveSystem },
  ];

  if (history && history.length > 0) {
    for (const msg of history.slice(-6)) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: userPrompt });
  return messages;
}

async function executeOpenRouterRequest(
  client: OpenAI,
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const messages = prepareOpenRouterMessages(
    opts.system,
    opts.history,
    opts.userPrompt,
    opts.jsonMode
  );

  let targetModelId = normalizeOpenRouterModel(modelId);
  if (
    targetModelId === 'meta-llama/llama-3.1-8b-instruct:free' ||
    targetModelId === 'meta-llama/llama-3.3-70b-instruct:free' ||
    targetModelId === 'google/gemini-2.0-flash-exp:free'
  ) {
    targetModelId = OPENROUTER_MODEL;
  }

  const stopSequences = (opts.stop || opts.stopSequences)?.slice(0, 4);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createParams: any = {
    model: targetModelId,
    messages,
    temperature: opts.temperature ?? 0.2,
    ...(opts.topP !== undefined ? { top_p: opts.topP === 0 ? 0.001 : opts.topP } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(stopSequences && stopSequences.length > 0 ? { stop: stopSequences } : {}),
  };

  if (opts.jsonMode) {
    createParams.response_format = { type: 'json_object' };
  }

  let completion;
  try {
    completion = await client.chat.completions.create(createParams);
  } catch (createErr: any) {
    if (
      opts.jsonMode &&
      (createErr?.status === 400 || String(createErr).includes('response_format'))
    ) {
      delete createParams.response_format;
      completion = await client.chat.completions.create(createParams);
    } else {
      throw createErr;
    }
  }

  const choice = completion.choices[0];
  const rawContent = choice?.message?.content?.trim();
  const rawReasoning = (choice?.message as any)?.reasoning?.trim();
  const text = (rawContent || rawReasoning || '').trim();
  if (!text) return null;

  return { text: stripFluff(text), finishReason: choice?.finish_reason || undefined };
}

async function executeWithSystemOpenRouterPool<T>(operation: (client: OpenAI) => Promise<T>): Promise<T> {
  const keys = getOpenRouterApiKeys();
  if (keys.length === 0) {
    throw new Error('No OpenRouter API keys configured. Set OPENROUTER_API_KEY or OPENROUTER_API_KEYS.');
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const client = getOpenRouterClient();
    if (!client) break;
    try {
      return await operation(client);
    } catch (error) {
      lastError = error;
      const message = String(error).toLowerCase();
      const exhausted = message.includes('429') || message.includes('quota') || message.includes('rate limit');
      const unauthorized = message.includes('401') || message.includes('unauthorized') || message.includes('invalid_api_key');
      if (!exhausted && !unauthorized) throw error;

      const key = keys.find(candidate => systemClientMap.get(candidate) === client);
      if (key) systemKeyBlockedUntil.set(key, Date.now() + 30_000);
    }
  }
  throw lastError || new Error('All OpenRouter API keys are temporarily unavailable.');
}

/**
 * Call OpenRouter API (non-streaming)
 * Prioritizes user's custom API key(s) before falling back to system key.
 */
export async function callOpenRouter(
  modelId: string,
  opts: GenerateTextOptions,
  customUserKeys?: string[]
): Promise<GenerateTextResult | null> {
  const userKeys = opts.keyMode === 'system' ? [] : (customUserKeys || opts.userApiKeys?.openrouter);

  // 1. PRIORITIZE USER KEYS (BYOK) FIRST
  if (userKeys && userKeys.length > 0) {
    for (let uIdx = 0; uIdx < userKeys.length; uIdx++) {
      opts.signal?.throwIfAborted();
      const uKey = userKeys[uIdx].trim();
      if (!uKey) continue;

      const blockedUntil = userKeyBlockedUntil.get(uKey) || 0;
      if (Date.now() < blockedUntil) continue;

      try {
        const uClient = getUserOpenRouterClient(uKey);
        const res = await executeOpenRouterRequest(uClient, modelId, opts);
        if (res && res.text) {
          opts.onKeySource?.('byok');
          return res;
        }
      } catch (uErr: any) {
        if (opts.signal?.aborted) throw uErr;
        if (isOpenRouterModelUnavailableError(uErr)) {
          throw new Error(
            `OpenRouter model "${modelId}" is currently unavailable (HTTP ${uErr?.status || 'unknown'}). The free-tier version may have been retired. Please switch to another OpenRouter model or add billing credits.`
          );
        }
        const errStr = String(uErr).toLowerCase();
        const isQuota = isOpenRouterRateLimitError(uErr);
        const isAuth = errStr.includes('401') || errStr.includes('unauthorized') || errStr.includes('invalid_api_key');
        if (isQuota || isAuth) {
          userKeyBlockedUntil.set(uKey, Date.now() + 30000);
          console.warn(`[BYOK OpenRouter] User key #${uIdx + 1} hit ${isAuth ? 'auth error' : 'quota limit'}. Trying the next BYOK key...`);
        } else {
          console.warn(`[BYOK OpenRouter] User key #${uIdx + 1} failed (${uErr}). Trying the next BYOK key...`);
        }
      }
    }
  }

  if (opts.keyMode === 'byok') {
    const usableUserKeys = (userKeys || []).filter(k => typeof k === 'string' && k.trim().length > 0);
    if (usableUserKeys.length === 0) {
      throw new Error('No BYOK OpenRouter keys available for this user. Please add an OpenRouter API key (BYOK) before using a BYOK model.');
    }
    console.warn(`[OpenRouter Pool] All ${usableUserKeys.length} BYOK key(s) failed; switching to system pool...`);
    throw new Error('All BYOK OpenRouter keys failed or are temporarily unavailable.');
  }

  // 2. FALLBACK TO SYSTEM CLIENT
  try {
    opts.signal?.throwIfAborted();
    const result = await executeWithSystemOpenRouterPool(client => executeOpenRouterRequest(client, modelId, opts));
    if (result?.text) opts.onKeySource?.('system');
    return result;
  } catch (err: any) {
    const errMsg = err?.message || err?.error?.message || String(err);
    setLastProviderError('openrouter', errMsg);
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('openrouter', String(err));
    }
    console.warn(`callOpenRouter (${modelId}) failed:`, err);
    return null;
  }
}

async function executeOpenRouterStreamRequest(
  client: OpenAI,
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const messages = prepareOpenRouterMessages(
    opts.system,
    opts.history,
    opts.userPrompt,
    opts.jsonMode
  );

  let targetModelId = normalizeOpenRouterModel(modelId);
  if (
    targetModelId === 'meta-llama/llama-3.1-8b-instruct:free' ||
    targetModelId === 'meta-llama/llama-3.3-70b-instruct:free' ||
    targetModelId === 'google/gemini-2.0-flash-exp:free'
  ) {
    targetModelId = OPENROUTER_MODEL;
  }

  const stopSequences = (opts.stop || opts.stopSequences)?.slice(0, 4);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createParams: any = {
    model: targetModelId,
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: true,
    ...(opts.topP !== undefined ? { top_p: opts.topP === 0 ? 0.001 : opts.topP } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(stopSequences && stopSequences.length > 0 ? { stop: stopSequences } : {}),
  };

  if (opts.jsonMode) {
    createParams.response_format = { type: 'json_object' };
  }

  let stream;
  try {
    stream = await client.chat.completions.create(createParams);
  } catch (createErr: any) {
    if (
      opts.jsonMode &&
      (createErr?.status === 400 || String(createErr).includes('response_format'))
    ) {
      delete createParams.response_format;
      stream = await client.chat.completions.create(createParams);
    } else {
      throw createErr;
    }
  }

  let accumulatedText = '';
  let finishReason: string | undefined = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const chunk of stream as any) {
    opts.signal?.throwIfAborted();
    const deltaContent = chunk.choices?.[0]?.delta?.content || '';
    if (deltaContent) {
      accumulatedText += deltaContent;
      opts.onDelta(deltaContent);
    }
    if (chunk.choices?.[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }
  }

  if (!accumulatedText.trim()) {
    const fallback = await callOpenRouter(modelId, opts);
    if (fallback?.text) {
      opts.onDelta(fallback.text);
      return fallback;
    }
  }

  return { text: accumulatedText.trim(), finishReason };
}

/**
 * Call OpenRouter API with streaming
 * Prioritizes user's custom API key(s) before falling back to system key.
 */
export async function callOpenRouterStream(
  modelId: string,
  opts: GenerateTextStreamOptions,
  customUserKeys?: string[]
): Promise<GenerateTextResult | null> {
  const userKeys = opts.keyMode === 'system' ? [] : (customUserKeys || opts.userApiKeys?.openrouter);

  // 1. PRIORITIZE USER KEYS (BYOK) FIRST
  if (userKeys && userKeys.length > 0) {
    for (let uIdx = 0; uIdx < userKeys.length; uIdx++) {
      opts.signal?.throwIfAborted();
      const uKey = userKeys[uIdx].trim();
      if (!uKey) continue;

      const blockedUntil = userKeyBlockedUntil.get(uKey) || 0;
      if (Date.now() < blockedUntil) continue;

      try {
        const uClient = getUserOpenRouterClient(uKey);
        const res = await executeOpenRouterStreamRequest(uClient, modelId, opts);
        if (res && res.text) {
          opts.onKeySource?.('byok');
          return res;
        }
      } catch (uErr: any) {
        if (opts.signal?.aborted) throw uErr;
        if (isOpenRouterModelUnavailableError(uErr)) {
          throw new Error(
            `OpenRouter model "${modelId}" is currently unavailable (HTTP ${uErr?.status || 'unknown'}). The free-tier version may have been retired. Please switch to another OpenRouter model or add billing credits.`
          );
        }
        const errStr = String(uErr).toLowerCase();
        const isQuota = isOpenRouterRateLimitError(uErr);
        const isAuth = errStr.includes('401') || errStr.includes('unauthorized') || errStr.includes('invalid_api_key');
        if (isQuota || isAuth) {
          userKeyBlockedUntil.set(uKey, Date.now() + 30000);
          console.warn(`[BYOK OpenRouter Stream] User key #${uIdx + 1} hit ${isAuth ? 'auth error' : 'quota limit'}. Trying the next BYOK key...`);
        } else {
          console.warn(`[BYOK OpenRouter Stream] User key #${uIdx + 1} failed (${uErr}). Trying the next BYOK key...`);
        }
      }
    }
  }

  if (opts.keyMode === 'byok') {
    const usableUserKeys = (userKeys || []).filter(k => typeof k === 'string' && k.trim().length > 0);
    if (usableUserKeys.length === 0) {
      throw new Error('No BYOK OpenRouter keys available for this user. Please add an OpenRouter API key (BYOK) before using a BYOK model.');
    }
    console.warn(`[OpenRouter Pool] All ${usableUserKeys.length} BYOK key(s) failed; switching to system pool...`);
    throw new Error('All BYOK OpenRouter keys failed or are temporarily unavailable.');
  }

  // 2. FALLBACK TO SYSTEM CLIENT
  try {
    opts.signal?.throwIfAborted();
    const result = await executeWithSystemOpenRouterPool(client => executeOpenRouterStreamRequest(client, modelId, opts));
    if (result?.text) opts.onKeySource?.('system');
    return result;
  } catch (err: any) {
    const errMsg = err?.message || err?.error?.message || String(err);
    setLastProviderError('openrouter', errMsg);
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('openrouter', String(err));
    }
    console.warn(`callOpenRouterStream (${modelId}) failed:`, err);

    // Fallback to non-streaming if stream crashed
    try {
      const fallback = await callOpenRouter(modelId, opts);
      if (fallback?.text) {
        opts.onDelta(fallback.text);
        return fallback;
      }
    } catch (fallbackErr) {
      console.warn(`callOpenRouter non-stream fallback (${modelId}) failed:`, fallbackErr);
    }
    return null;
  }
}
