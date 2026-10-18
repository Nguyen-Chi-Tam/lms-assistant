import { GoogleGenAI } from '@google/genai';
import { runtimeEnv } from '@/db/runtime';

export interface GeminiKeySlot {
  index: number;
  key: string;
  maskedKey: string;
  client: GoogleGenAI;
  blockedUntil: number;
  failCount: number;
  successCount: number;
  lastUsedAt: number;
}

let keySlots: GeminiKeySlot[] = [];
let lastKeyFingerprint = '';
let roundRobinPointer = 0;

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * Collects all configured Gemini API keys from environment variables.
 * Supports:
 * - GEMINI_API_KEYS (comma, semicolon, or newline separated list of keys)
 * - GEMINI_API_KEY
 * - GOOGLE_API_KEY
 * - GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...
 * - GOOGLE_API_KEY_1, GOOGLE_API_KEY_2, ...
 */
function collectConfiguredKeys(): string[] {
  const env = runtimeEnv();
  const keys: string[] = [];

  const addKey = (k?: string) => {
    if (!k) return;
    const items = k.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    for (const trimmed of items) {
      if (
        trimmed &&
        trimmed !== 'AIzaSy...' &&
        !trimmed.startsWith('AIzaSy...your') &&
        !keys.includes(trimmed)
      ) {
        keys.push(trimmed);
      }
    }
  };

  // 1. Check GEMINI_API_KEYS pool string
  addKey(env.GEMINI_API_KEYS || process.env.GEMINI_API_KEYS);

  // 2. Standard keys (supports comma-separated directly in GEMINI_API_KEY as well)
  addKey(env.GEMINI_API_KEY || process.env.GEMINI_API_KEY);
  addKey(env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY);

  // 3. Numbered keys (e.g. GEMINI_API_KEY_1 to 10)
  for (let i = 1; i <= 10; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addKey((env as any)[`GEMINI_API_KEY_${i}`] || process.env[`GEMINI_API_KEY_${i}`]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addKey((env as any)[`GOOGLE_API_KEY_${i}`] || process.env[`GOOGLE_API_KEY_${i}`]);
  }

  return keys;
}

/**
 * Initializes or syncs the key pool with current environment configuration.
 */
function syncPool(): GeminiKeySlot[] {
  const keys = collectConfiguredKeys();
  const fingerprint = keys.join('|');

  if (fingerprint === lastKeyFingerprint && keySlots.length > 0) {
    return keySlots;
  }

  const existingMap = new Map(keySlots.map(s => [s.key, s]));
  const newSlots: GeminiKeySlot[] = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const existing = existingMap.get(key);
    if (existing) {
      existing.index = i;
      newSlots.push(existing);
    } else {
      newSlots.push({
        index: i,
        key,
        maskedKey: maskApiKey(key),
        client: new GoogleGenAI({ apiKey: key }),
        blockedUntil: 0,
        failCount: 0,
        successCount: 0,
        lastUsedAt: 0,
      });
    }
  }

  keySlots = newSlots;
  lastKeyFingerprint = fingerprint;

  if (keySlots.length > 0) {
    console.log(`[Gemini Pool] Initialized with ${keySlots.length} API key(s): ${keySlots.map(s => s.maskedKey).join(', ')}`);
  }

  return keySlots;
}

/**
 * Returns all currently unblocked key slots.
 */
export function getAvailableKeySlots(): GeminiKeySlot[] {
  const slots = syncPool();
  const now = Date.now();
  return slots.filter(s => now >= s.blockedUntil);
}

/**
 * Checks if all Gemini keys are currently rate-limited or blocked.
 */
export function isAllGeminiKeysBlocked(): boolean {
  const slots = syncPool();
  if (slots.length === 0) return true;
  const now = Date.now();
  return slots.every(s => now < s.blockedUntil);
}

/**
 * Gets the timestamp when at least one Gemini key will be ready.
 */
export function getGeminiEarliestUnblockTime(): number {
  const slots = syncPool();
  if (slots.length === 0) return Date.now() + 60000;
  const now = Date.now();
  const unblocked = slots.filter(s => now >= s.blockedUntil);
  if (unblocked.length > 0) return now;

  let minUnblock = Infinity;
  for (const slot of slots) {
    if (slot.blockedUntil < minUnblock) {
      minUnblock = slot.blockedUntil;
    }
  }
  return minUnblock === Infinity ? now + 60000 : minUnblock;
}

/**
 * Marks a specific key as rate-limited / blocked.
 */
