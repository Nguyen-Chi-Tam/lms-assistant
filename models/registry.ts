import { runtimeEnv } from '@/db/runtime';
import {
  executeWithGeminiPool,
  isAllGeminiKeysBlocked,
  getGeminiEarliestUnblockTime,
  hasGeminiConfiguredKeys,
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
  normalizeOpenRouterModel,
} from './openrouter';
import {
  isCloudflareAvailable,
  callCloudflareAI,
  callCloudflareAIStream,
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_BACKUP_MODELS,
} from './cloudflare';
import {
  isAirforceAvailable,
  callAirforce,
  callAirforceStream,
  AIRFORCE_DEFAULT_MODEL,
  AIRFORCE_BACKUP_MODELS,
} from './airforce';
import {
  isOrcaRouterAvailable,
  callOrcaRouter,
  callOrcaRouterStream,
  ORCAROUTER_DEFAULT_MODEL,
  ORCAROUTER_BACKUP_MODELS,
} from './orcarouter';
import {
  isPollinationsAvailable,
  callPollinations,
  callPollinationsStream,
  POLLINATIONS_DEFAULT_MODEL,
} from './pollinations';
import {
  isAionlabsAvailable,
  callAionlabs,
  callAionlabsStream,
} from './aionlabs';
import { buildUniversalLanguageDirective } from '@/lib/ai/language-detector';
import { getUserApiKeys, getLatestUserApiKey, type ByokProvider } from '@/lib/security/key-manager';
import { getPrunedSystemChain, mapTaskCategoryToWeight } from '@/lib/ai/ai-orchestrator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AIProvider = 'cohere' | 'gemini' | 'groq' | 'anthropic' | 'datacurso' | 'cache' | 'openrouter' | 'cloudflare' | 'airforce' | 'orcarouter' | 'pollinations' | 'aionlabs';

export interface ModelOption {
  /** Format: "provider:modelId" */
  id: string;
  provider: AIProvider;
  modelId: string;
  label: string;
  available: boolean;
  /** Whether this manual option deliberately uses the system pool or BYOK pool. */
  keyMode?: 'system' | 'byok';
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
  /**
   * Task routing tier:
   * - 'quick': Cấp 1 — 3 câu check-in, chỉ dùng cổng phản hồi nhanh (Groq Pool → Cloudflare → Airforce).
   * - 'basic': Cấp 2 — tác vụ < 4.000 tokens (flashcard, quiz, tóm tắt ngắn).
   * - 'complex': Cấp 3 — tác vụ > 4.000 tokens (URL dài, mindmap, RAG toàn khóa học).
   * - 'playable': Cấp 4 — minigames, ưu tiên JSON lồng nhau chuẩn xác.
   */
  taskCategory?: 'basic' | 'complex' | 'quick' | 'playable';
  /** Giới hạn provider trong auto-cascade (vd. Slide cấm Cloudflare/Airforce/Cohere). */
  allowedProviders?: AIProvider[];
  /** Ép Groq dùng model cụ thể (vd. llama-3.3-70b-versatile cho Slide/Mindmap). */
  groqModel?: string;
  /** Stop sequences to halt generation early (anti-fluff / prevent rambling summaries) */
  stop?: string[];
  stopSequences?: string[];
  /**
   * When true (e.g. for Teacher manual testing), only executes the specified model.
   * If it fails, errors are immediately thrown without falling back to cascade.
   */
  strictModel?: boolean;
  /** BYOK: User identifier for retrieving personalized keys */
  userId?: number;
  /** BYOK: Pre-resolved or custom user API keys prioritized over system keys */
  userApiKeys?: {
    gemini?: string[];
    groq?: string[];
    openrouter?: string[];
  };
  /** Ngôn ngữ do người dùng yêu cầu. Chỉ nên lấy từ câu hỏi thật, KHÔNG lấy từ ngữ cảnh RAG. */
  languageHint?: string;
  /** Force a provider to use only system keys or only the caller's BYOK keys. */
  keyMode?: 'system' | 'byok';
  /** Internal callback used to expose the key source that actually completed a request. */
  onKeySource?: (source: 'system' | 'byok') => void;
}

export interface GenerateTextStreamOptions extends GenerateTextOptions {
  onDelta: (delta: string) => void;
  onMeta?: (meta: { modelName: string; modelId: string; provider: AIProvider; keySource?: 'system' | 'byok' }) => void;
}

export interface GenerateTextResult {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groundingMetadata?: any;
  modelId?: string;
  provider?: AIProvider;
  modelName?: string;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error' | string;
  keySource?: 'system' | 'byok';
}

type CascadeRoute = {
  provider: AIProvider;
  models: string[];
  keyMode?: 'system' | 'byok';
};

