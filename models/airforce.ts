import OpenAI from 'openai';
import { runtimeEnv } from '@/db/runtime';
import type {
  GenerateTextOptions,
  GenerateTextStreamOptions,
  GenerateTextResult,
} from './registry';
import { blockProviderUntilTomorrow, isQuotaExhaustedError, setLastProviderError } from './registry';
import { stripFluff } from '@/lib/anti-fluff';

let client: OpenAI | null = null;
let cachedKey = '';
let cachedBaseUrl = '';

export const AIRFORCE_DEFAULT_BASE_URL = 'https://api.airforce/v1';
export const AIRFORCE_DEFAULT_MODEL = process.env.AIRFORCE_MODEL || 'kimi-k2.7-code';
export const AIRFORCE_BACKUP_MODELS = ['llama-instant', 'mistral-large-4'];
export const AIRFORCE_TIMEOUT_MS = 15_000;

function getConfig(): { apiKey: string; baseUrl: string } {
  const env = runtimeEnv() as Record<string, string | undefined>;
  return {
    apiKey: (env.AIRFORCE_API_KEY || process.env.AIRFORCE_API_KEY || '').trim(),
    baseUrl: (env.AIRFORCE_BASE_URL || process.env.AIRFORCE_BASE_URL || AIRFORCE_DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, ''),
  };
}

export function isAirforceAvailable(): boolean {
  return Boolean(getConfig().apiKey);
}

function getClient(): OpenAI | null {
  const config = getConfig();
  if (!config.apiKey) return null;
  if (!client || cachedKey !== config.apiKey || cachedBaseUrl !== config.baseUrl) {
    client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: AIRFORCE_TIMEOUT_MS,
    });
    cachedKey = config.apiKey;
    cachedBaseUrl = config.baseUrl;
  }
  return client;
}

function messages(opts: GenerateTextOptions): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
    ...(opts.history || []),
    { role: 'user', content: opts.userPrompt },
  ];
}

function params(modelId: string, opts: GenerateTextOptions): Record<string, unknown> {
  return {
    model: modelId || AIRFORCE_DEFAULT_MODEL,
    messages: messages(opts),
    temperature: opts.temperature ?? 0.2,
    ...(opts.topP !== undefined ? { top_p: opts.topP === 0 ? 0.001 : opts.topP } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.stop?.length || opts.stopSequences?.length
      ? { stop: (opts.stop || opts.stopSequences)?.slice(0, 4) }
      : {}),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

export async function callAirforce(
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const airforceClient = getClient();
  if (!airforceClient) return null;
  try {
    opts.signal?.throwIfAborted();
    const completion = await airforceClient.chat.completions.create(params(modelId, opts) as never, {
      signal: opts.signal,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text ? { text: stripFluff(text) } : null;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    setLastProviderError('airforce', String(err));
    if (isQuotaExhaustedError(err)) blockProviderUntilTomorrow('airforce', String(err));
    console.warn(`[Airforce] Request failed (${modelId}); moving to the next system provider:`, err);
    return null;
  }
}

export async function callAirforceStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const airforceClient = getClient();
  if (!airforceClient) return null;
  try {
    opts.signal?.throwIfAborted();
    const stream = await airforceClient.chat.completions.create(
      { ...params(modelId, opts), stream: true } as never,
      { signal: opts.signal }
    );
    let text = '';
    let finishReason: string | undefined;
    for await (const chunk of stream as unknown as AsyncIterable<{
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
    }>) {
      opts.signal?.throwIfAborted();
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta) {
        text += delta;
        opts.onDelta(delta);
      }
      finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
    }
    return text.trim() ? { text: text.trim(), finishReason } : null;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    setLastProviderError('airforce', String(err));
    if (isQuotaExhaustedError(err)) blockProviderUntilTomorrow('airforce', String(err));
    console.warn(`[Airforce Stream] Request failed (${modelId}); moving to the next system provider:`, err);
    return null;
  }
}
