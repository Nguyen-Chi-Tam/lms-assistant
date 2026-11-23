/**
 * In-memory server-side cache with TTL and in-flight request deduplication.
 * Eliminates repeated multi-second round-trips to remote Moodle instances
 * and prevents race condition bottlenecks when clients switch tabs rapidly.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();
const inFlightPromises = new Map<string, Promise<unknown>>();

// Maximum entries to prevent unbounded memory growth
const MAX_CACHE_ENTRIES = 500;

export function getCached<T>(key: string): T | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCached<T>(key: string, data: T, ttlMs: number): void {
  // Simple eviction if map grows too large
  if (memoryCache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of memoryCache.entries()) {
      if (now > v.expiresAt) {
        memoryCache.delete(k);
      }
    }
    // If still at capacity, delete oldest 20%
    if (memoryCache.size >= MAX_CACHE_ENTRIES) {
      let count = 0;
      for (const k of memoryCache.keys()) {
        memoryCache.delete(k);
        count++;
        if (count >= 100) break;
      }
    }
  }

  memoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

export function invalidateCache(keyOrPrefix: string): void {
  for (const k of memoryCache.keys()) {
    if (k === keyOrPrefix || k.startsWith(keyOrPrefix)) {
      memoryCache.delete(k);
    }
  }
}

/**
 * Fetch with cache + concurrent in-flight promise deduplication.
 * If multiple requests for the same key arrive simultaneously,
 * only ONE request is executed against Moodle/DB, and all callers receive the same result.
 */
export async function fetchWithCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = getCached<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Check if an identical request is currently in-flight
  const existingInFlight = inFlightPromises.get(key);
  if (existingInFlight) {
    return existingInFlight as Promise<T>;
  }

  const promise = (async () => {
    try {
      const result = await fetcher();
      // Safeguard: Never cache a raw Response/NextResponse instance as its body ReadableStream is consumed upon first transmission
      if (result instanceof Response) {
        console.warn(`[server-cache] Warning: Attempted to cache a Response instance for key "${key}". Response bodies cannot be safely reused; caching skipped.`);
      } else {
        setCached(key, result, ttlMs);
      }
      return result;
    } finally {
      inFlightPromises.delete(key);
    }
  })();

  inFlightPromises.set(key, promise);
  return promise as Promise<T>;
}