// Providers that support user BYOK keys. When a single model is selected,
// only that provider's user keys are loaded — other providers' BYOK keys are
// never fetched or initialized.
const BYOK_PROVIDERS: AIProvider[] = ['gemini', 'groq', 'openrouter'];
function isByokProvider(provider: AIProvider): provider is ByokProvider {
  return BYOK_PROVIDERS.includes(provider as ByokProvider);
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

const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute RAM circuit breaker
const TTFT_TIMEOUT_MS = 4_000; // 4-second Time-To-First-Token ceiling for auto-cascade

export function blockProviderUntilTomorrow(provider: AIProvider, reason?: string) {
  const str = (reason || '').toLowerCase();
  const isCreditZero = str.includes('credit balance') || str.includes('credit is too low') || str.includes('plans & billing');

  let unblockTime: number;
  if (isCreditZero) {
    unblockTime = getNextDayMidnight();
  } else if (provider === 'gemini') {
    // Only block gemini if all keys in the pool are exhausted or on 5xx/timeout circuit trip
    const isTransientCircuitTrip =
      str.includes('ttft') || str.includes('timeout') || /\b5\d{2}\b/.test(str);
    if (!isTransientCircuitTrip && !isAllGeminiKeysBlocked()) {
      return;
    }
    const earliest = getGeminiEarliestUnblockTime();
    unblockTime = Math.max(earliest, Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS);
  } else {
    // 5-minute Circuit Breaker window for 429 / 5xx / timeout
    unblockTime = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
  }

  providerBlockedUntil.set(provider, unblockTime);
  const resetStr = new Date(unblockTime).toLocaleTimeString();
  console.warn(`[AI Circuit Breaker] Provider "${provider}" tripped (${reason || '429 / 5xx / timeout'}). Skipping for 5m until ${resetStr}.`);
}

export function isCircuitBreakerError(err: unknown): boolean {
  if (!err) return false;
  if (isQuotaExhaustedError(err)) return true;
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number' && status >= 500 && status <= 526) return true;
  const name = (err as { name?: string })?.name || '';
  const msg = String((err as { message?: string })?.message || err).toLowerCase();
  if (name === 'TimeoutError' || msg.includes('ttft_timeout') || msg.includes('timed out') || msg.includes('timeout')) {
    return true;
  }
  return /\b(500|502|503|504|520|522|524)\b/.test(msg);
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

  if (status === 429 || status === 402) return true;
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
    '402',
    'credit is too low',
    'credits remaining',
    'remaining credits',
    'no remaining credits',
    'purchase pre-paid credits',
    'billing',
  ];

  return quotaKeywords.some(kw => str.includes(kw) || msg.includes(kw));
}

// ---------------------------------------------------------------------------
// Available Models
// ---------------------------------------------------------------------------

