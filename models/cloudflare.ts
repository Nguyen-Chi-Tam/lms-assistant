import { runtimeEnv, getCloudflareAIBinding } from '@/db/runtime';
import type {
  GenerateTextOptions,
  GenerateTextStreamOptions,
  GenerateTextResult,
} from './registry';
import { isQuotaExhaustedError, blockProviderUntilTomorrow } from './registry';

export const CLOUDFLARE_DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const CLOUDFLARE_BACKUP_MODELS = [
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen1.5-14b-chat-awq',
];

export const CLOUDFLARE_EMBEDDING_MODEL = '@cf/baai/bge-m3';

export function getCloudflareConfig(): {
  accountId: string;
  apiToken: string;
  hasBinding: boolean;
} {
  const env = runtimeEnv();
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const apiToken = (env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const binding = getCloudflareAIBinding();
  return {
    accountId,
    apiToken,
    hasBinding: !!binding,
  };
}

export function isCloudflareAvailable(): boolean {
  const cfg = getCloudflareConfig();
  return cfg.hasBinding || (!!cfg.accountId && !!cfg.apiToken);
}

function cleanModelName(modelId: string): string {
  if (modelId.startsWith('cloudflare:')) {
    return modelId.replace('cloudflare:', '');
  }
  if (!modelId.startsWith('@cf/')) {
    return `@cf/${modelId}`;
  }
  return modelId;
}

function prepareMessages(
  system: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  userPrompt: string,
  jsonMode?: boolean
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  let effectiveSystem = system;
  if (jsonMode) {
    effectiveSystem += '\n\nBẮT BUỘC: Bạn PHẢI trả về duy nhất một đối tượng JSON hợp lệ, không chứa giải thích hay markdown code block ngoài JSON.';
  }

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (effectiveSystem) {
    messages.push({ role: 'system', content: effectiveSystem });
  }

  if (history && history.length > 0) {
    for (const h of history) {
      messages.push({ role: h.role, content: h.content });
    }
  }

  messages.push({ role: 'user', content: userPrompt });
  return messages;
}

/**
 * Call Cloudflare Workers AI (Non-streaming).
 * Tries Native Edge Binding (`env.AI`) first for ultra-low latency,
 * falls back to Cloudflare REST API when running outside Workers edge.
 */
export async function callCloudflareAI(
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const cfg = getCloudflareConfig();
  if (!isCloudflareAvailable()) {
    return null;
  }

  const cleanModel = cleanModelName(modelId || CLOUDFLARE_DEFAULT_MODEL);
  const messages = prepareMessages(opts.system, opts.history, opts.userPrompt, opts.jsonMode);
  const aiBinding = getCloudflareAIBinding();

  opts.signal?.throwIfAborted();

  // 1. TIER 1: Native Cloudflare Workers AI Binding (env.AI) - Zero HTTP Overhead
  if (aiBinding) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bindingParams: Record<string, any> = {
        messages,
        temperature: opts.temperature ?? 0.2,
      };
      if (opts.topP !== undefined) {
        bindingParams.top_p = opts.topP === 0 ? 0.001 : opts.topP;
      }
      if (opts.maxTokens !== undefined) {
        bindingParams.max_tokens = opts.maxTokens;
      }

      const res = await aiBinding.run(cleanModel, bindingParams);
      const text = res?.response || res?.result?.response || (typeof res === 'string' ? res : '');
      if (text && text.trim()) {
        return { text: text.trim() };
      }
    } catch (bindingErr) {
      if (opts.signal?.aborted) throw bindingErr;
      console.warn(`[Cloudflare AI Binding] Failed for ${cleanModel}, falling back to REST:`, bindingErr);
    }
  }

  // 2. TIER 2: Cloudflare REST API (client/v4/accounts/{accountId}/ai/run/{model})
  if (cfg.accountId && cfg.apiToken) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: Record<string, any> = {
        messages,
        temperature: opts.temperature ?? 0.2,
      };
      if (opts.topP !== undefined) {
        body.top_p = opts.topP === 0 ? 0.001 : opts.topP;
      }
      if (opts.maxTokens !== undefined) {
        body.max_tokens = opts.maxTokens;
      }

      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${cleanModel}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (res.status === 429) {
        const errText = await res.text().catch(() => '');
        throw new Error(`429 Cloudflare Workers AI quota exceeded: ${errText}`);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Cloudflare Workers AI HTTP ${res.status}: ${errText}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      const text = data?.result?.response || data?.response || '';
      if (text && text.trim()) {
        return { text: text.trim() };
      }
    } catch (restErr) {
      if (opts.signal?.aborted) throw restErr;
      if (isQuotaExhaustedError(restErr)) {
        blockProviderUntilTomorrow('cloudflare', String(restErr));
      }
      console.warn(`[Cloudflare AI REST] Execution error for ${cleanModel}:`, restErr);
    }
  }

  return null;
}

