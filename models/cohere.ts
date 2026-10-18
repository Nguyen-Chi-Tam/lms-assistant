import { runtimeEnv } from '@/db/runtime';
import type { GenerateTextOptions, GenerateTextStreamOptions, GenerateTextResult } from './registry';

export const COHERE_MODEL = 'command-r-08-2024';
export const COHERE_BACKUP_MODELS = ['command-r-plus-08-2024'];

export function getCohereApiKey(): string {
  const env = runtimeEnv();
  const key = env.COHERE_API_KEY || process.env.COHERE_API_KEY || '';
  if (!key || key.startsWith('your_') || key === 'cohere_...') {
    return '';
  }
  return key.trim();
}

export function isCohereAvailable(): boolean {
  return !!getCohereApiKey();
}

/**
 * Cohere API strictly requires `id` length to be less than 100 characters
 * and contain alphanumeric / underscore / hyphen characters.
 */
function sanitizeCohereDocId(rawId: string | undefined, index: number): string {
  if (!rawId) return `doc_${index + 1}`;
  const cleaned = String(rawId)
    .replace(/[^\w-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  return cleaned ? `doc_${index + 1}_${cleaned}`.slice(0, 70) : `doc_${index + 1}`;
}

/**
 * Call Cohere Chat API (non-streaming)
 * Supports Cohere v2 API with fallback to v1
 */
export async function callCohere(
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  const apiKey = getCohereApiKey();
  if (!apiKey) return null;

  opts.signal?.throwIfAborted();

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: opts.system },
  ];

  if (opts.history && opts.history.length > 0) {
    for (const msg of opts.history) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: opts.userPrompt });

  // Try v2 Chat API first
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v2Body: Record<string, any> = {
      model: modelId,
      messages,
      temperature: opts.temperature ?? 0.0,
      frequency_penalty: 0.1,
      presence_penalty: 0.0,
    };

    if (opts.topP !== undefined) {
      v2Body.p = opts.topP;
    }

    if (opts.maxTokens !== undefined) {
      v2Body.max_tokens = opts.maxTokens;
    }

    // Study tools require machine-readable data.  A prompt alone is not
    // sufficient for Cohere, especially for a large slide deck.
    if (opts.jsonMode) {
      v2Body.response_format = { type: 'json_object' };
    }

    const stopSequences = (opts.stopSequences || opts.stop)?.slice(0, 5);
    if (stopSequences && stopSequences.length > 0) {
      v2Body.stop_sequences = stopSequences;
    }

    if (opts.documents && opts.documents.length > 0) {
      v2Body.documents = opts.documents.slice(0, 15).map((d, idx) => ({
        id: sanitizeCohereDocId(d.id, idx),
        data: {
          title: (d.title || `Tài liệu ${idx + 1}`).slice(0, 200),
          text: d.text || '',
        },
      }));
    }

    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(v2Body),
      signal: opts.signal,
    });

    if (res.status === 429) {
      const errText = await res.text().catch(() => '');
      throw new Error(`429 rate limit / quota exceeded: ${errText}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`Cohere v2 chat failed (${res.status}): ${errText}`);
      // Fall through to v1 fallback below
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      const text =
        data.message?.content?.[0]?.text ||
        data.text ||
        '';
      if (text.trim()) {
        return { text: text.trim() };
      }
    }
  } catch (v2Err) {
    if (opts.signal?.aborted) throw v2Err;
    if (String(v2Err).includes('429')) throw v2Err;
    console.warn('Cohere v2 error, trying v1:', v2Err);
  }

  // Fallback to Cohere v1 API
  try {
    const chatHistory = (opts.history || []).map(h => ({
      role: h.role === 'user' ? 'USER' : 'CHATBOT',
      message: h.content,
    }));

    const modelV1 = modelId === 'command-r' ? 'command-r-08-2024' : modelId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v1Body: Record<string, any> = {
      model: modelV1,
      message: opts.userPrompt,
      preamble: opts.system,
      chat_history: chatHistory,
      temperature: opts.temperature ?? 0.0,
    };

    if (opts.topP !== undefined) {
      v1Body.p = opts.topP;
    }

    if (opts.maxTokens !== undefined) {
      v1Body.max_tokens = opts.maxTokens;
    }

    if (opts.jsonMode) {
      v1Body.response_format = { type: 'json_object' };
    }

    const stopSequencesV1 = (opts.stopSequences || opts.stop)?.slice(0, 5);
    if (stopSequencesV1 && stopSequencesV1.length > 0) {
      v1Body.stop_sequences = stopSequencesV1;
    }

    if (opts.documents && opts.documents.length > 0) {
      v1Body.documents = opts.documents.slice(0, 15).map((d, idx) => ({
        id: sanitizeCohereDocId(d.id, idx),
        title: (d.title || `Tài liệu ${idx + 1}`).slice(0, 200),
        snippet: d.text || '',
      }));
    }

    const resV1 = await fetch('https://api.cohere.ai/v1/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(v1Body),
      signal: opts.signal,
    });

    if (resV1.status === 429) {
      const errText = await resV1.text().catch(() => '');
      throw new Error(`429 rate limit / quota exceeded: ${errText}`);
    }

    if (!resV1.ok) {
      const errText = await resV1.text().catch(() => '');
      throw new Error(`Cohere v1 chat failed (${resV1.status}): ${errText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataV1 = (await resV1.json()) as any;
    const text = dataV1.text || '';
    if (text.trim()) {
      return { text: text.trim() };
    }
    return null;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw err;
  }
}

/**
 * Call Cohere Chat API with streaming
 */
export async function callCohereStream(
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  const apiKey = getCohereApiKey();
  if (!apiKey) return null;

  opts.signal?.throwIfAborted();

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: opts.system },
  ];

  if (opts.history && opts.history.length > 0) {
    for (const msg of opts.history) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: opts.userPrompt });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamBody: Record<string, any> = {
      model: modelId,
      messages,
      temperature: opts.temperature ?? 0.0,
      frequency_penalty: 0.1,
      presence_penalty: 0.0,
      stream: true,
    };

    if (opts.topP !== undefined) {
      streamBody.p = opts.topP;
    }

    if (opts.maxTokens !== undefined) {
      streamBody.max_tokens = opts.maxTokens;
    }

    const stopStreamSequences = (opts.stopSequences || opts.stop)?.slice(0, 5);
    if (stopStreamSequences && stopStreamSequences.length > 0) {
      streamBody.stop_sequences = stopStreamSequences;
    }

    if (opts.documents && opts.documents.length > 0) {
      streamBody.documents = opts.documents.slice(0, 15).map((d, idx) => ({
        id: sanitizeCohereDocId(d.id, idx),
        data: {
          title: (d.title || `Tài liệu ${idx + 1}`).slice(0, 200),
          text: d.text || '',
        },
      }));
    }

    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(streamBody),
      signal: opts.signal,
    });

  if (res.status === 429) {
    const errText = await res.text().catch(() => '');
    throw new Error(`429 rate limit / quota exceeded: ${errText}`);
  }

  if (!res.ok) {
    // If stream fails, fallback to non-streaming callCohere
    const errText = await res.text().catch(() => '');
    console.warn(`Cohere stream failed (${res.status}): ${errText}, fallback to non-stream`);
    const fallback = await callCohere(modelId, opts);
    if (fallback?.text) {
      opts.onDelta(fallback.text);
      return fallback;
    }
    return null;
  }

  if (!res.body) {
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullText = '';
  let buffer = '';
  let shouldStopLoop = false;

  try {
    while (!shouldStopLoop) {
      opts.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.replace(/^data:\s*/, '');
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          // Cohere v2 streaming format: delta.message.content.text
          const delta =
            parsed.delta?.message?.content?.text ||
            parsed.text ||
            '';
          if (delta) {
            fullText += delta;
            opts.onDelta(delta);

            // Anti-loop safeguard: If the same 20+ char phrase repeats 3 times consecutively, break
            const recentTail = fullText.slice(-300);
            const tailLines = recentTail.split('\n').map(l => l.trim()).filter(l => l.length > 20);
            if (tailLines.length >= 3) {
              const lastLine = tailLines[tailLines.length - 1];
              if (tailLines[tailLines.length - 2] === lastLine && tailLines[tailLines.length - 3] === lastLine) {
                console.warn('[Cohere Stream] Repetition loop detected, stopping stream gracefully.');
                shouldStopLoop = true;
                break;
              }
            }
          }
        } catch {
          // ignore non-json SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const trimmedText = fullText.trim();
  if (!trimmedText) {
    // fallback if no text streamed
    return await callCohere(modelId, opts);
  }

  return { text: trimmedText };
}

export interface RerankableChunk {
  id: string;
  docTitle: string;
  text: string;
  chunkIndex: number;
  totalChunks: number;
  similarityScore?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any;
  embedding?: number[];
}

/**
 * Scanning Gatekeeper: Uses Cohere's dedicated Rerank API (cross-encoder)
 * to re-score candidate chunks based on true semantic query-passage interaction.
 * 
 * IMPORTANT: This uses Cohere's independent RERANK quota, NOT Chat quota.
 * It eliminates ~70% noisy/fragmented chunks before passing to the primary Chat LLM.
 */
export async function rerankChunksWithCohere<T extends RerankableChunk>(
  query: string,
  chunks: T[],
  options: {
    topN?: number;
    minScore?: number;
    model?: string;
  } = {}
): Promise<T[] | null> {
  const apiKey = getCohereApiKey();
  if (!apiKey || !query.trim() || chunks.length === 0) {
    return null;
  }

  // If only 1-2 chunks, reranking is unnecessary
  if (chunks.length <= 2) {
    return chunks;
  }

  const topN = options.topN ?? 3;
  const minScore = options.minScore ?? 0.2;
  const rerankModel = options.model || 'rerank-multilingual-v3.0';

  // Prepare input passages for Cohere (cap at top 15 candidates to keep request fast and cheap)
  const candidatePool = chunks.slice(0, 15);
  const documents = candidatePool.map(c => `${c.docTitle}\n${c.text}`);

  try {
    // 1. Try Cohere v2 Rerank API first
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const v2Body = {
      model: rerankModel,
      query: query.trim(),
      documents,
      top_n: topN,
    };

    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(v2Body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      if (Array.isArray(data.results) && data.results.length > 0) {
        const reranked: T[] = [];
        for (const item of data.results) {
          const original = candidatePool[item.index];
          const score = typeof item.relevance_score === 'number' ? item.relevance_score : 0;
          if (original && score >= minScore) {
            reranked.push({
              ...original,
              similarityScore: Math.round(score * 1000) / 1000,
            });
          }
        }
        if (reranked.length > 0) {
          console.log(
            `[Cohere Rerank v2] Scanned ${candidatePool.length} candidate chunks -> Selected ${reranked.length} top chunks (Top score: ${reranked[0]?.similarityScore})`
          );
          return reranked;
        }
      }
    } else {
      console.warn(`[Cohere Rerank] v2 failed with status ${res.status}, attempting v1 fallback...`);
    }
  } catch (err) {
    console.warn('[Cohere Rerank v2] error, trying v1:', err);
  }

  // 2. Fallback to Cohere v1 Rerank API
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const v1Body = {
      model: 'rerank-multilingual-v3.0',
      query: query.trim(),
      documents,
      top_n: topN,
      return_documents: false,
    };

    const resV1 = await fetch('https://api.cohere.com/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(v1Body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (resV1.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dataV1 = (await resV1.json()) as any;
      if (Array.isArray(dataV1.results) && dataV1.results.length > 0) {
        const reranked: T[] = [];
        for (const item of dataV1.results) {
          const original = candidatePool[item.index];
          const score = typeof item.relevance_score === 'number' ? item.relevance_score : 0;
          if (original && score >= minScore) {
            reranked.push({
              ...original,
              similarityScore: Math.round(score * 1000) / 1000,
            });
          }
        }
        if (reranked.length > 0) {
          console.log(
            `[Cohere Rerank v1] Scanned ${candidatePool.length} candidates -> Kept ${reranked.length} top chunks (Top score: ${reranked[0]?.similarityScore})`
          );
          return reranked;
        }
      }
    }
  } catch (err) {
    console.warn('[Cohere Rerank v1] fallback failed:', err);
  }

  // Return null so calling layer falls back gracefully to vector/BM25 scoring
  return null;
}