export function getAvailableModels(
  allowExternalSource?: boolean,
  userKeys?: { gemini?: string[]; groq?: string[]; openrouter?: string[] }
): ModelOption[] {
  const env = runtimeEnv();
  const models: ModelOption[] = [];
  const splitKeyModes = (options: ModelOption[], systemAvailable: boolean, hasByok: boolean): ModelOption[] => [
    ...options.map(option => ({
      ...option,
      id: `${option.id}#system`,
      label: `${option.label} — Hệ thống`,
      available: systemAvailable,
      keyMode: 'system' as const,
    })),
    ...(hasByok
      ? options.map(option => ({
          ...option,
          id: `${option.id}#byok`,
          label: `${option.label} — BYOK`,
          available: true,
          keyMode: 'byok' as const,
        }))
      : []),
  ];

  // Gemini - check pool availability or user BYOK keys
  // Use a non-initializing presence check so Gemini's system pool (and its
  // terminal log) is not touched just to populate the model list before a
  // user picks a model.
  const hasUserGemini = Boolean(userKeys?.gemini && userKeys.gemini.length > 0);
  const geminiSystemAvailable = hasGeminiConfiguredKeys();
  const geminiModels = [GEMINI_MODEL, ...GEMINI_BACKUP_MODELS];
  const geminiLabels: Record<string, string> = {
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (Preview)',
  };
  const geminiOptions = splitKeyModes(geminiModels.map(m => ({
    id: `gemini:${m}`,
    provider: 'gemini',
    modelId: m,
    label: geminiLabels[m] || m,
    available: geminiSystemAvailable,
  })), geminiSystemAvailable, hasUserGemini);

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
  const groqKey = env.GROQ_API_KEYS || env.GROQ_API_KEY || '';
  const hasUserGroq = Boolean(userKeys?.groq && userKeys.groq.length > 0);
  const groqSystemAvailable = !!groqKey && !groqKey.startsWith('gsk_your') && !isProviderBlocked('groq');
  const groqModels = [GROQ_MODEL, ...GROQ_BACKUP_MODELS];
  const groqLabels: Record<string, string> = {
    'openai/gpt-oss-120b': 'Groq GPT-OSS 120B',
    'qwen/qwen3.8-27b': 'Groq Qwen 3.8 27B',
  };
  const groqOptions = splitKeyModes(groqModels.map(m => ({
    id: `groq:${m}`,
    provider: 'groq',
    modelId: m,
    label: groqLabels[m] || m,
    available: groqSystemAvailable,
  })), groqSystemAvailable, hasUserGroq);

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
  const hasUserOpenRouter = Boolean(userKeys?.openrouter && userKeys.openrouter.length > 0);
  const openRouterSystemAvailable = isOpenRouterAvailable() && !isProviderBlocked('openrouter');
  const openRouterModels = [OPENROUTER_MODEL, ...OPENROUTER_BACKUP_MODELS];
  const openRouterLabels: Record<string, string> = {
    'qwen/qwen3.8-27b:free': 'OpenRouter Qwen 3.8 27B (Free)',
    'qwen/qwen3.8-27b': 'OpenRouter Qwen 3.8 27B',
    'nvidia/nemotron-3.5-lightning:free': 'OpenRouter Nemotron 3.5 (Free)',
    'liquid/lfm-2.5-2.6b:free': 'OpenRouter LFM 2.5 2.6B (Free)',
    'google/gemma-4-31b-it:free': 'OpenRouter Gemma 4 31B (Free)',
    'meta-llama/llama-3.1-8b-instruct:free': 'OpenRouter Qwen 3.8 27B (Free)',
  };
  const openRouterOptions = splitKeyModes(openRouterModels.map(m => ({
    id: `openrouter:${m}`,
    provider: 'openrouter',
    modelId: m,
    label: openRouterLabels[m] || `OpenRouter ${m.split('/').pop()?.replace(':free', '') || m}`,
    available: openRouterSystemAvailable,
  })), openRouterSystemAvailable, hasUserOpenRouter);

  // Cloudflare Workers AI
  const cfAvailable = isCloudflareAvailable() && !isProviderBlocked('cloudflare');
  const cfModels = [CLOUDFLARE_DEFAULT_MODEL, ...CLOUDFLARE_BACKUP_MODELS];
  const cfLabels: Record<string, string> = {
    '@cf/zai-org/glm-4.7-flash': 'Cloudflare GLM 4.7 Flash (131K)',
    '@cf/aisingapore/gemma-sea-lion-v4-27b-it': 'Cloudflare SEA-LION 27B (ĐNÁ)',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 'Cloudflare Llama 3.3 70B Fast (Edge)',
    '@cf/qwen/qwen3.8-27b': 'Cloudflare Qwen 3.8 27B (Edge)',
  };
  const cfOptions: ModelOption[] = cfModels.map(m => ({
    id: `cloudflare:${m}`,
    provider: 'cloudflare',
    modelId: m,
    label: cfLabels[m] || `Cloudflare ${m.split('/').pop() || m}`,
    available: cfAvailable,
  }));

  const airforceAvailable = isAirforceAvailable() && !isProviderBlocked('airforce');
  const airforceModels = [AIRFORCE_DEFAULT_MODEL, ...AIRFORCE_BACKUP_MODELS];
  const airforceLabels: Record<string, string> = {
    'kimi-k2.7-code': 'Airforce Kimi K2.7 Code (Free)',
    'llama-instant': 'Airforce Llama Instant (Free)',
    'mistral-large-4': 'Airforce Mistral Large 4 (Free)',
  };
  const airforceOptions: ModelOption[] = airforceModels.map(modelId => ({
    id: `airforce:${modelId}`,
    provider: 'airforce',
    modelId,
    label: airforceLabels[modelId] || `API Airforce (${modelId})`,
    available: airforceAvailable,
  }));
  const orcaRouterAvailable = isOrcaRouterAvailable() && !isProviderBlocked('orcarouter');
  const orcaRouterModels = [ORCAROUTER_DEFAULT_MODEL, ...ORCAROUTER_BACKUP_MODELS];
  const orcaRouterLabels: Record<string, string> = {
    'deepseek/deepseek-v4-flash-free': 'OrcaRouter DeepSeek V4 Flash (Free)',
    'deepseek/deepseek-v4.1-flash-free': 'OrcaRouter DeepSeek V4.1 Flash (Free)',
    'z-ai/glm-5.3-flash-free': 'OrcaRouter GLM 5.3 Flash (Free)',
    'tencent/hy4-preview-free': 'OrcaRouter Tencent Hy4 Preview (Free)',
  };
  const orcaRouterOptions: ModelOption[] = orcaRouterModels.map(modelId => ({
    id: `orcarouter:${modelId}`,
    provider: 'orcarouter',
    modelId,
    label: orcaRouterLabels[modelId] || `OrcaRouter ${modelId}`,
    available: orcaRouterAvailable,
  }));
  const pollinationsAvailable = isPollinationsAvailable() && !isProviderBlocked('pollinations');
  const pollinationsModels = [POLLINATIONS_DEFAULT_MODEL];
  const pollinationsLabels: Record<string, string> = {
    'stealth/glyph-cluster': 'Pollinations Glyph Cluster (Free, Stealth)',
  };
  const pollinationsOptions: ModelOption[] = pollinationsModels.map(modelId => ({
    id: `pollinations:${modelId}`,
    provider: 'pollinations',
    modelId,
    label: pollinationsLabels[modelId] || `Pollinations ${modelId}`,
    available: pollinationsAvailable,
  }));

  // Aion Labs
  const aionlabsAvailable = isAionlabsAvailable() && !isProviderBlocked('aionlabs');
  const aionlabsModels = ['aion-2.0'];
  const aionlabsLabels: Record<string, string> = {
    'aion-2.0': 'Aion Labs 2.0',
  };
  const aionlabsOptions: ModelOption[] = aionlabsModels.map(modelId => ({
    id: `aionlabs:${modelId}`,
    provider: 'aionlabs',
    modelId,
    label: aionlabsLabels[modelId] || `AionLabs ${modelId}`,
    available: aionlabsAvailable,
  }));

  if (allowExternalSource) {
    // ⚔️ External ON: Gemini -> OpenRouter -> Groq -> Cloudflare -> Airforce -> OrcaRouter -> Pollinations -> Cohere -> Aion Labs
    models.push(...geminiOptions, ...openRouterOptions, ...groqOptions, ...cfOptions, ...airforceOptions, ...orcaRouterOptions, ...pollinationsOptions, ...cohereOptions, ...aionlabsOptions);
  } else {
    // 🛡️ External OFF: Cohere -> Groq -> Cloudflare -> Airforce -> OrcaRouter -> Pollinations -> Gemini -> OpenRouter -> Aion Labs
    models.push(...cohereOptions, ...groqOptions, ...cfOptions, ...airforceOptions, ...orcaRouterOptions, ...pollinationsOptions, ...geminiOptions, ...openRouterOptions, ...aionlabsOptions);
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
export function parseModelSelector(selector?: string): { provider: AIProvider; modelId: string; keyMode?: 'system' | 'byok' } | null {
  if (!selector || selector === 'auto') return null;
  if (selector.startsWith('@cf/')) {
    return { provider: 'cloudflare', modelId: selector };
  }
  const idx = selector.indexOf(':');
  if (idx <= 0) return null;
  const provider = selector.slice(0, idx) as AIProvider;
  let modelId = selector.slice(idx + 1);
  const modeMatch = modelId.match(/#(system|byok)$/);
  const keyMode = modeMatch?.[1] as 'system' | 'byok' | undefined;
  if (modeMatch) modelId = modelId.slice(0, -modeMatch[0].length);
  if (!['cohere', 'gemini', 'groq', 'anthropic', 'datacurso', 'cache', 'openrouter', 'cloudflare', 'airforce', 'orcarouter', 'pollinations', 'aionlabs'].includes(provider) || !modelId) return null;
  if (provider === 'openrouter') {
    const normalizedModelId = normalizeOpenRouterModel(modelId);
    if (normalizedModelId !== modelId) {
      modelId = normalizedModelId;
    }
  }
  // Transparent migration for legacy OpenRouter model slugs that are no longer free
  if (provider === 'openrouter' && (modelId.includes('llama-3.1-8b') || modelId.includes('llama-3.3-70b') || modelId.includes('gemini-2.0-flash-exp'))) {
    modelId = OPENROUTER_MODEL;
  }
  return { provider, modelId, keyMode };
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
    if (modelId?.includes('glm-4.7-flash')) return 'Cloudflare GLM 4.7 Flash (131K)';
    if (modelId?.includes('sea-lion')) return 'Cloudflare SEA-LION 27B (ĐNÁ)';
    if (modelId?.includes('70b')) return 'Cloudflare Llama 3.3 70B Fast (Edge)';
    if (modelId?.includes('qwen3.8')) return 'Cloudflare Qwen 3.8 27B (Edge)';
    return `Cloudflare (${modelId || CLOUDFLARE_DEFAULT_MODEL})`;
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
  if (provider === 'airforce') {
    return `API Airforce (${modelId || AIRFORCE_DEFAULT_MODEL})`;
  }
  if (provider === 'orcarouter') {
    return `OrcaRouter (${modelId || ORCAROUTER_DEFAULT_MODEL})`;
  }
  if (provider === 'pollinations') {
    if (modelId?.includes('glyph-cluster')) return 'Pollinations Glyph Cluster (Free, Stealth)';
    return `Pollinations (${modelId || POLLINATIONS_DEFAULT_MODEL})`;
  }
  if (provider === 'aionlabs') {
    return `AionLabs (${modelId || 'aion-2.0'})`;
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
  if (opts.keyMode !== 'byok' && isProviderBlocked(provider)) {
    return null;
  }
  let keySource: 'system' | 'byok' | undefined;
  const providerOpts: GenerateTextOptions = {
    ...opts,
    userApiKeys: opts.keyMode === 'system'
      ? { gemini: [], groq: [], openrouter: [] }
      : opts.userApiKeys,
    onKeySource: source => {
      keySource = source;
      opts.onKeySource?.(source);
    },
  };
  let res: GenerateTextResult | null = null;
  switch (provider) {
    case 'cohere':
      res = await callCohere(modelId, providerOpts);
      break;
    case 'gemini':
      res = await callGemini(modelId, providerOpts);
      break;
    case 'groq':
      res = await callGroq(modelId, providerOpts);
      break;
    case 'cloudflare':
      res = await callCloudflareAI(modelId, providerOpts);
      break;
    case 'openrouter':
      res = await callOpenRouter(modelId, providerOpts);
      break;
    case 'airforce':
      res = await callAirforce(modelId, providerOpts);
      break;
    case 'orcarouter':
      res = await callOrcaRouter(modelId, providerOpts);
      break;
    case 'pollinations':
      res = await callPollinations(modelId, providerOpts);
      break;
    case 'aionlabs':
      res = await callAionlabs(modelId, providerOpts);
      break;
    case 'anthropic':
      res = await callAnthropic(modelId, providerOpts);
      break;
    case 'datacurso': {
      res = await callGroq(GROQ_MODEL, providerOpts);
      if (!res?.text && GROQ_BACKUP_MODELS[0]) {
        res = await callGroq(GROQ_BACKUP_MODELS[0], providerOpts);
      }
      if (!res?.text) {
        res = await callGemini(GEMINI_MODEL, providerOpts);
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
      keySource,
    };
  }
  return res;
}

/**
 * Trạm kiểm soát & Phân loại mục tiêu (Auto Task Classifier):
 * 1. Mục tiêu Thí chốt & Tầm trung ('basic'):
 *    - Định nghĩa nhanh, câu hỏi đóng, Flashcard, trắc nghiệm, tóm tắt cơ bản (< 4.000 tokens).
 *    - Đẩy cho Cloudflare (Edge), Groq Pool, Airforce xử lý chớp nhoáng với chi phí gần bằng 0.
 * 2. Mục tiêu Chỉ huy ('complex'):
 *    - Đọc URL phức tạp, vẽ Mindmap, tổng hợp chuyên sâu toàn giáo trình (>= 4.000 tokens).
 *    - Rút pháo hạng nặng Gemini, OpenRouter nhờ context window khổng lồ và tư duy logic sâu.
 */
export function detectTaskCategory(opts: GenerateTextOptions): NonNullable<GenerateTextOptions['taskCategory']> {
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
  taskCategory: GenerateTextOptions['taskCategory'] = 'complex',
  userApiKeys?: GenerateTextOptions['userApiKeys'],
  allowedProviders?: AIProvider[],
  groqModel?: string
): CascadeRoute[] {
  let mode: 'strict' | 'hybrid' | 'creative' = 'hybrid';
  if (typeof modeOrExternal === 'string') {
    mode = modeOrExternal;
  } else if (typeof modeOrExternal === 'boolean') {
    mode = modeOrExternal ? 'creative' : 'hybrid';
  }

  // Quy ước cứng: 1 provider = 1 lần gọi = 1 model ID trong luồng tự động (không lặp backup models).
  const providerModels: Record<AIProvider, string[]> = {
    cohere: [COHERE_MODEL],
    gemini: [GEMINI_MODEL],
    // Cấp 3-4 / Heavy / Playable / Slide / Mindmap: dùng Llama 3.3 70B trên Groq.
    groq: groqModel
      ? [groqModel]
      : taskCategory === 'playable' || taskCategory === 'complex'
        ? ['llama-3.3-70b-versatile']
        : [GROQ_MODEL],
    anthropic: ANTHROPIC_MODELS.slice(0, 1).map(model => model.id),
    datacurso: [GROQ_MODEL],
    cache: [],
    openrouter: [OPENROUTER_MODEL],
    cloudflare: [CLOUDFLARE_DEFAULT_MODEL],
    airforce: [AIRFORCE_DEFAULT_MODEL],
    orcarouter: [ORCAROUTER_DEFAULT_MODEL],
    pollinations: [POLLINATIONS_DEFAULT_MODEL],
    aionlabs: ['aion-2.0'],
  };

  // Tuyến đầu: 1 Key BYOK mới nhất (chỉ lấy tối đa 1 provider BYOK có key, không xoay vòng nhiều provider cũ).
  const byokProviders: AIProvider[] = ['gemini', 'groq', 'openrouter'];
  const activeByokProvider = byokProviders.find(provider => {
    if (provider === 'gemini') return Boolean(userApiKeys?.gemini?.length);
    if (provider === 'groq') return Boolean(userApiKeys?.groq?.length);
    if (provider === 'openrouter') return Boolean(userApiKeys?.openrouter?.length);
    return false;
  });

  const byokRoutes: CascadeRoute[] = activeByokProvider
    ? [{ provider: activeByokProvider, models: providerModels[activeByokProvider], keyMode: 'byok' }]
    : [];

  // Đội hình System Free tinh gọn: tối đa 4 cổng khỏe nhất mỗi phân khúc tải.
  // Pollinations / AionLabs / Airforce / Cohere chỉ giữ lại cho chế độ kiểm thử thủ công của giảng viên.
  const taskWeight = mapTaskCategoryToWeight(taskCategory);
  const systemProviders: AIProvider[] = getPrunedSystemChain(taskWeight, mode);

  const systemRoutes: CascadeRoute[] = systemProviders.map(provider => ({
    provider,
    models: providerModels[provider],
    keyMode: 'system',
  }));

  const routes = [...byokRoutes, ...systemRoutes];
  return allowedProviders && allowedProviders.length > 0
    ? routes.filter(route => allowedProviders.includes(route.provider))
    : routes;
}

/**
 * Một số provider trả payload JSON rỗng/vo lẽ (vd. `{"questions":[]}` ~15 ký tự).
 * Nếu coi đó là thành công, cascade dừng ngay tại provider đầu tiên dù không có
 * dữ liệu — đoạn này đảm bảo output thực sự dùng được trước khi chấp nhận.
 */
function isUsableJsonOutput(text: string): boolean {
  const raw = text.trim();
  if (raw.length < 12) return false;
  // String(obj) từ provider có thể tạo ra literal này — không phải JSON.
  if (raw.includes('[object Object]')) return false;

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === 'object') {
      return Object.values(parsed).some((value) => {
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'string') return value.trim().length > 0;
        return value !== null && value !== undefined;
      });
    }
    return false;
  } catch {
    // JSON bị cụt vẫn có thể salvage ở tầng parse của caller; văn bản trần thì không.
    // "[object Object]" cũng bắt đầu bằng '[' nên phải chặn riêng ở trên.
    return /^[{[]/.test(cleaned) && !/^\[object\b/i.test(cleaned);
  }
}

function isAcceptableResult(
  result: GenerateTextResult | null,
  jsonMode: boolean
): boolean {
  if (!result?.text) return false;
  if (result.text.includes('[object Object]')) return false;
  if (!jsonMode) return true;
  return isUsableJsonOutput(result.text);
}

/**
 * Generate text using a specific model or auto-fallback cascade.
 */
export async function generateText(
  modelSelector: string | undefined,
  opts: GenerateTextOptions
): Promise<GenerateTextResult> {
  // Puter.js only exists in the browser, so it can never serve a server-side task.
  // In strict mode surface that instead of silently falling back to another model.
  if (opts.strictModel && modelSelector?.startsWith('puter:')) {
    throw new Error('Puter.js chỉ chạy trên trình duyệt nên không thể xử lý tác vụ này. Hãy chọn một model AI khác.');
  }

  const parsed = parseModelSelector(modelSelector);
  const effectiveCategory = opts.taskCategory || detectTaskCategory(opts);
  const langDirective = buildUniversalLanguageDirective(opts.languageHint ?? opts.userPrompt);
  const enrichedSystem = opts.system
    ? `${opts.system}\n\n${langDirective}`
    : langDirective;

  // BYOK: 1-Key BYOK Frontline Policy — in auto mode, load ONLY the single newest BYOK key.
  // When a specific model is selected manually, load only that provider's keys.
  let resolvedUserKeys = opts.userApiKeys;
  if (opts.userId && !resolvedUserKeys) {
    try {
      if (parsed && isByokProvider(parsed.provider)) {
        const keys = await getUserApiKeys(opts.userId, parsed.provider);
        resolvedUserKeys = { gemini: [], groq: [], openrouter: [], [parsed.provider]: keys };
      } else {
        const latestKey = await getLatestUserApiKey(opts.userId);
        resolvedUserKeys = latestKey
          ? { gemini: [], groq: [], openrouter: [], [latestKey.provider]: [latestKey.apiKey] }
          : { gemini: [], groq: [], openrouter: [] };
      }
    } catch (e) {
      console.warn('[BYOK Registry] Could not load user keys:', e);
    }
  }

  const effectiveOpts: GenerateTextOptions = {
    ...opts,
    system: enrichedSystem,
    taskCategory: effectiveCategory,
    userApiKeys: resolvedUserKeys,
    keyMode: parsed?.keyMode,
  };

  // If a specific model is selected
  if (parsed) {
    // Mode kiểm thử thủ công của giảng viên: Bắt 1 mình nó làm việc, báo lỗi công khai không cascade
    if (opts.strictModel) {
      if (effectiveOpts.keyMode !== 'byok' && isProviderBlocked(parsed.provider)) {
        throw new Error(`Provider "${parsed.provider}" hiện đang tạm khóa hoặc đạt giới hạn hạn mức (Circuit Breaker active). Chọn model khác hoặc thử lại sau.`);
      }
      const strictRes = await callProvider(parsed.provider, parsed.modelId, effectiveOpts);
      if (!strictRes || !isAcceptableResult(strictRes, effectiveOpts.jsonMode === true)) {
        const rawDetail = getLastProviderError(parsed.provider) || '';
        const safeDetail = rawDetail.replace(/</g, '<').replace(/>/g, '>');

        throw new Error(
          safeDetail
            ? `Model ${parsed.provider}:${parsed.modelId} không trả về kết quả.\nChi tiết lỗi từ máy chủ API: ${safeDetail}`
            : `Model ${parsed.provider}:${parsed.modelId} không trả về kết quả.`
        );
      }
      return strictRes;
    }

    if (!isProviderBlocked(parsed.provider)) {
      try {
        const result = await callProvider(parsed.provider, parsed.modelId, effectiveOpts);
        if (result && isAcceptableResult(result, effectiveOpts.jsonMode === true)) return result;
        if (result?.text) {
          console.warn(`[Registry] ${parsed.provider}:${parsed.modelId} trả output JSON không dùng được (${result.text.length} chars); thử provider kế tiếp.`);
        }
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
  const cascadeProviders = getCascadeLineup(
    effectiveRagMode,
    effectiveCategory,
    resolvedUserKeys,
    effectiveOpts.allowedProviders,
    effectiveOpts.groqModel
  );

  for (const route of cascadeProviders) {
    const { provider, models } = route;
    const routeOpts: GenerateTextOptions = { ...effectiveOpts, keyMode: route.keyMode };
    opts.signal?.throwIfAborted();
    if (provider === 'cohere' && !isCohereAvailable()) {
      continue;
    }
    if (provider === 'openrouter' && (route.keyMode === 'byok'
      ? !resolvedUserKeys?.openrouter?.length
      : !isOpenRouterAvailable())) {
      continue;
    }
    if (provider === 'groq' && (route.keyMode === 'byok'
      ? !resolvedUserKeys?.groq?.length
      : !getGroqClient())) {
      continue;
    }
    if (provider === 'cloudflare' && !isCloudflareAvailable()) {
      continue;
    }
    if (provider === 'airforce' && !isAirforceAvailable()) {
      continue;
    }
    if (provider === 'orcarouter' && !isOrcaRouterAvailable()) {
      continue;
    }
    if (provider === 'pollinations' && !isPollinationsAvailable()) {
      continue;
    }
    if (provider === 'aionlabs' && !isAionlabsAvailable()) {
      continue;
    }
    if (route.keyMode !== 'byok' && isProviderBlocked(provider)) {
      continue;
    }
    for (const modelId of models) {
      try {
        opts.signal?.throwIfAborted();
        const result = await callProvider(provider, modelId, routeOpts);
        if (result && isAcceptableResult(result, routeOpts.jsonMode === true)) return result;
        if (result?.text) {
          console.warn(`[Registry] ${provider}:${modelId} trả output JSON không dùng được (${result.text.length} chars); thử provider kế tiếp.`);
        }
        if (route.keyMode === 'byok') {
          break;
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (route.keyMode !== 'byok' && isCircuitBreakerError(err)) {
          blockProviderUntilTomorrow(provider, String(err));
          break;
        }
        if (route.keyMode === 'byok') {
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
  if (opts.strictModel && modelSelector?.startsWith('puter:')) {
    throw new Error('Puter.js chỉ chạy trên trình duyệt nên không thể xử lý tác vụ này. Hãy chọn một model AI khác.');
  }

  const parsed = parseModelSelector(modelSelector);
  const effectiveCategory = opts.taskCategory || detectTaskCategory(opts);
  const langDirective = buildUniversalLanguageDirective(opts.languageHint ?? opts.userPrompt);
  const enrichedSystem = opts.system
    ? `${opts.system}\n\n${langDirective}`
    : langDirective;

  // BYOK: 1-Key BYOK Frontline Policy — in auto mode, load ONLY the single newest BYOK key.
  // When a specific model is selected manually, load only that provider's keys.
  let resolvedUserKeys = opts.userApiKeys;
  if (opts.userId && !resolvedUserKeys) {
    try {
      if (parsed && isByokProvider(parsed.provider)) {
        const keys = await getUserApiKeys(opts.userId, parsed.provider);
        resolvedUserKeys = { gemini: [], groq: [], openrouter: [], [parsed.provider]: keys };
      } else {
        const latestKey = await getLatestUserApiKey(opts.userId);
        resolvedUserKeys = latestKey
          ? { gemini: [], groq: [], openrouter: [], [latestKey.provider]: [latestKey.apiKey] }
          : { gemini: [], groq: [], openrouter: [] };
      }
    } catch (e) {
      console.warn('[BYOK Registry] Could not load user keys for stream:', e);
    }
  }

  const effectiveOpts: GenerateTextStreamOptions = {
    ...opts,
    system: enrichedSystem,
    taskCategory: effectiveCategory,
    userApiKeys: resolvedUserKeys,
    keyMode: parsed?.keyMode,
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
      if (effectiveOpts.keyMode !== 'byok' && isProviderBlocked(parsed.provider)) {
        throw new Error(`Provider "${parsed.provider}" hiện đang tạm khóa hoặc đạt giới hạn hạn mức (Circuit Breaker active). Chọn model khác hoặc thử lại sau.`);
      }
      const strictRes = await callProviderStream(parsed.provider, parsed.modelId, {
        ...effectiveOpts,
        onDelta: wrappedOnDelta,
        onMeta: opts.onMeta,
      });
      if (!strictRes || !strictRes.text) {
        const rawDetail = getLastProviderError(parsed.provider) || '';
        const safeDetail = rawDetail.replace(/</g, '<').replace(/>/g, '>');

        throw new Error(
          safeDetail
            ? `Model ${parsed.provider}:${parsed.modelId} không trả về dữ liệu stream.\nChi tiết lỗi từ máy chủ API: ${safeDetail}`
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
  const cascadeProviders = getCascadeLineup(
    effectiveRagMode,
    effectiveCategory,
    resolvedUserKeys,
    effectiveOpts.allowedProviders,
    effectiveOpts.groqModel
  );

  for (const route of cascadeProviders) {
    const { provider, models } = route;
    const routeOpts: GenerateTextStreamOptions = { ...effectiveOpts, keyMode: route.keyMode };
    opts.signal?.throwIfAborted();
    if (provider === 'cohere' && !isCohereAvailable()) {
      continue;
    }
    if (provider === 'openrouter' && (route.keyMode === 'byok'
      ? !resolvedUserKeys?.openrouter?.length
      : !isOpenRouterAvailable())) {
      continue;
    }
    if (provider === 'groq' && (route.keyMode === 'byok'
      ? !resolvedUserKeys?.groq?.length
      : !getGroqClient())) {
      continue;
    }
    if (provider === 'cloudflare' && !isCloudflareAvailable()) {
      continue;
    }
    if (provider === 'airforce' && !isAirforceAvailable()) {
      continue;
    }
    if (provider === 'orcarouter' && !isOrcaRouterAvailable()) {
      continue;
    }
    if (provider === 'pollinations' && !isPollinationsAvailable()) {
      continue;
    }
    if (provider === 'aionlabs' && !isAionlabsAvailable()) {
      continue;
    }
    if (route.keyMode !== 'byok' && isProviderBlocked(provider)) {
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
          ...routeOpts,
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
            keySource: result?.keySource,
          };
        }
        if (route.keyMode === 'byok') {
          break;
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (route.keyMode !== 'byok' && isCircuitBreakerError(err)) {
          blockProviderUntilTomorrow(provider, String(err));
          break;
        }
        if (route.keyMode === 'byok') {
          break;
        }
        console.warn(`Auto stream cascade: ${provider}:${modelId} failed (streamed ${accumulatedText.length} chars so far):`, err);
      }
    }
  }

  // Bảo toàn nội dung đã stream được nếu tất cả cổng khỏe đều lỗi; không chạy lại vòng non-stream toàn tuyến gây nhân đôi độ trễ.
  if (accumulatedText.trim().length > 0) {
    return {
      text: accumulatedText,
      groundingMetadata: lastGroundingMetadata,
      provider: activeProvider,
      modelId: activeModelId,
      modelName: activeModelName,
      finishReason: activeFinishReason || 'error',
    };
  }

  return { text: '' };
}

/** Call a specific provider with streaming and a 4s TTFT ceiling in auto-cascade mode */
async function callProviderStream(
  provider: AIProvider,
  modelId: string,
  opts: GenerateTextStreamOptions
): Promise<GenerateTextResult | null> {
  opts.signal?.throwIfAborted();
  if (opts.keyMode !== 'byok' && isProviderBlocked(provider)) {
    return null;
  }
  let keySource: 'system' | 'byok' | undefined;
  let metaSent = false;
  let firstTokenReceived = false;
  let ttftTimedOut = false;

  // Enforce 4-second TTFT (Time-To-First-Token) limit for auto-cascade; cancel timer on first delta.
  const ttftController = !opts.strictModel ? new AbortController() : null;
  const ttftTimer = ttftController
    ? setTimeout(() => {
        if (!firstTokenReceived) {
          ttftTimedOut = true;
          ttftController.abort(new Error(`TTFT_TIMEOUT (${TTFT_TIMEOUT_MS}ms) on ${provider}:${modelId}`));
        }
      }, TTFT_TIMEOUT_MS)
    : null;

  const combinedSignal =
    ttftController && opts.signal
      ? AbortSignal.any([opts.signal, ttftController.signal])
      : ttftController
        ? ttftController.signal
        : opts.signal;

  const wrappedOpts: GenerateTextStreamOptions = {
    ...opts,
    signal: combinedSignal,
    userApiKeys: opts.keyMode === 'system'
      ? { gemini: [], groq: [], openrouter: [] }
      : opts.userApiKeys,
    onKeySource: source => {
      keySource = source;
      opts.onKeySource?.(source);
    },
    onDelta: (delta: string) => {
      if (!firstTokenReceived && delta) {
        firstTokenReceived = true;
        if (ttftTimer) clearTimeout(ttftTimer);
      }
      if (!metaSent) {
        metaSent = true;
        opts.onMeta?.({
          modelName: getModelDisplayName(provider, modelId),
          modelId,
          provider,
          keySource,
        });
      }
      opts.onDelta(delta);
    },
  };

  let res: GenerateTextResult | null = null;
  try {
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
      case 'airforce':
        res = await callAirforceStream(modelId, wrappedOpts);
        break;
      case 'orcarouter':
        res = await callOrcaRouterStream(modelId, wrappedOpts);
        break;
      case 'pollinations':
        res = await callPollinationsStream(modelId, wrappedOpts);
        break;
      case 'aionlabs':
        res = await callAionlabsStream(modelId, wrappedOpts);
        break;
      case 'anthropic':
        res = await callAnthropicStream(modelId, wrappedOpts);
        break;
      case 'datacurso': {
        res = await callGroqStream(GROQ_MODEL, wrappedOpts);
        break;
      }
      default:
        return null;
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (ttftTimedOut) {
      const reason = `TTFT_TIMEOUT (${TTFT_TIMEOUT_MS}ms)`;
      setLastProviderError(provider, reason);
      if (opts.keyMode !== 'byok') {
        blockProviderUntilTomorrow(provider, reason);
      }
      console.warn(`[AI TTFT Guard] ${provider}:${modelId} exceeded ${TTFT_TIMEOUT_MS}ms without first token; switching route.`);
      return null;
    }
    throw err;
  } finally {
    if (ttftTimer) clearTimeout(ttftTimer);
  }

  if (ttftTimedOut && !firstTokenReceived) {
    const reason = `TTFT_TIMEOUT (${TTFT_TIMEOUT_MS}ms)`;
    setLastProviderError(provider, reason);
    if (opts.keyMode !== 'byok') {
      blockProviderUntilTomorrow(provider, reason);
    }
    console.warn(`[AI TTFT Guard] ${provider}:${modelId} timed out before first token; switching route.`);
    return null;
  }

  if (res && res.text) {
    return {
      ...res,
      provider,
      modelId,
      modelName: getModelDisplayName(provider, modelId),
      keySource,
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

    const timeoutSignal = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);

    return await executeWithGeminiPool(async (client) => {
      // 1 provider = 1 call (no 1200ms 503 sleep retry)
      const response = await client.models.generateContent({
        model: modelId,
        contents: formattedContents,
        config,
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
      });

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
    }, { signal: timeoutSignal, userKeys: opts.userApiKeys?.gemini, allowSystemFallback: opts.keyMode !== 'byok', onKeySource: opts.onKeySource });
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
    }, { signal: opts.signal, userKeys: opts.userApiKeys?.groq, allowSystemFallback: opts.keyMode !== 'byok', onKeySource: opts.onKeySource });

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
    }, { signal: opts.signal, userKeys: opts.userApiKeys?.groq, allowSystemFallback: opts.keyMode !== 'byok', onKeySource: opts.onKeySource });

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

    const timeoutSignal = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);

    return await executeWithGeminiPool(async (client) => {
      const responseStream = await client.models.generateContentStream({
        model: modelId,
        contents: formattedContents,
        config,
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
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
    }, { signal: timeoutSignal, userKeys: opts.userApiKeys?.gemini, allowSystemFallback: opts.keyMode !== 'byok', onKeySource: opts.onKeySource });
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
