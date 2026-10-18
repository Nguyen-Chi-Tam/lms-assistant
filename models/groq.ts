import Groq from 'groq-sdk';
import { runtimeEnv } from '@/db/runtime';

export interface GroqKeySlot {
  index: number;
  key: string;
  maskedKey: string;
  client: Groq;
  blockedUntil: number;
  failCount: number;
  successCount: number;
  lastUsedAt: number;
}

let keySlots: GroqKeySlot[] = [];
let lastKeyFingerprint = '';
let roundRobinPointer = 0;

function maskApiKey(key: string): string {
  if (!key || key.length < 10) return '****';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

/**
 * Collects all configured Groq API keys from environment variables.
 * Supports:
 * - GROQ_API_KEYS (comma, semicolon, or newline separated list of keys)
 * - GROQ_API_KEY (comma, semicolon, or newline separated list of keys)
 * - GROQ_API_KEY_1, GROQ_API_KEY_2, ... up to 10
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
        !trimmed.startsWith('gsk_your') &&
        trimmed !== 'gsk_...' &&
        !keys.includes(trimmed)
      ) {
        keys.push(trimmed);
      }
    }
  };

  // 1. Check GROQ_API_KEYS pool string
  addKey(env.GROQ_API_KEYS || process.env.GROQ_API_KEYS);

  // 2. Standard keys (supports comma-separated directly in GROQ_API_KEY)
  addKey(env.GROQ_API_KEY || process.env.GROQ_API_KEY);

  // 3. Numbered keys (e.g. GROQ_API_KEY_1 to 10)
  for (let i = 1; i <= 10; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addKey((env as any)[`GROQ_API_KEY_${i}`] || process.env[`GROQ_API_KEY_${i}`]);
  }

  return keys;
}

/**
 * Initializes or syncs the Groq key pool with current environment configuration.
 */
function syncPool(): GroqKeySlot[] {
  const keys = collectConfiguredKeys();
  const fingerprint = keys.join('|');

  if (fingerprint === lastKeyFingerprint && keySlots.length > 0) {
    return keySlots;
  }

  const existingMap = new Map(keySlots.map(s => [s.key, s]));
  const newSlots: GroqKeySlot[] = [];

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
        client: new Groq({ apiKey: key }),
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
    console.log(
      `[Groq Pool] Initialized with ${keySlots.length} API key(s): ${keySlots.map(s => s.maskedKey).join(', ')}`
    );
  }

  return keySlots;
}

/**
 * Returns all currently unblocked Groq key slots.
 */
export function getAvailableKeySlots(): GroqKeySlot[] {
  const slots = syncPool();
  const now = Date.now();
  return slots.filter(s => now >= s.blockedUntil);
}

/**
 * Checks if all Groq keys are currently rate-limited or blocked.
 */
export function isAllGroqKeysBlocked(): boolean {
  const slots = syncPool();
  if (slots.length === 0) return true;
  const now = Date.now();
  return slots.every(s => now < s.blockedUntil);
}

/**
 * Gets the timestamp when at least one Groq key will be ready.
 */
export function getGroqEarliestUnblockTime(): number {
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
 * Marks a specific Groq key as rate-limited / blocked.
 */
export function markGroqKeyBlocked(slot: GroqKeySlot, reason?: string, customDelaySec?: number) {
  const str = (reason || '').toLowerCase();
  let delaySec = customDelaySec || 30;

  if (!customDelaySec) {
    // Check for "try again in X.Xs" or similar Groq rate limit headers
    const match = str.match(/try again in (\d+(?:\.\d+)?)s/i) || str.match(/retry in (\d+(?:\.\d+)?)s/i);
    if (match) {
      delaySec = Math.ceil(parseFloat(match[1])) + 2;
    }
  }
  delaySec = Math.min(Math.max(delaySec, 10), 90);

  slot.blockedUntil = Date.now() + delaySec * 1000;
  slot.failCount++;

  const activeRemaining = keySlots.filter(s => Date.now() >= s.blockedUntil).length;
  console.warn(
    `[Groq Pool] Key #${slot.index + 1} (${slot.maskedKey}) rate-limited (429). Pausing for ${delaySec}s. Active keys remaining: ${activeRemaining}/${keySlots.length}`
  );
}

/**
 * Returns a Groq client using round-robin over unblocked keys.
 */
export function getGroqClient(): Groq | null {
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
 * Executes a Groq operation with automatic key pooling & failover.
 * If Key #1 hits 429 (Rate limit: RPM or TPM limit), it marks Key #1 as paused
 * and immediately retries the operation on Key #2, Key #3, etc.
 * Groq is only blocked globally if ALL keys in the pool are rate-limited.
 */
export async function executeWithGroqPool<T>(
  operation: (client: Groq, slot: GroqKeySlot) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const slots = syncPool();
  if (slots.length === 0) {
    throw new Error('No Groq API keys configured. Set GROQ_API_KEY or GROQ_API_KEYS.');
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
        errStr.includes('rate limit') ||
        errStr.includes('rate_limit_exceeded') ||
        errStr.includes('tokens per minute') ||
        errStr.includes('requests per minute') ||
        errStr.includes('quota');

      if (isQuota) {
        markGroqKeyBlocked(slot, String(err));
        // Loop continues to try the next key immediately!
        continue;
      }

      const is503 = errStr.includes('503') || errStr.includes('unavailable') || errStr.includes('overloaded');
      if (is503) {
        console.warn(`[Groq Pool] Key #${slot.index + 1} encountered 503 transient error, rotating to next key...`);
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      // If it's a fatal validation or syntax error, don't loop endlessly across all keys
      throw err;
    }
  }

  // If all keys were exhausted due to quota/rate limit:
  const earliestUnblock = getGroqEarliestUnblockTime();
  const waitSec = Math.max(1, Math.ceil((earliestUnblock - Date.now()) / 1000));
  const poolMsg = `All ${slots.length} Groq API key(s) in pool are currently rate-limited (429). Retry in ~${waitSec}s.`;
  console.warn(`[Groq Pool] ${poolMsg}`);

  const exhaustedErr = new Error(poolMsg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (exhaustedErr as any).status = 429;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (exhaustedErr as any).cause = lastError;
  throw exhaustedErr;
}

/**
 * Diagnostics & health information about the current Groq key pool.
 */
export function getGroqPoolStats() {
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

// Verified active models on your Groq key
export const GROQ_MODEL = 'openai/gpt-oss-120b';
export const GROQ_BACKUP_MODELS = ['qwen/qwen3.8-27b'];
