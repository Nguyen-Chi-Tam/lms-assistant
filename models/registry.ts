import { runtimeEnv } from '@/db/runtime';
import {
  executeWithGeminiPool,
  isAllGeminiKeysBlocked,
  getGeminiEarliestUnblockTime,
  getAvailableKeySlots,
  GEMINI_MODEL,
  GEMINI_BACKUP_MODELS,
} from './gemini';
import {
  getGroqClient,
  executeWithGroqPool,
  isAllGroqKeysBlocked,
  GROQ_MODEL,
  GROQ_BACKUP_MODELS,
} from './groq';
import { getAnthropicClient, ANTHROPIC_MODELS } from './anthropic';
import {
  isCohereAvailable,
  callCohere,
  callCohereStream,
  COHERE_MODEL,
  COHERE_BACKUP_MODELS,
} from './cohere';
import {
  isOpenRouterAvailable,
  callOpenRouter,
  callOpenRouterStream,
  OPENROUTER_MODEL,
  OPENROUTER_BACKUP_MODELS,
} from './openrouter';
import {
  isCloudflareAvailable,
  callCloudflareAI,
  callCloudflareAIStream,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_BACKUP_MODELS,
} from './cloudflare';
import {
  isApmixAvailable,
  callApmix,
  callApmixStream,
  APMIX_DEFAULT_MODEL,
  APMIX_BACKUP_MODELS,
} from './apmix';
import { buildUniversalLanguageDirective } from '@/lib/language-detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AIProvider = 'cohere' | 'gemini' | 'groq' | 'anthropic' | 'datacurso' | 'cache' | 'openrouter' | 'cloudflare' | 'apmix';

export interface ModelOption {
  /** Format: "provider:modelId" */
  id: string;
  provider: AIProvider;
  modelId: string;
  label: string;
  available: boolean;
}

export interface GenerateTextOptions {
  system: string;
  userPrompt: string;
  signal?: AbortSignal;
  /** Chat history in OpenAI-style format */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  topP?: number;
  /** Physical hard limit on response tokens (e.g. 250 for concise, 2500 for detailed) */
  maxTokens?: number;
  /** Request JSON-only output (supported by Groq, OpenAI, Anthropic; Gemini uses responseMimeType) */
  jsonMode?: boolean;
  /** Enable Google Search Grounding (Gemini only) */
  googleSearchGrounding?: boolean;
  /** Native RAG document chunks for models supporting native document grounding (Cohere) */
  documents?: Array<{ id?: string; title?: string; text: string }>;
  /**
   * RAG Mode:
   * - 'strict': Groq (2 Keys) -> Cloudflare Workers AI -> Gemini (2 Keys) -> OpenRouter
   * - 'creative': Gemini (2 Keys) -> OpenRouter -> Groq (2 Keys) -> Cloudflare Workers AI -> Cohere (Command R)
   * - 'hybrid': Gemini (2 Keys) -> Groq (2 Keys) -> Cloudflare Workers AI -> OpenRouter
   */
  ragMode?: 'strict' | 'hybrid' | 'creative';
  /**
   * Legacy flag: allowExternalSource
   * - When true: Maps to 'creative'
   * - When false: Maps to 'strict'
   */
  allowExternalSource?: boolean;
  /** Task complexity category: 'basic' (speed/concise) or 'complex' (reasoning/structure) */
  taskCategory?: 'basic' | 'complex';
  /** Stop sequences to halt generation early (anti-fluff / prevent rambling summaries) */
  stop?: string[];
  stopSequences?: string[];
  /**
   * When true (e.g. for Teacher manual testing), only executes the specified model.
   * If it fails, errors are immediately thrown without falling back to cascade.
   */
  strictModel?: boolean;
}

export interface GenerateTextStreamOptions extends GenerateTextOptions {
  onDelta: (delta: string) => void;
  onMeta?: (meta: { modelName: string; modelId: string; provider: AIProvider }) => void;
}

export interface GenerateTextResult {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groundingMetadata?: any;
  modelId?: string;
  provider?: AIProvider;
  modelName?: string;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error' | string;
}

// ---------------------------------------------------------------------------
// Daily Quota Circuit Breaker
// ---------------------------------------------------------------------------

// Tracks timestamp (ms) until which a provider is blocked due to quota/credit exhaustion
const providerBlockedUntil = new Map<AIProvider, number>();
const lastProviderErrors = new Map<string, string>();

export function setLastProviderError(provider: string, message: string): void {
  lastProviderErrors.set(provider, message);
}

export function getLastProviderError(provider: string): string {
  return lastProviderErrors.get(provider) || '';
}

function getNextDayMidnight(): number {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

export function isProviderBlocked(provider: AIProvider): boolean {
  if (provider === 'gemini') {
    if (!isAllGeminiKeysBlocked()) {
      return false;
    }
  }
  if (provider === 'groq') {
    if (!isAllGroqKeysBlocked()) {
      return false;
    }
  }
  const unblockTime = providerBlockedUntil.get(provider);
  if (!unblockTime) return false;
  if (Date.now() >= unblockTime) {
    providerBlockedUntil.delete(provider);
    return false;
  }
  return true;
}

export function unblockProvider(provider: AIProvider) {
  providerBlockedUntil.delete(provider);
}

export function blockProviderUntilTomorrow(provider: AIProvider, reason?: string) {
  const str = (reason || '').toLowerCase();
  const isCreditZero = str.includes('credit balance') || str.includes('credit is too low') || str.includes('plans & billing');

  let unblockTime: number;
  if (isCreditZero) {
    unblockTime = getNextDayMidnight();
  } else if (provider === 'gemini') {
    // Only block gemini if all keys in the pool are exhausted
    if (!isAllGeminiKeysBlocked()) {
      return;
    }
    const earliest = getGeminiEarliestUnblockTime();
    unblockTime = Math.max(earliest, Date.now() + 30000);
  } else {
    // Groq, Cohere, and standard rate limits are 60s windows
    unblockTime = Date.now() + 60 * 1000;
  }

  providerBlockedUntil.set(provider, unblockTime);
  const resetStr = new Date(unblockTime).toLocaleTimeString();
  console.warn(`[AI Circuit Breaker] Provider "${provider}" reached limit (${reason || '429 / Rate limit'}). Pausing "${provider}" until ${resetStr}.`);
}

export function isQuotaExhaustedError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { status?: number })?.status;
  // HTTP 413 is Payload/Request Too Large (e.g., prompt exceeds TPM or request size)
  // This is a payload issue, not an account quota exhaustion. Do NOT block the provider.
  if (status === 413) return false;

  const str = String(err).toLowerCase();
  const msg = (err as { message?: string })?.message?.toLowerCase() || '';
  const code = String((err as { code?: string | number })?.code || '').toLowerCase();

  // If the error specifically mentions "request too large" or "please reduce your message size", it's a payload size issue
  if (str.includes('request too large') || msg.includes('request too large') || str.includes('reduce your message size') || msg.includes('reduce your message size')) {
    return false;
  }

  if (status === 429) return true;
  if (code.includes('insufficient_quota') || code.includes('credit_balance') || code.includes('resource_exhausted')) return true;

  const quotaKeywords = [
    'credit balance',
    'insufficient_quota',
    'resource_exhausted',
    'rate limit',
    'rate_limit',
    'quota',
    'too many requests',
    '429',
    'credit is too low',
    'credits remaining',
    'billing',
  ];

  return quotaKeywords.some(kw => str.includes(kw) || msg.includes(kw));
}

