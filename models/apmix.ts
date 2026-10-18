import OpenAI from 'openai';
import { runtimeEnv } from '@/db/runtime';
import type {
  GenerateTextOptions,
  GenerateTextStreamOptions,
  GenerateTextResult,
} from './registry';
import { isQuotaExhaustedError, blockProviderUntilTomorrow, setLastProviderError } from './registry';
import { stripFluff } from '@/lib/anti-fluff';

let apmixClient: OpenAI | null = null;
let lastApmixKey = '';
let lastApmixBaseUrl = '';

export const APMIX_DEFAULT_BASE_URL = 'https://api.apmix.ai/v1';
export const APMIX_DEFAULT_MODEL =
  process.env.APMIX_MODEL || 'claude-sonnet-4-6-free';
export const APMIX_BACKUP_MODELS = [
  'gpt-6-luna-free',
];

/**
 * Maps model aliases and legacy slugs to currently valid APMIX model identifiers.
 */
export function resolveApmixModel(modelId?: string): string {
  const trimmed = (modelId || '').trim();
  if (!trimmed || trimmed === 'auto') return APMIX_DEFAULT_MODEL;
  if (trimmed.includes('claude-sonnet') || trimmed === 'claude-sonnet-4-6-free' || trimmed === 'anthropic/claude-sonnet-4-6-free') {
    return 'claude-sonnet-4-6-free';
  }
  if (trimmed.includes('gpt-6') || trimmed === 'gpt-6-luna-free' || trimmed === 'openai/gpt-6-luna-free') {
    return 'gpt-6-luna-free';
  }
  // If user selected legacy/removed model slugs, transparently map to active free Claude Sonnet
  if (trimmed.includes('haiku') || trimmed.includes('gemini') || trimmed.includes('deepseek')) {
    return 'claude-sonnet-4-6-free';
  }
  return trimmed;
}

export function getApmixApiKey(): string {
  const env = runtimeEnv() as Record<string, string | undefined>;
  const key = env.APMIX_API_KEY || process.env.APMIX_API_KEY || '';
  if (!key || key.startsWith('apx_live_your') || key === 'apx_live_...' || key === 'your-apmix-key') {
    return '';
  }
  return key.trim();
}

export function getApmixBaseUrl(): string {
  const env = runtimeEnv() as Record<string, string | undefined>;
  const url = env.APMIX_BASE_URL || process.env.APMIX_BASE_URL || APMIX_DEFAULT_BASE_URL;
  return url.trim().replace(/\/+$/, '');
}

export function isApmixAvailable(): boolean {
  return !!getApmixApiKey();
}

export function getApmixClient(): OpenAI | null {
  const currentKey = getApmixApiKey();
  const currentBaseUrl = getApmixBaseUrl();
  if (!currentKey) return null;

  if (!apmixClient || lastApmixKey !== currentKey || lastApmixBaseUrl !== currentBaseUrl) {
    lastApmixKey = currentKey;
    lastApmixBaseUrl = currentBaseUrl;
    apmixClient = new OpenAI({
      apiKey: currentKey,
      baseURL: currentBaseUrl,
      defaultHeaders: {
        'HTTP-Referer': 'https://lms-assistant.edu.vn',
        'X-Title': 'LMS Assistant',
      },
    });
  }
  return apmixClient;
}

function prepareApmixMessages(
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

/**
 * Call APMIX API (non-streaming)
 */
export async function callApmix(
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const client = getApmixClient();
  if (!client) {
    console.warn('APMIX client not available (check APMIX_API_KEY)');
    return null;
  }

  try {
    opts.signal?.throwIfAborted();
    const messages = prepareApmixMessages(
      opts.system,
      opts.history,
      opts.userPrompt,
      opts.jsonMode
    );

    const targetModelId = resolveApmixModel(modelId);
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
    } catch (createErr: unknown) {
      // Some models or proxies reject response_format: { type: 'json_object' }
      if (
        opts.jsonMode &&
        (typeof createErr === 'object' && createErr !== null && ('status' in createErr || String(createErr).includes('response_format')))
      ) {
        delete createParams.response_format;
        completion = await client.chat.completions.create(createParams);
      } else {
        throw createErr;
      }
    }

    const choice = completion.choices[0];
    const rawContent = choice?.message?.content?.trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawReasoning = (choice?.message as any)?.reasoning?.trim();
    const text = (rawContent || rawReasoning || '').trim();
    if (!text) return null;

    return { text: stripFluff(text), finishReason: choice?.finish_reason || undefined };
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errMsg = (err as any)?.message || (err as any)?.error?.message || String(err);
    setLastProviderError('apmix', errMsg);
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('apmix', String(err));
    }
    console.warn(`callApmix (${modelId}) failed:`, err);
    return null;
  }
}

/**
 * Call APMIX API with streaming
 */
export async function callApmixStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const client = getApmixClient();
  if (!client) {
    console.warn('APMIX client not available (check APMIX_API_KEY)');
    return null;
  }

  try {
    opts.signal?.throwIfAborted();
    const messages = prepareApmixMessages(
      opts.system,
      opts.history,
      opts.userPrompt,
      opts.jsonMode
    );

    const targetModelId = resolveApmixModel(modelId);
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
    } catch (createErr: unknown) {
      if (
        opts.jsonMode &&
        (typeof createErr === 'object' && createErr !== null && ('status' in createErr || String(createErr).includes('response_format')))
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
      // Fallback to non-stream if stream yielded empty response
      const fallback = await callApmix(modelId, opts);
      if (fallback?.text) {
        opts.onDelta(fallback.text);
        return fallback;
      }
    }

    return { text: accumulatedText.trim(), finishReason };
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errMsg = (err as any)?.message || (err as any)?.error?.message || String(err);
    setLastProviderError('apmix', errMsg);
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('apmix', String(err));
    }
    console.warn(`callApmixStream (${modelId}) failed:`, err);

    // Fallback to non-streaming if stream crashed
    try {
      const fallback = await callApmix(modelId, opts);
      if (fallback?.text) {
        opts.onDelta(fallback.text);
        return fallback;
      }
    } catch (fallbackErr) {
      console.warn(`callApmix non-stream fallback (${modelId}) failed:`, fallbackErr);
    }
    return null;
  }
}

