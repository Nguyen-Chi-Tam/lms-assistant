import OpenAI from 'openai';
import { runtimeEnv } from '@/db/runtime';
import type {
  GenerateTextOptions,
  GenerateTextStreamOptions,
  GenerateTextResult,
} from './registry';
import { blockProviderUntilTomorrow, isQuotaExhaustedError, setLastProviderError } from './registry';
import { stripFluff } from '@/lib/ai/anti-fluff';

let client: OpenAI | null = null;
let cachedKey = '';
let cachedBaseUrl = '';

export const POLLINATIONS_DEFAULT_BASE_URL = 'https://gen.pollinations.ai/v1';
export const POLLINATIONS_DEFAULT_MODEL = process.env.POLLINATIONS_MODEL || 'stealth/glyph-cluster';
export const POLLINATIONS_BACKUP_MODELS: string[] = [];
export const POLLINATIONS_TIMEOUT_MS = 30_000;

function getConfig(): { apiKey: string; baseUrl: string } {
  const env = runtimeEnv() as Record<string, string | undefined>;
  const rawKey = env.POLLINATIONS_API_KEYS || process.env.POLLINATIONS_API_KEYS || env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_API_KEY || '';
  // Accept first non-empty key from comma/newline-separated pool
  const apiKey = rawKey
    .split(/[\r\n,;]+/)
    .map(s => s.trim())
    .find(k => k && k !== 'your-pollinations-key' && k !== 'pk_...') || '';
  const baseUrl = (env.POLLINATIONS_BASE_URL || process.env.POLLINATIONS_BASE_URL || POLLINATIONS_DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

export function isPollinationsAvailable(): boolean {
  return Boolean(getConfig().apiKey);
}

function getClient(): OpenAI | null {
  const config = getConfig();
  if (!config.apiKey) return null;
  if (!client || cachedKey !== config.apiKey || cachedBaseUrl !== config.baseUrl) {
    client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: POLLINATIONS_TIMEOUT_MS,
      maxRetries: 0,
      defaultHeaders: {
        'HTTP-Referer': 'https://lms-assistant.edu.vn',
        'X-Title': 'LMS Assistant',
      },
    });
    cachedKey = config.apiKey;
    cachedBaseUrl = config.baseUrl;
  }
  return client;
}

function messages(opts: GenerateTextOptions): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) {
    let system = opts.system;
    if (opts.jsonMode) {
      system += '\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no extra text.';
    }
    result.push({ role: 'system', content: system });
  } else if (opts.jsonMode) {
    result.push({ role: 'system', content: 'IMPORTANT: You MUST respond with valid JSON only. No markdown, no extra text.' });
  }
  if (opts.history && opts.history.length > 0) {
    for (const msg of opts.history.slice(-10)) {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  result.push({ role: 'user', content: opts.userPrompt });
  return result;
}

function params(modelId: string, opts: GenerateTextOptions): Record<string, unknown> {
  const stopSequences = (opts.stop || opts.stopSequences)?.slice(0, 4);
  return {
    model: modelId || POLLINATIONS_DEFAULT_MODEL,
    messages: messages(opts),
    temperature: opts.temperature ?? 0.2,
    ...(opts.topP !== undefined ? { top_p: opts.topP === 0 ? 0.001 : opts.topP } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(stopSequences && stopSequences.length > 0 ? { stop: stopSequences } : {}),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

export async function callPollinations(
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const pollinationsClient = getClient();
  if (!pollinationsClient) return null;
  try {
    opts.signal?.throwIfAborted();
    const createParams = params(modelId, opts) as any;
    let completion;
    try {
      completion = await pollinationsClient.chat.completions.create(createParams, {
        signal: opts.signal,
      });
    } catch (createErr: any) {
      if (opts.jsonMode && (createErr?.status === 400 || String(createErr).includes('response_format'))) {
        delete createParams.response_format;
        completion = await pollinationsClient.chat.completions.create(createParams, {
          signal: opts.signal,
        });
      } else {
        throw createErr;
      }
    }
    const choice = completion.choices?.[0];
    const rawContent = choice?.message?.content?.trim();
    const rawReasoning = (choice?.message as any)?.reasoning?.trim();
    const text = (rawContent || rawReasoning || '').trim();
    if (!text) return null;
    return { text: stripFluff(text), finishReason: choice?.finish_reason || undefined };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    setLastProviderError('pollinations', String(err));
    if (isQuotaExhaustedError(err)) blockProviderUntilTomorrow('pollinations', String(err));
    console.warn(`[Pollinations] Request failed (${modelId}); moving to the next system provider:`, err);
    return null;
  }
}

export async function callPollinationsStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const pollinationsClient = getClient();
  if (!pollinationsClient) return null;
  try {
    opts.signal?.throwIfAborted();
    const createParams = { ...params(modelId, opts), stream: true } as any;
    let stream;
    try {
      stream = await pollinationsClient.chat.completions.create(createParams, {
        signal: opts.signal,
      });
    } catch (createErr: any) {
      if (opts.jsonMode && (createErr?.status === 400 || String(createErr).includes('response_format'))) {
        delete createParams.response_format;
        stream = await pollinationsClient.chat.completions.create(createParams, {
          signal: opts.signal,
        });
      } else {
        throw createErr;
      }
    }

    let accumulatedText = '';
    let finishReason: string | undefined;
    for await (const chunk of stream as any) {
      opts.signal?.throwIfAborted();
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta) {
        accumulatedText += delta;
        opts.onDelta(delta);
      }
      if (chunk.choices?.[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    const trimmed = accumulatedText.trim();
    if (!trimmed) {
      return null;
    }
    return { text: trimmed, finishReason };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    setLastProviderError('pollinations', String(err));
    if (isQuotaExhaustedError(err)) blockProviderUntilTomorrow('pollinations', String(err));
    console.warn(`[Pollinations Stream] Request failed (${modelId}):`, err);
    // 1 provider = 1 call: exit immediately without stream -> non-stream fallback
    return null;
  }
}