// ---------------------------------------------------------------------------
// Available Models
// ---------------------------------------------------------------------------

export function getAvailableModels(allowExternalSource?: boolean): ModelOption[] {
  const env = runtimeEnv();
  const models: ModelOption[] = [];

  // Gemini - check pool availability
  const activeGeminiSlots = getAvailableKeySlots();
  const geminiAvailable = activeGeminiSlots.length > 0 && !isProviderBlocked('gemini');
  const geminiModels = [GEMINI_MODEL, ...GEMINI_BACKUP_MODELS];
  const geminiLabels: Record<string, string> = {
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (Preview)',
  };
  const geminiOptions: ModelOption[] = geminiModels.map(m => ({
    id: `gemini:${m}`,
    provider: 'gemini',
    modelId: m,
    label: geminiLabels[m] || m,
    available: geminiAvailable,
  }));

  // Anthropic
  const anthropicKey = env.ANTHROPIC_API_KEY || '';
  const anthropicAvailable = !!anthropicKey && !anthropicKey.startsWith('sk-ant-your') && !isProviderBlocked('anthropic');
  const anthropicOptions: ModelOption[] = ANTHROPIC_MODELS.map(m => ({
    id: `anthropic:${m.id}`,
    provider: 'anthropic',
    modelId: m.id,
    label: m.label,
    available: anthropicAvailable,
  }));

  // Groq
  const groqKey = env.GROQ_API_KEY || '';
  const groqAvailable = !!groqKey && !groqKey.startsWith('gsk_your') && !isProviderBlocked('groq');
  const groqModels = [GROQ_MODEL, ...GROQ_BACKUP_MODELS];
  const groqLabels: Record<string, string> = {
    'openai/gpt-oss-120b': 'Groq GPT-OSS 120B',
    'qwen/qwen3.8-27b': 'Groq Qwen 3.8 27B',
  };
  const groqOptions: ModelOption[] = groqModels.map(m => ({
    id: `groq:${m}`,
    provider: 'groq',
    modelId: m,
    label: groqLabels[m] || m,
    available: groqAvailable,
  }));

  // Cohere
  const cohereAvailable = isCohereAvailable() && !isProviderBlocked('cohere');
  const cohereModels = [COHERE_MODEL, ...COHERE_BACKUP_MODELS];
  const cohereLabels: Record<string, string> = {
    'command-r-08-2024': 'Cohere Command R',
    'command-r-plus-08-2024': 'Cohere Command R+',
  };
  const cohereOptions: ModelOption[] = cohereModels.map(m => ({
    id: `cohere:${m}`,
    provider: 'cohere',
    modelId: m,
    label: cohereLabels[m] || m,
    available: cohereAvailable,
  }));

  // OpenRouter
  const openRouterAvailable = isOpenRouterAvailable() && !isProviderBlocked('openrouter');
  const openRouterModels = [OPENROUTER_MODEL, ...OPENROUTER_BACKUP_MODELS];
  const openRouterLabels: Record<string, string> = {
    'qwen/qwen3.8-27b:free': 'OpenRouter Qwen 3.8 27B (Free)',
    'nvidia/nemotron-3.5-lightning:free': 'OpenRouter Nemotron 3.5 (Free)',
    'liquid/lfm-2.5-2.6b:free': 'OpenRouter LFM 2.5 2.6B (Free)',
    'google/gemma-4-31b-it:free': 'OpenRouter Gemma 4 31B (Free)',
    'meta-llama/llama-3.1-8b-instruct:free': 'OpenRouter Qwen 3.8 27B (Free)',
  };
  const openRouterOptions: ModelOption[] = openRouterModels.map(m => ({
    id: `openrouter:${m}`,
    provider: 'openrouter',
    modelId: m,
    label: openRouterLabels[m] || `OpenRouter ${m.split('/').pop()?.replace(':free', '') || m}`,
    available: openRouterAvailable,
  }));

  // Cloudflare Workers AI
  const cfAvailable = isCloudflareAvailable() && !isProviderBlocked('cloudflare');
  const cfModels = [CLOUDFLARE_DEFAULT_MODEL, ...CLOUDFLARE_BACKUP_MODELS];
  const cfLabels: Record<string, string> = {
    '@cf/meta/llama-3.1-8b-instruct': 'Cloudflare Llama 3.1 8B (Free / Edge)',
    '@cf/meta/llama-3-8b-instruct': 'Cloudflare Llama 3 8B (Free / Edge)',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 'Cloudflare Llama 3.3 70B Fast (Edge)',
    '@cf/qwen/qwen1.5-14b-chat-awq': 'Cloudflare Qwen 14B (Edge)',
  };
  const cfOptions: ModelOption[] = cfModels.map(m => ({
    id: `cloudflare:${m}`,
    provider: 'cloudflare',
    modelId: m,
    label: cfLabels[m] || `Cloudflare ${m.split('/').pop() || m}`,
    available: cfAvailable,
  }));

  // APMIX
  const apmixAvailable = isApmixAvailable() && !isProviderBlocked('apmix');
  const apmixModels = [APMIX_DEFAULT_MODEL, ...APMIX_BACKUP_MODELS];
  const apmixLabels: Record<string, string> = {
    'claude-sonnet-4-6-free': 'APMIX Claude Sonnet 4.6 (Free)',
    'gpt-6-luna-free': 'APMIX GPT-6 Luna (Free - Mở 09/10)',
  };
  const apmixOptions: ModelOption[] = apmixModels.map(m => ({
    id: `apmix:${m}`,
    provider: 'apmix',
    modelId: m,
    label: apmixLabels[m] || `APMIX ${m}`,
    available: apmixAvailable,
  }));

  if (allowExternalSource) {
    // ⚔️ External ON: Gemini -> OpenRouter -> APMIX -> Groq -> Cloudflare -> Cohere
    models.push(...geminiOptions, ...openRouterOptions, ...apmixOptions, ...groqOptions, ...cfOptions, ...cohereOptions);
  } else {
    // 🛡️ External OFF: Cohere -> Groq -> Cloudflare -> APMIX -> Gemini -> OpenRouter
    models.push(...cohereOptions, ...groqOptions, ...cfOptions, ...apmixOptions, ...geminiOptions, ...openRouterOptions);
  }

  // if (anthropicAvailable) {
  //   models.push(...anthropicOptions);
  // }

  return models;
}

