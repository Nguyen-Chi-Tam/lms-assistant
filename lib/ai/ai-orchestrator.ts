import { getLatestUserApiKey, type ByokProvider, type LatestByokKey } from '@/lib/security/key-manager';

export type TaskWeight = 'checkin' | 'light' | 'heavy' | 'playable';
export type RagRoutingMode = 'strict' | 'hybrid' | 'creative';
export type SystemPoolProvider = 'groq' | 'gemini' | 'cloudflare' | 'openrouter' | 'orcarouter';

export interface ExecutionTarget {
  source: 'byok_latest' | 'puter_client' | 'system_pool';
  provider?: ByokProvider;
  apiKey?: string;
  modelId?: string;
  fallbackChain: SystemPoolProvider[];
}

/**
 * Maps legacy registry taskCategory values to unified orchestrator task weights.
 */
export function mapTaskCategoryToWeight(
  taskCategory?: 'basic' | 'complex' | 'quick' | 'playable'
): TaskWeight {
  if (taskCategory === 'quick') return 'checkin';
  if (taskCategory === 'playable') return 'playable';
  if (taskCategory === 'complex') return 'heavy';
  return 'light';
}

/**
 * Returns the pruned System Free lineup (max 4 healthy portals per workload tier).
 * Experimental/unstable providers (Pollinations, AionLabs, Airforce, Cohere) are
 * excluded from auto-routing and kept strictly for manual instructor testing.
 */
export function getPrunedSystemChain(
  taskWeight: TaskWeight,
  ragMode: RagRoutingMode
): SystemPoolProvider[] {
  if (taskWeight === 'checkin') {
    return ['groq', 'cloudflare'];
  }
  if (taskWeight === 'light') {
    return ragMode === 'strict'
      ? ['orcarouter', 'gemini', 'groq', 'cloudflare']
      : ['groq', 'gemini', 'cloudflare', 'openrouter'];
  }
  // heavy & playable
  return ['orcarouter', 'gemini', 'groq', 'openrouter'];
}

/**
 * 1. Retrieves only the single latest BYOK key for a user.
 * Uses the in-memory TTL cache in key-manager.ts (backed by Drizzle/Supabase ORDER BY created_at DESC).
 */
export async function getLatestByokKey(userId: number | undefined | null): Promise<LatestByokKey | null> {
  return getLatestUserApiKey(userId);
}

/**
 * 2. Resolves the single optimal execution target by workload weight, BYOK presence,
 * Puter.js client session, and Circuit Breaker health.
 */
export async function resolveExecutionTarget(params: {
  userId?: number | null;
  taskWeight: TaskWeight;
  ragMode: RagRoutingMode;
  hasPuterSession?: boolean;
  isProviderHealthy: (provider: SystemPoolProvider) => boolean;
  preloadedByok?: LatestByokKey | null;
}): Promise<ExecutionTarget> {
  const latestByok =
    params.preloadedByok !== undefined
      ? params.preloadedByok
      : await getLatestByokKey(params.userId);

  // Pruned System Free chain (max 4 strongest portals)
  const rawSystemChain = getPrunedSystemChain(params.taskWeight, params.ragMode);

  // Immediately skip providers currently penalized by the 5-minute Circuit Breaker (0ms)
  const healthySystemChain = rawSystemChain.filter(params.isProviderHealthy);
  // Keep raw chain as last-resort if every single portal is simultaneously tripped
  const fallbackChain = healthySystemChain.length > 0 ? healthySystemChain : rawSystemChain;

  // Priority 1: Playable Minigames -> Puter.js client-side 1-pass (when user has no BYOK)
  if (params.taskWeight === 'playable' && params.hasPuterSession && !latestByok) {
    return { source: 'puter_client', fallbackChain };
  }

  // Priority 2: Single latest BYOK key -> straight to provider; on failure, drop straight to System Pool
  if (latestByok) {
    return {
      source: 'byok_latest',
      provider: latestByok.provider,
      apiKey: latestByok.apiKey,
      fallbackChain,
    };
  }

  // Priority 3: Heavy tasks -> Puter.js client-side when user has no BYOK
  if (params.taskWeight === 'heavy' && params.hasPuterSession) {
    return { source: 'puter_client', fallbackChain };
  }

  // Default: Pruned System Free Pool
  return { source: 'system_pool', fallbackChain };
}