/**
 * Call Cloudflare Workers AI with Streaming.
 */
export async function callCloudflareAIStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const cfg = getCloudflareConfig();
  if (!isCloudflareAvailable()) {
    return null;
  }

  const cleanModel = cleanModelName(modelId || CLOUDFLARE_DEFAULT_MODEL);
  const messages = prepareMessages(opts.system, opts.history, opts.userPrompt, opts.jsonMode);
  const aiBinding = getCloudflareAIBinding();

  opts.signal?.throwIfAborted();

  // 1. TIER 1: Native Binding Streaming
  if (aiBinding) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bindingParams: Record<string, any> = {
        messages,
        temperature: opts.temperature ?? 0.2,
        stream: true,
      };
      if (opts.topP !== undefined) {
        bindingParams.top_p = opts.topP === 0 ? 0.001 : opts.topP;
      }
      if (opts.maxTokens !== undefined) {
        bindingParams.max_tokens = opts.maxTokens;
      }

      const stream = await aiBinding.run(cleanModel, bindingParams);
      if (stream && typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');
        let fullText = '';
        let buffer = '';

        while (true) {
          opts.signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(dataStr);
              const chunk = parsed.response || '';
              if (chunk) {
                fullText += chunk;
                opts.onDelta(chunk);
              }
            } catch {
              // Ignore partial JSON
            }
          }
        }

        if (fullText.trim()) {
          return { text: fullText.trim(), finishReason: 'stop' };
        }
      }
    } catch (bindingStreamErr) {
      if (opts.signal?.aborted) throw bindingStreamErr;
      console.warn(`[Cloudflare AI Binding Stream] failed for ${cleanModel}, trying REST:`, bindingStreamErr);
    }
  }

  // 2. TIER 2: REST API Streaming
  if (cfg.accountId && cfg.apiToken) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: Record<string, any> = {
        messages,
        temperature: opts.temperature ?? 0.2,
        stream: true,
      };
      if (opts.topP !== undefined) {
        body.top_p = opts.topP === 0 ? 0.001 : opts.topP;
      }
      if (opts.maxTokens !== undefined) {
        body.max_tokens = opts.maxTokens;
      }

      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${cleanModel}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (res.status === 429) {
        const errText = await res.text().catch(() => '');
        throw new Error(`429 Cloudflare Workers AI quota exceeded: ${errText}`);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Cloudflare Workers AI Stream HTTP ${res.status}: ${errText}`);
      }

      if (!res.body) {
        return null;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let fullText = '';
      let buffer = '';

      while (true) {
        opts.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') break;
          try {
            const parsed = JSON.parse(dataStr);
            const chunk = parsed.response || '';
            if (chunk) {
              fullText += chunk;
              opts.onDelta(chunk);
            }
          } catch {
            // Ignore partial SSE chunk
          }
        }
      }

      if (fullText.trim()) {
        return { text: fullText.trim(), finishReason: 'stop' };
      }
    } catch (restStreamErr) {
      if (opts.signal?.aborted) throw restStreamErr;
      if (isQuotaExhaustedError(restStreamErr)) {
        blockProviderUntilTomorrow('cloudflare', String(restStreamErr));
      }
      console.warn(`[Cloudflare AI REST Stream] error for ${cleanModel}:`, restStreamErr);
    }
  }

  // Fallback to non-streaming if stream reader yielded empty
  const fallback = await callCloudflareAI(cleanModel, opts);
  if (fallback?.text) {
    opts.onDelta(fallback.text);
    return fallback;
  }
  return null;
}

/**
 * Generate Vector Embeddings using Cloudflare Workers AI.
 * Uses `@cf/baai/bge-m3` (Multilingual) or `@cf/baai/bge-large-en-v1.5`.
 */
export async function generateCloudflareEmbeddings(
  texts: string[],
  model: string = CLOUDFLARE_EMBEDDING_MODEL
): Promise<number[][] | null> {
  if (!texts || texts.length === 0 || !isCloudflareAvailable()) {
    return null;
  }

  const cleanModel = cleanModelName(model);
  const cfg = getCloudflareConfig();
  const aiBinding = getCloudflareAIBinding();

  // 1. Native Binding
  if (aiBinding) {
    try {
      const res = await aiBinding.run(cleanModel, { text: texts });
      if (Array.isArray(res?.data)) {
        return res.data;
      }
    } catch (err) {
      console.warn(`[Cloudflare Embeddings Binding] error for ${cleanModel}:`, err);
    }
  }

  // 2. REST API
  if (cfg.accountId && cfg.apiToken) {
    try {
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${cleanModel}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: texts }),
      });

      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = (await res.json()) as any;
        if (Array.isArray(json?.result?.data)) {
          return json.result.data;
        }
      }
    } catch (err) {
      console.warn(`[Cloudflare Embeddings REST] error for ${cleanModel}:`, err);
    }
  }

  return null;
}