// ---------------------------------------------------------------------------
// Unified Generate Text
// ---------------------------------------------------------------------------

/**
 * Parse a model selector string like "anthropic:claude-3-5-sonnet" into provider and modelId.
 * Returns null for 'auto' or invalid formats.
 */
export function parseModelSelector(selector?: string): { provider: AIProvider; modelId: string } | null {
  if (!selector || selector === 'auto') return null;
  if (selector.startsWith('@cf/')) {
    return { provider: 'cloudflare', modelId: selector };
  }
  const idx = selector.indexOf(':');
  if (idx <= 0) return null;
  const provider = selector.slice(0, idx) as AIProvider;
  let modelId = selector.slice(idx + 1);
  if (!['cohere', 'gemini', 'groq', 'anthropic', 'datacurso', 'cache', 'openrouter', 'cloudflare', 'apmix'].includes(provider) || !modelId) return null;
  // Transparent migration for legacy OpenRouter model slugs that are no longer free
  if (provider === 'openrouter' && (modelId.includes('llama-3.1-8b') || modelId.includes('llama-3.3-70b') || modelId.includes('gemini-2.0-flash-exp'))) {
    modelId = OPENROUTER_MODEL;
  }
  return { provider, modelId };
}

/** Call a specific provider with the given model. */
export function getModelDisplayName(provider: AIProvider | string, modelId?: string): string {
  if (provider === 'cohere') {
    if (modelId?.includes('plus')) return 'Cohere Command R+ (RAG)';
    return 'Cohere Command R (RAG)';
  }
  if (provider === 'groq') {
    if (modelId?.includes('120b') || modelId?.includes('gpt-oss')) return 'Groq GPT-OSS 120B';
    if (modelId?.includes('qwen')) return 'Groq Qwen 27B';
    return 'Groq LPU';
  }
  if (provider === 'cloudflare') {
    if (modelId?.includes('70b')) return 'Cloudflare Llama 3.3 70B Fast (Edge)';
    if (modelId?.includes('llama-3-8b')) return 'Cloudflare Llama 3 8B (Edge)';
    if (modelId?.includes('qwen')) return 'Cloudflare Qwen 14B (Edge)';
    return 'Cloudflare Llama 3.1 8B (Free / Edge)';
  }
  if (provider === 'gemini') {
    if (modelId?.includes('pro')) return 'Gemini 3.1 Pro (Preview)';
    return 'Gemini 3.8 Flash';
  }
  if (provider === 'openrouter') {
    if (modelId?.includes('qwen')) return 'OpenRouter Qwen 3.8 27B (Free)';
    if (modelId?.includes('nemotron')) return 'OpenRouter Nemotron 3.5 (Free)';
    if (modelId?.includes('gemma')) return 'OpenRouter Gemma 4 31B (Free)';
    if (modelId?.includes('liquid') || modelId?.includes('lfm')) return 'OpenRouter LFM 2.5 (Free)';
    return `OpenRouter (${modelId?.split('/').pop()?.replace(':free', '') || modelId})`;
  }
  if (provider === 'apmix') {
    if (modelId?.includes('claude-sonnet')) return 'APMIX Claude Sonnet 4.6 (Free)';
    if (modelId?.includes('gpt-6-luna')) return 'APMIX GPT-6 Luna (Free - Mở 09/10)';
    return 'APMIX Claude Sonnet 4.6 (Free)';
  }
  if (provider === 'anthropic') {
    if (modelId?.includes('haiku')) return 'Claude 3.5 Haiku';
    return 'Claude 3.5 Sonnet';
  }
  if (provider === 'cache') {
    return 'Bộ nhớ đệm (0 token)';
  }
  if (provider === 'datacurso') {
    // Backward compatibility for legacy requests: map to real underlying model
    return 'Groq GPT-OSS 120B';
  }
  return String(modelId || provider);
}

async function callProvider(
  provider: AIProvider,
  modelId: string,
  opts: GenerateTextOptions
): Promise<GenerateTextResult | null> {
  opts.signal?.throwIfAborted();
  if (isProviderBlocked(provider)) {
    return null;
  }
  let res: GenerateTextResult | null = null;
  switch (provider) {
    case 'cohere':
      res = await callCohere(modelId, opts);
      break;
    case 'gemini':
      res = await callGemini(modelId, opts);
      break;
    case 'groq':
      res = await callGroq(modelId, opts);
      break;
    case 'cloudflare':
      res = await callCloudflareAI(modelId, opts);
      break;
    case 'openrouter':
      res = await callOpenRouter(modelId, opts);
      break;
    case 'apmix':
      res = await callApmix(modelId, opts);
      break;
    case 'anthropic':
      res = await callAnthropic(modelId, opts);
      break;
    case 'datacurso': {
      res = await callGroq(GROQ_MODEL, opts);
      if (!res?.text && GROQ_BACKUP_MODELS[0]) {
        res = await callGroq(GROQ_BACKUP_MODELS[0], opts);
      }
      if (!res?.text) {
        res = await callGemini(GEMINI_MODEL, opts);
      }
      break;
    }
    default:
      return null;
  }
  if (res && res.text) {
    return {
      ...res,
      provider,
      modelId,
      modelName: getModelDisplayName(provider, modelId),
    };
  }
  return res;
}

/**
 * Trạm kiểm soát & Phân loại mục tiêu (Auto Task Classifier):
 * 1. Mục tiêu Thí chốt & Tầm trung ('basic'):
 *    - Định nghĩa nhanh, câu hỏi đóng, Flashcard, trắc nghiệm, tóm tắt cơ bản (< 4.000 tokens).
 *    - Đẩy cho Groq, Cloudflare AI (Edge), APMIX xử lý chớp nhoáng với chi phí gần bằng 0.
 * 2. Mục tiêu Chỉ huy ('complex'):
 *    - Đọc URL phức tạp, vẽ Mindmap, tổng hợp chuyên sâu toàn giáo trình (>= 4.000 tokens).
 *    - Rút pháo hạng nặng Gemini, OpenRouter nhờ context window khổng lồ và tư duy logic sâu.
 */
