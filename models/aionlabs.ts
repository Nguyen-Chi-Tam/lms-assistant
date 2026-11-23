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

export const AIONLABS_DEFAULT_BASE_URL = 'https://api.aionlabs.ai/v1';
export const AIONLABS_DEFAULT_MODEL = process.env.AIONLABS_MODEL || 'aion-2.0';
export const AIONLABS_BACKUP_MODELS = ['aion-2.0'];
export const AIONLABS_TIMEOUT_MS = 30_000;

function getConfig(): { apiKey: string; baseUrl: string } {
  const env = runtimeEnv() as Record<string, string | undefined>;
  return {
    apiKey: (env.AIONLABS_API_KEY || process.env.AIONLABS_API_KEY || '').trim(),
    baseUrl: (env.AIONLABS_BASE_URL || process.env.AIONLABS_BASE_URL || AIONLABS_DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, ''),
  };
}

export function isAionlabsAvailable(): boolean {
  return Boolean(getConfig().apiKey);
}

function getClient(): OpenAI | null {
  const config = getConfig();
  if (!config.apiKey) return null;
  if (!client || cachedKey !== config.apiKey || cachedBaseUrl !== config.baseUrl) {
    client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: AIONLABS_TIMEOUT_MS,
      maxRetries: 0,
    });
    cachedKey = config.apiKey;
    cachedBaseUrl = config.baseUrl;
  }
  return client;
}

function buildMessages(opts: GenerateTextOptions): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
    ...(opts.history || []),
    { role: 'user', content: opts.userPrompt },
  ];
}

function buildParams(modelId: string, opts: GenerateTextOptions): Record<string, unknown> {
  return {
    model: modelId || AIONLABS_DEFAULT_MODEL,
    messages: buildMessages(opts),
    temperature: opts.temperature ?? 0.2,
    ...(opts.topP !== undefined ? { top_p: opts.topP === 0 ? 0.001 : opts.topP } : {}),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.stop?.length || opts.stopSequences?.length
      ? { stop: (opts.stop || opts.stopSequences)?.slice(0, 4) }
      : {}),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

export async function callAionlabs(
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const aionClient = getClient();
  if (!aionClient) return null;
  // 1 provider = 1 call = 1 model ID (no internal fallback model loop)
  const targetModel = normalizeAionModelId(modelId);
  try {
    opts.signal?.throwIfAborted();
    const completion = await aionClient.chat.completions.create(buildParams(targetModel, opts) as never, {
      signal: opts.signal,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (text) return { text: stripFluff(text) };
    return null;
  } catch (err: unknown) {
    if (opts.signal?.aborted) throw err;
    setLastProviderError('aionlabs', String(err));
    if (isQuotaExhaustedError(err)) blockProviderUntilTomorrow('aionlabs', String(err));
    console.warn(`[AionLabs] Request failed (${targetModel}):`, err);
    return null;
  }
}

export async function callAionlabsStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const aionClient = getClient();
  if (!aionClient) return null;
  // 1 provider = 1 call = 1 model ID (no internal fallback model loop)
  const targetModel = normalizeAionModelId(modelId);
  try {
    opts.signal?.throwIfAborted();
    const stream = await aionClient.chat.completions.create(
      { ...buildParams(targetModel, opts), stream: true } as never,
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
    if (text.trim()) return { text: text.trim(), finishReason };
    return null;
  } catch (err: unknown) {
    if (opts.signal?.aborted) throw err;
    setLastProviderError('aionlabs', String(err));
    if (isQuotaExhaustedError(err)) blockProviderUntilTomorrow('aionlabs', String(err));
    console.warn(`[AionLabs Stream] Request failed (${targetModel}):`, err);
    return null;
  }
}

function normalizeAionModelId(modelId?: string): string {
  const raw = (modelId || 'aion-labs/aion-2.0').trim();
  if (!raw.includes('/')) {
    return `aion-labs/${raw}`;
  }
  return raw;
}