export function markKeyBlocked(slot: GeminiKeySlot, reason?: string, customDelaySec?: number) {
  const str = (reason || '').toLowerCase();
  let delaySec = customDelaySec || 60;

  if (!customDelaySec) {
    const match = str.match(/retry in (\d+(?:\.\d+)?)s/i) || str.match(/retrydelay["']?:\s*["']?(\d+)s/i);
    if (match) {
      delaySec = Math.ceil(parseFloat(match[1])) + 2;
    }
  }
  delaySec = Math.min(Math.max(delaySec, 20), 90);

  slot.blockedUntil = Date.now() + delaySec * 1000;
  slot.failCount++;

  const activeRemaining = keySlots.filter(s => Date.now() >= s.blockedUntil).length;
  console.warn(
    `[Gemini Pool] Key #${slot.index + 1} (${slot.maskedKey}) rate-limited (429). Pausing for ${delaySec}s. Active keys remaining: ${activeRemaining}/${keySlots.length}`
  );
}

/**
 * Returns a Gemini client using round-robin over unblocked keys.
 */
export function getGeminiClient(): GoogleGenAI | null {
  const slots = syncPool();
  if (slots.length === 0) return null;

  const now = Date.now();
  const activeSlots = slots.filter(s => now >= s.blockedUntil);
  if (activeSlots.length === 0) return null;

  roundRobinPointer = (roundRobinPointer + 1) % activeSlots.length;
  const chosen = activeSlots[roundRobinPointer];
  chosen.lastUsedAt = now;
  return chosen.client;
}

/**
 * Executes a Gemini operation with automatic key pooling & failover.
 * If Key #1 hits 429 (15 RPM limit), it marks Key #1 as paused for 60s
 * and immediately retries the operation on Key #2, Key #3, etc.
 * Gemini is only blocked globally if ALL keys in the pool are rate-limited.
 */
export async function executeWithGeminiPool<T>(
  operation: (client: GoogleGenAI, slot: GeminiKeySlot) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const slots = syncPool();
  if (slots.length === 0) {
    throw new Error('No Gemini API keys configured. Set GEMINI_API_KEY or GEMINI_API_KEYS.');
  }

  const attemptedKeyIndices = new Set<number>();
  let lastError: unknown = null;

  while (attemptedKeyIndices.size < slots.length) {
    signal?.throwIfAborted();

    const now = Date.now();
    // Prioritize unblocked keys that have not been attempted in this call yet
    const availableSlots = slots.filter(
      s => now >= s.blockedUntil && !attemptedKeyIndices.has(s.index)
    );

    if (availableSlots.length === 0) {
      break;
    }

    // Round-robin selection among available
    const slot = availableSlots[roundRobinPointer % availableSlots.length];
    roundRobinPointer++;
    attemptedKeyIndices.add(slot.index);
    slot.lastUsedAt = now;

    try {
      signal?.throwIfAborted();
      const result = await operation(slot.client, slot);
      slot.successCount++;
      return result;
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      lastError = err;

      const errStr = String(err).toLowerCase();
      const isQuota =
        errStr.includes('429') ||
        errStr.includes('resource_exhausted') ||
        errStr.includes('quota') ||
        errStr.includes('too many requests') ||
        errStr.includes('rate limit');

      if (isQuota) {
        markKeyBlocked(slot, String(err));
        // Loop continues to try the next key immediately!
        continue;
      }

      const is503 = errStr.includes('503') || errStr.includes('unavailable') || errStr.includes('overloaded');
      if (is503) {
        console.warn(`[Gemini Pool] Key #${slot.index + 1} encountered 503 transient error, rotating to next key...`);
        await new Promise(r => setTimeout(r, 600));
        continue;
      }

      // If it's a fatal validation or syntax error, don't loop endlessly across all keys
      throw err;
    }
  }

  // If all keys were exhausted due to quota/rate limit:
  const earliestUnblock = getGeminiEarliestUnblockTime();
  const waitSec = Math.max(1, Math.ceil((earliestUnblock - Date.now()) / 1000));
  const poolMsg = `All ${slots.length} Gemini API key(s) in pool are currently rate-limited (429). Retry in ~${waitSec}s.`;
  console.warn(`[Gemini Pool] ${poolMsg}`);

  const exhaustedErr = new Error(poolMsg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (exhaustedErr as any).status = 429;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (exhaustedErr as any).cause = lastError;
  throw exhaustedErr;
}

/**
 * Diagnostics & health information about the current key pool.
 */
export function getGeminiPoolStats() {
  const slots = syncPool();
  const now = Date.now();
  return {
    totalKeys: slots.length,
    activeKeys: slots.filter(s => now >= s.blockedUntil).length,
    blockedKeys: slots.filter(s => now < s.blockedUntil).length,
    slots: slots.map(s => ({
      index: s.index,
      maskedKey: s.maskedKey,
      isActive: now >= s.blockedUntil,
      blockedRemainingSec: Math.max(0, Math.ceil((s.blockedUntil - now) / 1000)),
      successCount: s.successCount,
      failCount: s.failCount,
    })),
  };
}

// Gemini 2.5 is no longer provisioned for new API users. Keep the stable
// Flash model first and retain a Pro fallback for quality-sensitive requests.
export const GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_BACKUP_MODELS = ['gemini-3.1-pro-preview'];