export function detectTaskCategory(opts: GenerateTextOptions): 'basic' | 'complex' {
  if (opts.taskCategory) {
    return opts.taskCategory;
  }

  // 1. Kiểm tra URL trong prompt hoặc system
  const textToScan = `${opts.userPrompt || ''} ${opts.system || ''}`;
  if (/https?:\/\/[^\s]+/i.test(textToScan)) {
    return 'complex';
  }

  // 2. Kiểm tra từ khóa yêu cầu tư duy cấu trúc / Mindmap / phân tích chuyên sâu
  const lower = textToScan.toLowerCase();
  const complexKeywords = [
    'mindmap',
    'sơ đồ tư duy',
    'bản đồ tư duy',
    'toàn bộ khóa học',
    'tổng hợp giáo trình',
    'chuyên sâu',
    'phân tích chuyên sâu',
    'phân tích đa chiều',
    'in-depth',
    'comprehensive',
  ];
  if (complexKeywords.some((kw) => lower.includes(kw))) {
    return 'complex';
  }

  // 3. Ước tính tổng dung lượng token đầu vào (prompt + system + history + docs)
  let totalChars = (opts.system?.length || 0) + (opts.userPrompt?.length || 0);
  if (opts.history && opts.history.length > 0) {
    for (const h of opts.history) {
      totalChars += (h.content?.length || 0);
    }
  }
  if (opts.documents && opts.documents.length > 0) {
    for (const d of opts.documents) {
      totalChars += (d.text?.length || 0) + (d.title?.length || 0);
    }
  }

  const estimatedTokens = Math.round(totalChars / 3.5);
  if (estimatedTokens >= 4000) {
    return 'complex';
  }

  return 'basic';
}

/**
 * Chỉ thị Tiếp ứng Dòng chảy (Stream Fallback Continuation Prompt):
 * Kích hoạt khi mô hình đang nhả chữ bị sập (lỗi 429 rate-limit, 500, crash mạng)
 * nhằm tiếp nối mạch văn đang viết dở mà không làm đứt trải nghiệm của sinh viên.
 */
export function buildContinuationPrompt(originalPrompt: string, accumulatedText: string): string {
  const preview =
    accumulatedText.length > 4000
      ? '...\n' + accumulatedText.slice(-4000)
      : accumulatedText;

  return `${originalPrompt}

[CHỈ THỊ TIẾP ỨNG DÒNG CHẢY - STREAM CONTINUATION]
Bạn đang tiếp ứng câu trả lời cho người dùng vì hệ thống trước đó bị gián đoạn đường truyền mạng giữa chừng.
Dưới đây là phần văn bản ĐÃ XUẤT RA CHO NGƯỜI DÙNG:
---
${preview}
---

NHIỆM VỤ BẮT BUỘC:
HÃY TIẾP TỤC viết phần còn lại từ đúng điểm bị gián đoạn một cách hoàn toàn tự nhiên và liền mạch.
1. TUYỆT ĐỐI KHÔNG lặp lại bất kỳ câu chữ, ý tứ hay đoạn văn nào đã xuất hiện ở trên.
2. Bắt đầu trả lời ngay lập tức bằng các từ tiếp theo để ghép nối trực tiếp vào đoạn văn trên.
3. Không thêm lời xin lỗi, không giải thích sự cố, không thêm bất kỳ tiêu đề/tiền tố nào như "Tiếp tục:", "Đoạn tiếp theo:".`;
}

/**
 * Phân bổ đội hình AI theo Ma trận 2 chiều (2D Routing Matrix):
 * Trục dọc: Mức độ phức tạp của tác vụ (Thí chốt & Tầm trung: 'basic' vs Chỉ huy: 'complex')
 * Trục ngang: Chế độ RAG (Strict, Hybrid, Creative)
 */
export function getCascadeLineup(
  modeOrExternal?: 'strict' | 'hybrid' | 'creative' | boolean,
  taskCategory: 'basic' | 'complex' = 'complex'
): Array<{ provider: AIProvider; models: string[] }> {
  let mode: 'strict' | 'hybrid' | 'creative' = 'hybrid';
  if (typeof modeOrExternal === 'string') {
    mode = modeOrExternal;
  } else if (typeof modeOrExternal === 'boolean') {
    mode = modeOrExternal ? 'creative' : 'hybrid';
  }

  const isLunaUnlocked = Date.now() >= new Date('2026-10-09T17:00:00+07:00').getTime();

  // =========================================================================
  // TRẬN ĐỊA 1: "Thí Chốt" & "Tầm Trung" (taskCategory === 'basic')
  // Đặc điểm: Slide Cơ bản/Tiêu chuẩn, Flashcard, Quiz, hỏi đáp thuật ngữ ngắn (<4.000 tokens).
  // =========================================================================
  if (taskCategory === 'basic') {
    if (mode === 'strict') {
      // Strict RAG (Temp = 0.0): Groq -> Cloudflare (Edge) -> APMIX -> OpenRouter -> Cohere -> Gemini
      return [
        { provider: 'groq', models: [GROQ_MODEL, ...GROQ_BACKUP_MODELS] },
        { provider: 'cloudflare', models: [CLOUDFLARE_DEFAULT_MODEL, ...CLOUDFLARE_BACKUP_MODELS] },
        { provider: 'apmix', models: [APMIX_DEFAULT_MODEL, ...APMIX_BACKUP_MODELS] },
        { provider: 'openrouter', models: [OPENROUTER_MODEL, ...OPENROUTER_BACKUP_MODELS] },
        { provider: 'cohere', models: [COHERE_MODEL, ...COHERE_BACKUP_MODELS] },
        { provider: 'gemini', models: [GEMINI_MODEL, ...GEMINI_BACKUP_MODELS] },
      ];
    }

    // Hybrid & Creative: Groq -> APMIX (chia lửa token suy luận) -> Cloudflare -> OpenRouter -> Gemini -> Cohere
    return [
      { provider: 'groq', models: [GROQ_MODEL, ...GROQ_BACKUP_MODELS] },
      { provider: 'apmix', models: [APMIX_DEFAULT_MODEL, ...APMIX_BACKUP_MODELS] },
      { provider: 'cloudflare', models: [CLOUDFLARE_DEFAULT_MODEL, ...CLOUDFLARE_BACKUP_MODELS] },
      { provider: 'openrouter', models: [OPENROUTER_MODEL, ...OPENROUTER_BACKUP_MODELS] },
      { provider: 'gemini', models: [GEMINI_MODEL, ...GEMINI_BACKUP_MODELS] },
      { provider: 'cohere', models: [COHERE_MODEL, ...COHERE_BACKUP_MODELS] },
    ];
  }

  // =========================================================================
  // TRẬN ĐỊA 2: "Chỉ Huy" (taskCategory === 'complex')
  // Đặc điểm: Slide Chuyên sâu, Mindmap cấu trúc lớn, URL, tổng hợp toàn khóa học (>=4.000 tokens).
  // =========================================================================
  if (isLunaUnlocked) {
    // Kế hoạch sau 17:00 09/10/2026: gpt-6-luna-free mở khóa -> APMIX đứng tuyến đầu ngang hàng Gemini
    return [
      { provider: 'gemini', models: [GEMINI_MODEL, ...GEMINI_BACKUP_MODELS] },
      { provider: 'apmix', models: [APMIX_DEFAULT_MODEL, ...APMIX_BACKUP_MODELS] },
      { provider: 'openrouter', models: [OPENROUTER_MODEL, ...OPENROUTER_BACKUP_MODELS] },
      { provider: 'cloudflare', models: [CLOUDFLARE_DEFAULT_MODEL, ...CLOUDFLARE_BACKUP_MODELS] },
      { provider: 'groq', models: [GROQ_MODEL, ...GROQ_BACKUP_MODELS] },
      { provider: 'cohere', models: [COHERE_MODEL, ...COHERE_BACKUP_MODELS] },
    ];
  }

  // Hiện tại: Gemini (Context window khổng lồ) -> OpenRouter -> APMIX -> Cloudflare -> Groq -> Cohere
  return [
    { provider: 'gemini', models: [GEMINI_MODEL, ...GEMINI_BACKUP_MODELS] },
    { provider: 'openrouter', models: [OPENROUTER_MODEL, ...OPENROUTER_BACKUP_MODELS] },
    { provider: 'apmix', models: [APMIX_DEFAULT_MODEL, ...APMIX_BACKUP_MODELS] },
    { provider: 'cloudflare', models: [CLOUDFLARE_DEFAULT_MODEL, ...CLOUDFLARE_BACKUP_MODELS] },
    { provider: 'groq', models: [GROQ_MODEL, ...GROQ_BACKUP_MODELS] },
    { provider: 'cohere', models: [COHERE_MODEL, ...COHERE_BACKUP_MODELS] },
  ];
}

