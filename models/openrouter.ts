import OpenAI from 'openai';
import { runtimeEnv } from '@/db/runtime';
import type {
  GenerateTextOptions,
  GenerateTextStreamOptions,
  GenerateTextResult,
} from './registry';
import { isQuotaExhaustedError, blockProviderUntilTomorrow, setLastProviderError } from './registry';
import { stripFluff } from '@/lib/anti-fluff';

let openRouterClient: OpenAI | null = null;
let lastOpenRouterKey = '';

export const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-27b:free';
export const OPENROUTER_BACKUP_MODELS = [
  'nvidia/nemotron-3.5-lightning:free',
  'liquid/lfm-2.5-2.6b:free',
  'google/gemma-4-31b-it:free',
];

export function getOpenRouterApiKey(): string {
  const env = runtimeEnv();
  const key =
    env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
  if (!key || key.startsWith('sk-or-your') || key === 'sk-or-...' || key === 'your-openrouter-key') {
    return '';
  }
  return key.trim();
}

export function isOpenRouterAvailable(): boolean {
  return !!getOpenRouterApiKey();
}

export function getOpenRouterClient(): OpenAI | null {
  const currentKey = getOpenRouterApiKey();
  if (!currentKey) return null;

  if (!openRouterClient || lastOpenRouterKey !== currentKey) {
    lastOpenRouterKey = currentKey;
    openRouterClient = new OpenAI({
      apiKey: currentKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://lms-assistant.edu.vn',
        'X-Title': 'LMS Assistant',
      },
    });
  }
  return openRouterClient;
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

/**
 * Call OpenRouter API (non-streaming)
 */
export async function callOpenRouter(
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const client = getOpenRouterClient();
  if (!client) {
    console.warn('OpenRouter client not available (check OPENROUTER_API_KEY)');
    return null;
  }

  try {
    opts.signal?.throwIfAborted();
    const messages = prepareOpenRouterMessages(
      opts.system,
      opts.history,
      opts.userPrompt,
      opts.jsonMode
    );

    // Resolve legacy or unavailable slugs to active free model
    let targetModelId = modelId;
    if (
      targetModelId === 'meta-llama/llama-3.1-8b-instruct:free' ||
      targetModelId === 'meta-llama/llama-3.3-70b-instruct:free' ||
      targetModelId === 'google/gemini-2.0-flash-exp:free'
    ) {
      targetModelId = OPENROUTER_MODEL;
    }

    // Hard limit stop sequences to max 4 to prevent 400 errors from backend models
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
      // Some OpenRouter models reject response_format: { type: 'json_object' }
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

/**
 * Call OpenRouter API with streaming
 */
export async function callOpenRouterStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const client = getOpenRouterClient();
  if (!client) {
    console.warn('OpenRouter client not available (check OPENROUTER_API_KEY)');
    return null;
  }

  try {
    opts.signal?.throwIfAborted();
    const messages = prepareOpenRouterMessages(
      opts.system,
      opts.history,
      opts.userPrompt,
      opts.jsonMode
    );

    let targetModelId = modelId;
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
      // Only stream content to the user; do NOT stream internal reasoning tokens
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
      const fallback = await callOpenRouter(modelId, opts);
      if (fallback?.text) {
        opts.onDelta(fallback.text);
        return fallback;
      }
    }

    return { text: accumulatedText.trim(), finishReason };
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
