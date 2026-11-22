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
  const candidates = getAionCandidates(modelId);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      opts.signal?.throwIfAborted();
      const completion = await aionClient.chat.completions.create(buildParams(candidate, opts) as never, {
        signal: opts.signal,
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) return { text: stripFluff(text) };
    } catch (err: unknown) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      const status = (err as { status?: number })?.status;
      console.warn(`[AionLabs] Request failed (${candidate}):`, err);
      // Hết credit Tier 0 (402/429) hoặc sai xác thực (401/403): dừng thử candidate khác
      // để models/registry.ts có thể trượt sang provider kế tiếp.
      if (status === 401 || status === 402 || status === 403 || status === 429) {
        break;
      }
    }
  }
  if (lastErr) {
    setLastProviderError('aionlabs', String(lastErr));
    if (isQuotaExhaustedError(lastErr)) blockProviderUntilTomorrow('aionlabs', String(lastErr));
  }
  console.warn(`[AionLabs] All candidates failed (${modelId}):`, lastErr);
  return null;
}

export async function callAionlabsStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const aionClient = getClient();
  if (!aionClient) return null;
  const candidates = getAionCandidates(modelId);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      opts.signal?.throwIfAborted();
      const stream = await aionClient.chat.completions.create(
        { ...buildParams(candidate, opts), stream: true } as never,
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
    } catch (err: unknown) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      const status = (err as { status?: number })?.status;
      console.warn(`[AionLabs Stream] Request failed (${candidate}):`, err);
      if (status === 401 || status === 402 || status === 403 || status === 429) {
        break;
      }
    }
  }
  if (lastErr) {
    setLastProviderError('aionlabs', String(lastErr));
    if (isQuotaExhaustedError(lastErr)) blockProviderUntilTomorrow('aionlabs', String(lastErr));
  }
  console.warn(`[AionLabs Stream] All candidates failed (${modelId}):`, lastErr);
  return null;
}

function normalizeAionModelId(modelId?: string): string {
  const raw = (modelId || "aion-labs/aion-2.0").trim();
  if (!raw.includes("/")) {
    return `aion-labs/${raw}`;
  }
  return raw;
}

function getAionCandidates(requestedModel?: string): string[] {
  const primary = normalizeAionModelId(requestedModel);
  const fallbacks = ["aion-labs/aion-2.0", "aion-labs/aion-rp-llama-3.1-8b"];
  return Array.from(new Set([primary, ...fallbacks]));
}