/**
 * Generate text using a specific model or auto-fallback cascade.
 */
export async function generateText(
  modelSelector: string | undefined,
  opts: GenerateTextOptions
): Promise<GenerateTextResult> {
  const parsed = parseModelSelector(modelSelector);
  const effectiveCategory = opts.taskCategory || detectTaskCategory(opts);
  const langDirective = buildUniversalLanguageDirective(opts.userPrompt);
  const enrichedSystem = opts.system
    ? `${opts.system}\n\n${langDirective}`
    : langDirective;
  const effectiveOpts: GenerateTextOptions = {
    ...opts,
    system: enrichedSystem,
    taskCategory: effectiveCategory,
  };

  // If a specific model is selected
  if (parsed) {
    // Mode kiểm thử thủ công của giảng viên: Bắt 1 mình nó làm việc, báo lỗi công khai không cascade
    if (opts.strictModel) {
      if (isProviderBlocked(parsed.provider)) {
        throw new Error(`Provider "${parsed.provider}" hiện đang tạm khóa hoặc đạt giới hạn hạn mức (Circuit Breaker active).`);
      }
      const strictRes = await callProvider(parsed.provider, parsed.modelId, effectiveOpts);
      if (!strictRes || !strictRes.text) {
        const detail = getLastProviderError(parsed.provider);
        throw new Error(
          detail
            ? `Model ${parsed.provider}:${parsed.modelId} không trả về kết quả.\nChi tiết lỗi từ máy chủ API: ${detail}`
            : `Model ${parsed.provider}:${parsed.modelId} không trả về kết quả.`
        );
      }
      return strictRes;
    }

    if (!isProviderBlocked(parsed.provider)) {
      try {
        const result = await callProvider(parsed.provider, parsed.modelId, effectiveOpts);
        if (result?.text) return result;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (isQuotaExhaustedError(err)) {
          blockProviderUntilTomorrow(parsed.provider, String(err));
        }
        console.warn(`Selected model ${modelSelector} failed:`, err);
      }
      // If the selected model fails, still try auto-fallback
      console.warn(`Selected model ${modelSelector} failed, falling back to auto cascade`);
    }
  }

  const effectiveRagMode = opts.ragMode || (opts.allowExternalSource || opts.googleSearchGrounding ? 'creative' : 'hybrid');
  const cascadeProviders = getCascadeLineup(effectiveRagMode, effectiveCategory);

  for (const { provider, models } of cascadeProviders) {
    opts.signal?.throwIfAborted();
    if (provider === 'cohere' && !isCohereAvailable()) {
      continue;
    }
    if (provider === 'openrouter' && !isOpenRouterAvailable()) {
      continue;
    }
    if (provider === 'groq' && !getGroqClient()) {
      continue;
    }
    if (provider === 'cloudflare' && !isCloudflareAvailable()) {
      continue;
    }
    if (provider === 'apmix' && !isApmixAvailable()) {
      continue;
    }
    if (isProviderBlocked(provider)) {
      continue;
    }
    for (const modelId of models) {
      try {
        opts.signal?.throwIfAborted();
        const result = await callProvider(provider, modelId, effectiveOpts);
        if (result?.text) return result;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (isQuotaExhaustedError(err)) {
          blockProviderUntilTomorrow(provider, String(err));
          break;
        }
        console.warn(`Auto cascade: ${provider}:${modelId} failed:`, err);
      }
    }
  }

  return { text: '' };
}

/**
 * Stream text generation token by token.
 * Calls onDelta for each received chunk, and returns the accumulated result.
 */
export async function generateTextStream(
  modelSelector: string | undefined,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult> {
  const parsed = parseModelSelector(modelSelector);
  const effectiveCategory = opts.taskCategory || detectTaskCategory(opts);
  const langDirective = buildUniversalLanguageDirective(opts.userPrompt);
  const enrichedSystem = opts.system
    ? `${opts.system}\n\n${langDirective}`
    : langDirective;
  const effectiveOpts: GenerateTextStreamOptions = {
    ...opts,
    system: enrichedSystem,
    taskCategory: effectiveCategory,
  };

  let accumulatedText = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastGroundingMetadata: any = null;
  let activeProvider: AIProvider | undefined = undefined;
  let activeModelId: string | undefined = undefined;
  let activeModelName: string | undefined = undefined;
  let activeFinishReason: string | undefined = undefined;

  const wrappedOnDelta = (delta: string) => {
    if (delta) {
      accumulatedText += delta;
      opts.onDelta(delta);
    }
  };

  // If a specific model is selected
  if (parsed) {
    // Mode kiểm thử thủ công của giảng viên: Bắt 1 mình nó làm việc, báo lỗi công khai không cascade
    if (opts.strictModel) {
      if (isProviderBlocked(parsed.provider)) {
        throw new Error(`Provider "${parsed.provider}" hiện đang tạm khóa hoặc đạt giới hạn hạn mức (Circuit Breaker active).`);
      }
      const strictRes = await callProviderStream(parsed.provider, parsed.modelId, {
        ...effectiveOpts,
        onDelta: wrappedOnDelta,
        onMeta: opts.onMeta,
      });
      if (!strictRes || !strictRes.text) {
        const detail = getLastProviderError(parsed.provider);
        throw new Error(
          detail
            ? `Model ${parsed.provider}:${parsed.modelId} không trả về dữ liệu stream.\nChi tiết lỗi từ máy chủ API: ${detail}`
            : `Model ${parsed.provider}:${parsed.modelId} không trả về dữ liệu stream.`
        );
      }
      return {
        ...strictRes,
        text: accumulatedText || strictRes.text,
      };
    }

    if (!isProviderBlocked(parsed.provider)) {
      try {
        const result = await callProviderStream(parsed.provider, parsed.modelId, {
          ...effectiveOpts,
          onDelta: wrappedOnDelta,
          onMeta: (meta) => {
            activeProvider = meta.provider;
            activeModelId = meta.modelId;
            activeModelName = meta.modelName;
            opts.onMeta?.(meta);
          },
        });
        if (result?.text) {
          return {
            ...result,
            text: accumulatedText || result.text,
            provider: result.provider || parsed.provider,
            modelId: result.modelId || parsed.modelId,
            modelName: result.modelName || getModelDisplayName(parsed.provider, parsed.modelId),
            finishReason: result.finishReason || 'stop',
          };
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (isQuotaExhaustedError(err)) {
          blockProviderUntilTomorrow(parsed.provider, String(err));
        }
        console.warn(`Selected stream model ${modelSelector} failed (streamed ${accumulatedText.length} chars so far):`, err);
      }
      console.warn(`Selected stream model ${modelSelector} failed, falling back to auto stream cascade`);
    }
  }

  const effectiveRagMode = opts.ragMode || (opts.allowExternalSource || opts.googleSearchGrounding ? 'creative' : 'hybrid');
  const cascadeProviders = getCascadeLineup(effectiveRagMode, effectiveCategory);

  for (const { provider, models } of cascadeProviders) {
    opts.signal?.throwIfAborted();
    if (provider === 'cohere' && !isCohereAvailable()) {
      continue;
    }
    if (provider === 'openrouter' && !isOpenRouterAvailable()) {
      continue;
    }
    if (provider === 'groq' && !getGroqClient()) {
      continue;
    }
    if (provider === 'cloudflare' && !isCloudflareAvailable()) {
      continue;
    }
    if (provider === 'apmix' && !isApmixAvailable()) {
      continue;
    }
    if (isProviderBlocked(provider)) {
      continue;
    }
    for (const modelId of models) {
      try {
        opts.signal?.throwIfAborted();

        // Cơ chế Tiếp ứng dòng chảy: nếu mô hình trước đó đã kịp nhả chữ rồi gặp sự cố,
        // truyền lệnh cho mô hình kế tiếp viết tiếp từ đúng điểm bị gián đoạn, chống lặp chữ và gián đoạn màn hình
        const isContinuing = accumulatedText.trim().length > 0 && !opts.jsonMode;
        const currentPrompt = isContinuing
          ? buildContinuationPrompt(opts.userPrompt, accumulatedText)
          : opts.userPrompt;

        const currentOpts: GenerateTextStreamOptions = {
          ...effectiveOpts,
          userPrompt: currentPrompt,
          onDelta: wrappedOnDelta,
          onMeta: (meta) => {
            activeProvider = meta.provider;
            activeModelId = meta.modelId;
            activeModelName = meta.modelName;
            opts.onMeta?.(meta);
          },
        };

        const result = await callProviderStream(provider, modelId, currentOpts);
        if (result?.text || accumulatedText.trim().length > 0) {
          if (result?.groundingMetadata) lastGroundingMetadata = result.groundingMetadata;
          if (result?.finishReason) activeFinishReason = result.finishReason;

          return {
            text: accumulatedText || result?.text || '',
            groundingMetadata: lastGroundingMetadata,
            provider: result?.provider || provider,
            modelId: result?.modelId || modelId,
            modelName: result?.modelName || getModelDisplayName(provider, modelId),
            finishReason: activeFinishReason || result?.finishReason || 'stop',
          };
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (isQuotaExhaustedError(err)) {
          blockProviderUntilTomorrow(provider, String(err));
          break;
        }
        console.warn(`Auto stream cascade: ${provider}:${modelId} failed (streamed ${accumulatedText.length} chars so far):`, err);
      }
    }
  }

  // Fallback sang non-streaming nếu mọi luồng stream đều lỗi
  try {
    const isContinuing = accumulatedText.trim().length > 0 && !opts.jsonMode;
    const fallbackPrompt = isContinuing
      ? buildContinuationPrompt(opts.userPrompt, accumulatedText)
      : opts.userPrompt;

    const fallbackOpts: GenerateTextOptions = {
      ...effectiveOpts,
      userPrompt: fallbackPrompt,
    };

    const fallback = await generateText(modelSelector, fallbackOpts);
    if (fallback.text) {
      opts.onDelta(fallback.text);
      accumulatedText += fallback.text;
    }
    return {
      text: accumulatedText || fallback.text || '',
      groundingMetadata: fallback.groundingMetadata || lastGroundingMetadata,
      provider: fallback.provider || activeProvider,
      modelId: fallback.modelId || activeModelId,
      modelName: fallback.modelName || activeModelName,
      finishReason: fallback.finishReason || activeFinishReason || 'stop',
    };
  } catch (fallbackErr) {
    if (accumulatedText.trim().length > 0) {
      // Dù fallback thất bại hoàn toàn, bảo toàn đoạn văn bản đã xuất ra cho học viên
      return {
        text: accumulatedText,
        groundingMetadata: lastGroundingMetadata,
        provider: activeProvider,
        modelId: activeModelId,
        modelName: activeModelName,
        finishReason: 'error',
      };
    }
    throw fallbackErr;
  }
}

/** Call a specific provider with streaming */
async function callProviderStream(
  provider: AIProvider,
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  opts.signal?.throwIfAborted();
  if (isProviderBlocked(provider)) {
    return null;
  }
  let metaSent = false;
  const wrappedOpts: GenerateTextStreamOptions = {
    ...opts,
    onDelta: (delta: string) => {
      if (!metaSent) {
        metaSent = true;
        opts.onMeta?.({
          modelName: getModelDisplayName(provider, modelId),
          modelId,
          provider,
        });
      }
      opts.onDelta(delta);
    },
  };

  let res: GenerateTextResult | null = null;
  switch (provider) {
    case 'cohere':
      res = await callCohereStream(modelId, wrappedOpts);
      break;
    case 'gemini':
      res = await callGeminiStream(modelId, wrappedOpts);
      break;
    case 'groq':
      res = await callGroqStream(modelId, wrappedOpts);
      break;
    case 'cloudflare':
      res = await callCloudflareAIStream(modelId, wrappedOpts);
      break;
    case 'openrouter':
      res = await callOpenRouterStream(modelId, wrappedOpts);
      break;
    case 'apmix':
      res = await callApmixStream(modelId, wrappedOpts);
      break;
    case 'anthropic':
      res = await callAnthropicStream(modelId, wrappedOpts);
      break;
    case 'datacurso': {
      res = await callGroqStream(GROQ_MODEL, wrappedOpts);
      if (!res?.text && GROQ_BACKUP_MODELS[0]) {
        res = await callGroqStream(GROQ_BACKUP_MODELS[0], wrappedOpts);
      }
      if (!res?.text) {
        res = await callGeminiStream(GEMINI_MODEL, wrappedOpts);
      }
      break;
    }
    default:
      return null;
  }
  if (res && res.text) {
    return {
      ...res,
      provider,
      modelId,
      modelName: getModelDisplayName(provider, modelId),
    };
  }
  return res;
}

// ---------------------------------------------------------------------------
// Provider-specific call implementations
// ---------------------------------------------------------------------------

async function callGemini(modelId: string, opts: GenerateTextOptions): Promise<GenerateTextResult | null> {
  try {
    const formattedContents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    if (opts.history && opts.history.length > 0) {
      let lastRole: string | null = null;
      for (const msg of opts.history) {
        const role = msg.role === 'user' ? 'user' : 'model';
        if (formattedContents.length === 0 && role !== 'user') continue;
        if (role === lastRole) {
          formattedContents[formattedContents.length - 1].parts.push({ text: msg.content });
        } else {
          formattedContents.push({ role, parts: [{ text: msg.content }] });
          lastRole = role;
        }
      }
    }
    formattedContents.push({ role: 'user', parts: [{ text: opts.userPrompt }] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = {
      systemInstruction: opts.system,
      temperature: opts.temperature ?? 0.1,
    };

    if (opts.topP !== undefined) {
      config.topP = opts.topP === 0 ? 0.001 : opts.topP;
    }

    if (opts.maxTokens !== undefined) {
      config.maxOutputTokens = opts.maxTokens;
    }

    if (opts.jsonMode) {
      config.responseMimeType = 'application/json';
    }

    if (opts.googleSearchGrounding) {
      config.tools = [{ googleSearch: {} }];
    }

    const stopSequences = (opts.stopSequences || opts.stop)?.slice(0, 5);
    if (stopSequences && stopSequences.length > 0) {
      config.stopSequences = stopSequences;
    }

    return await executeWithGeminiPool(async (client) => {
      let response;
      try {
        response = await client.models.generateContent({
          model: modelId,
          contents: formattedContents,
          config,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (firstErr: any) {
        if (firstErr?.status === 503 || String(firstErr).includes('503')) {
          await new Promise(r => setTimeout(r, 1200));
          opts.signal?.throwIfAborted();
          response = await client.models.generateContent({
            model: modelId,
            contents: formattedContents,
            config,
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
        } else {
          throw firstErr;
        }
      }

      const text = (response.text || '').trim();
      if (!text) return null;

      const candidate = (response as any).candidates?.[0];
      const rawReason = candidate?.finishReason;
      let finishReason: string | undefined = undefined;
      if (rawReason === 'MAX_TOKENS') finishReason = 'length';
      else if (rawReason === 'STOP') finishReason = 'stop';
      else if (rawReason) finishReason = String(rawReason).toLowerCase();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const groundingMetadata = candidate?.groundingMetadata || null;
      return { text, groundingMetadata, finishReason };
    }, opts.signal);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('gemini', String(err));
    }
    console.warn(`callGemini (${modelId}) failed:`, err);
    return null;
  }
}

async function callAnthropic(modelId: string, opts: GenerateTextOptions): Promise<GenerateTextResult | null> {
  const client = getAnthropicClient();
  if (!client) {
    console.warn('Anthropic client not available (check key)');
    return null;
  }

  try {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (opts.history) {
      for (const msg of opts.history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // For JSON mode, instruct Anthropic via system prompt suffix
    let systemPrompt = opts.system;
    if (opts.jsonMode) {
      systemPrompt += '\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no extra text.';
    }

    messages.push({ role: 'user', content: opts.userPrompt });

    const anthropicParams: any = {
      model: modelId,
      max_tokens: opts.maxTokens ?? 8192,
      system: systemPrompt,
      messages,
      temperature: opts.temperature ?? 0.1,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    if (opts.topP !== undefined) {
      anthropicParams.top_p = opts.topP;
    }

    const stopSequences = (opts.stopSequences || opts.stop)?.slice(0, 4);
    if (stopSequences && stopSequences.length > 0) {
      anthropicParams.stop_sequences = stopSequences;
    }

    const response = await client.messages.create(anthropicParams);

    const textBlocks = response.content.filter(b => b.type === 'text');
    const text = textBlocks.map(b => (b as { type: 'text'; text: string }).text).join('').trim();
    if (!text) return null;

    return { text, finishReason: (response as any)?.stop_reason === 'max_tokens' ? 'length' : 'stop' };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('anthropic', String(err));
    }
    console.warn(`callAnthropic (${modelId}) failed:`, err);
    return null;
  }
}

function prepareGroqMessages(
  system: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  userPrompt: string
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  // Groq TPM limit on on-demand tier for openai/gpt-oss-120b is 8000 tokens (~24,000 chars)
  // We keep total characters strictly under 20,000 chars (~5,000 tokens) to guarantee safety.
  let remainingChars = 20000;

  // 1. System prompt (bounded)
  const safeSystem = system.length > 4000 ? system.slice(0, 4000) + '...' : system;
  remainingChars -= safeSystem.length;

  // 2. User prompt (bounded)
  let safeUserPrompt = userPrompt;
  if (safeUserPrompt.length > 12000) {
    safeUserPrompt = safeUserPrompt.slice(0, 12000) + '\n[...Nội dung tài liệu đã được tóm lược để vừa hạn mức xử lý LPU...]';
  }
  remainingChars -= safeUserPrompt.length;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: safeSystem },
  ];

  // 3. History (reverse fill until remainingChars exhausted)
  if (history && history.length > 0) {
    const keptHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (remainingChars - msg.content.length < 500) {
        break; // stop including older conversation turns
      }
      remainingChars -= msg.content.length;
      keptHistory.unshift(msg);
    }
    messages.push(...keptHistory);
  }

  messages.push({ role: 'user', content: safeUserPrompt });
  return messages;
}

async function callGroq(modelId: string, opts: GenerateTextOptions): Promise<GenerateTextResult | null> {
  try {
    opts.signal?.throwIfAborted();
    const messages = prepareGroqMessages(opts.system, opts.history, opts.userPrompt);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createOpts: any = {
      model: modelId,
      messages,
      temperature: opts.temperature ?? 0.1,
    };

    if (opts.topP !== undefined) {
      createOpts.top_p = opts.topP === 0 ? 0.001 : opts.topP;
    }

    if (opts.maxTokens !== undefined) {
      createOpts.max_tokens = opts.maxTokens;
    }

    if (opts.jsonMode) {
      createOpts.response_format = { type: 'json_object' };
    }

    const stopSequences = (opts.stop || opts.stopSequences)?.slice(0, 4);
    if (stopSequences && stopSequences.length > 0) {
      createOpts.stop = stopSequences;
    }

    let finishReason: string | undefined = undefined;
    const text = await executeWithGroqPool(async (client) => {
      opts.signal?.throwIfAborted();
      const completion = await client.chat.completions.create(createOpts);
      finishReason = completion.choices[0]?.finish_reason || undefined;
      return completion.choices[0]?.message?.content?.trim() || '';
    }, opts.signal);

    if (!text) return null;
    return { text, finishReason };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    setLastProviderError('groq', errMsg);
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('groq', errMsg);
    }
    console.warn(`callGroq (${modelId}) failed:`, err);
    return null;
  }
}

async function callGroqStream(modelId: string, opts: GenerateTextStreamOptions): Promise<GenerateTextResult | null> {
  try {
    opts.signal?.throwIfAborted();
    const messages = prepareGroqMessages(opts.system, opts.history, opts.userPrompt);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createOpts: any = {
      model: modelId,
      messages,
      temperature: opts.temperature ?? 0.1,
      stream: true,
    };

    if (opts.topP !== undefined) {
      createOpts.top_p = opts.topP;
    }

    if (opts.maxTokens !== undefined) {
      createOpts.max_tokens = opts.maxTokens;
    }

    if (opts.jsonMode) {
      createOpts.response_format = { type: 'json_object' };
    }

    const stopStreamSequences = (opts.stop || opts.stopSequences)?.slice(0, 4);
    if (stopStreamSequences && stopStreamSequences.length > 0) {
      createOpts.stop = stopStreamSequences;
    }

    let finishReason: string | undefined = undefined;
    const fullText = await executeWithGroqPool(async (client) => {
      opts.signal?.throwIfAborted();
      const stream = await client.chat.completions.create(createOpts);
      let streamAccumulated = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const chunk of stream as any) {
        opts.signal?.throwIfAborted();
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          streamAccumulated += delta;
          opts.onDelta(delta);
        }
        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }
      return streamAccumulated.trim();
    }, opts.signal);

    if (!fullText) return null;
    return { text: fullText, finishReason };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    setLastProviderError('groq', errMsg);
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('groq', errMsg);
    }
    console.warn(`callGroqStream (${modelId}) failed:`, err);
    return null;
  }
}

async function callGeminiStream(modelId: string, opts: GenerateTextStreamOptions): Promise<GenerateTextResult | null> {
  try {
    const formattedContents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    if (opts.history && opts.history.length > 0) {
      let lastRole: string | null = null;
      for (const msg of opts.history) {
        const role = msg.role === 'user' ? 'user' : 'model';
        if (formattedContents.length === 0 && role !== 'user') continue;
        if (role === lastRole) {
          formattedContents[formattedContents.length - 1].parts.push({ text: msg.content });
        } else {
          formattedContents.push({ role, parts: [{ text: msg.content }] });
          lastRole = role;
        }
      }
    }
    formattedContents.push({ role: 'user', parts: [{ text: opts.userPrompt }] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = {
      systemInstruction: opts.system,
      temperature: opts.temperature ?? 0.1,
    };

    if (opts.topP !== undefined) {
      config.topP = opts.topP === 0 ? 0.001 : opts.topP;
    }

    if (opts.maxTokens !== undefined) {
      config.maxOutputTokens = opts.maxTokens;
    }

    if (opts.jsonMode) {
      config.responseMimeType = 'application/json';
    }

    if (opts.googleSearchGrounding) {
      config.tools = [{ googleSearch: {} }];
    }

    const stopSequences = (opts.stopSequences || opts.stop)?.slice(0, 5);
    if (stopSequences && stopSequences.length > 0) {
      config.stopSequences = stopSequences;
    }

    return await executeWithGeminiPool(async (client) => {
      const responseStream = await client.models.generateContentStream({
        model: modelId,
        contents: formattedContents,
        config,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      let fullText = '';
      let finishReason: string | undefined = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let groundingMetadata: any = null;
      for await (const chunk of responseStream) {
        opts.signal?.throwIfAborted();
        const text = chunk.text || '';
        if (text) {
          fullText += text;
          opts.onDelta(text);
        }
        const cand = (chunk as any).candidates?.[0];
        if (cand?.finishReason) {
          const rawReason = cand.finishReason;
          if (rawReason === 'MAX_TOKENS') finishReason = 'length';
          else if (rawReason === 'STOP') finishReason = 'stop';
          else finishReason = String(rawReason).toLowerCase();
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((chunk as any).candidates?.[0]?.groundingMetadata) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          groundingMetadata = (chunk as any).candidates[0].groundingMetadata;
        }
      }

      const trimmed = fullText.trim();
      if (!trimmed) return null;
      return { text: trimmed, groundingMetadata, finishReason };
    }, opts.signal);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('gemini', String(err));
    }
    console.warn(`callGeminiStream (${modelId}) failed:`, err);
    return null;
  }
}

async function callAnthropicStream(modelId: string, opts: GenerateTextStreamOptions): Promise<GenerateTextResult | null> {
  const client = getAnthropicClient();
  if (!client) {
    console.warn('Anthropic client not available (check key)');
    return null;
  }

  try {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (opts.history) {
      for (const msg of opts.history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    let systemPrompt = opts.system;
    if (opts.jsonMode) {
      systemPrompt += '\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no extra text.';
    }

    messages.push({ role: 'user', content: opts.userPrompt });

    const stopStreamSequences = (opts.stopSequences || opts.stop)?.slice(0, 4);
    const stream = client.messages.stream({
      model: modelId,
      max_tokens: opts.maxTokens ?? 8192,
      system: systemPrompt,
      messages,
      temperature: opts.temperature ?? 0.1,
      ...(stopStreamSequences && stopStreamSequences.length > 0 ? { stop_sequences: stopStreamSequences } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    let fullText = '';
    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (chunk.type === 'content_block_delta' && (chunk.delta as any).type === 'text_delta') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delta = (chunk.delta as any).text || '';
        if (delta) {
          fullText += delta;
          opts.onDelta(delta);
        }
      }
    }

    const trimmed = fullText.trim();
    if (!trimmed) return null;
    return { text: trimmed };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (isQuotaExhaustedError(err)) {
      blockProviderUntilTomorrow('anthropic', String(err));
    }
    console.warn(`callAnthropicStream (${modelId}) failed:`, err);
    return null;
  }
}
