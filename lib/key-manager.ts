import { getDb } from '@/db';
import { userApiKeys } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { supabaseAdmin } from '@/lib/supabase';
import { encryptApiKey, decryptApiKey, maskApiKey } from './encryption-utils';

export type ByokProvider = 'gemini' | 'groq' | 'openrouter';

export interface UserApiKeyRecord {
  id: string;
  userId: number;
  provider: ByokProvider;
  keyName: string;
  maskedKey: string;
  createdAt: string;
}

export interface UserKeySummary {
  hasGemini: boolean;
  hasGroq: boolean;
  hasOpenRouter: boolean;
  geminiKeyCount: number;
  groqKeyCount: number;
  openRouterKeyCount: number;
  keys: UserApiKeyRecord[];
}

/**
 * Normalizes input provider name to canonical BYOK provider.
 * Supports Google AI Studio, Groq, OpenRouter and common aliases.
 */
export function normalizeProvider(provider: string): ByokProvider | null {
  if (!provider) return null;
  const p = provider.trim().toLowerCase();
  if (p === 'gemini' || p === 'google' || p === 'google_ai_studio' || p === 'google-ai-studio') {
    return 'gemini';
  }
  if (p === 'groq') {
    return 'groq';
  }
  if (p === 'openrouter' || p === 'open-router' || p === 'open_router') {
    return 'openrouter';
  }
  return null;
}

/**
 * In-memory TTL cache for decrypted user keys to avoid querying & decrypting
 * on every single streaming token or parallel API call.
 */
interface CachedKeys {
  keysMap: {
    gemini: string[];
    groq: string[];
    openrouter: string[];
  };
  summary: UserKeySummary;
  expiresAt: number;
}

const userKeyCache = new Map<number, CachedKeys>();
const CACHE_TTL_MS = 60_000; // 1 minute

export function invalidateUserKeyCache(userId: number): void {
  userKeyCache.delete(userId);
}

/**
 * Fetch raw user_api_keys records for a user from PostgreSQL (via Drizzle)
 * with graceful fallback to Supabase Admin client.
 */
async function fetchUserKeyRows(userId: number): Promise<Array<{
  id: string;
  user_id: number;
  provider: string;
  key_name: string | null;
  encrypted_api_key: string;
  encryption_iv: string;
  auth_tag: string;
  created_at: Date | string | null;
}>> {
  const db = getDb();

  if (db) {
    try {
      const rows = await db
        .select()
        .from(userApiKeys)
        .where(eq(userApiKeys.userId, userId))
        .orderBy(desc(userApiKeys.createdAt), desc(userApiKeys.id));

      return rows.map(r => ({
        id: r.id,
        user_id: r.userId,
        provider: r.provider,
        key_name: r.keyName,
        encrypted_api_key: r.encryptedApiKey,
        encryption_iv: r.encryptionIv,
        auth_tag: r.authTag,
        created_at: r.createdAt,
      }));
    } catch (dbErr) {
      console.warn('[BYOK KeyManager] Drizzle query failed, attempting Supabase fallback:', dbErr);
    }
  }

  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('user_api_keys')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });

      if (!error && Array.isArray(data)) {
        return data;
      }
      if (error) {
        console.warn('[BYOK KeyManager] Supabase fetch error:', error);
      }
    } catch (sbErr) {
      console.warn('[BYOK KeyManager] Supabase query exception:', sbErr);
    }
  }

  return [];
}

/**
 * Loads and decrypts all keys for a user, cached in-memory for 60 seconds.
 */
async function loadDecryptedUserKeys(userId: number): Promise<CachedKeys> {
  const cached = userKeyCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  const rawRows = await fetchUserKeyRows(userId);

  const keysMap: { gemini: string[]; groq: string[]; openrouter: string[] } = {
    gemini: [],
    groq: [],
    openrouter: [],
  };

  const keyRecords: UserApiKeyRecord[] = [];

  for (const row of rawRows) {
    const canonical = normalizeProvider(row.provider);
    if (!canonical) continue;

    const decrypted = decryptApiKey(
      row.encrypted_api_key,
      row.encryption_iv,
      row.auth_tag
    );

    if (decrypted && decrypted.trim()) {
      keysMap[canonical].push(decrypted.trim());

      const masked = maskApiKey(decrypted);
      keyRecords.push({
        id: row.id,
        userId: row.user_id,
        provider: canonical,
        keyName: row.key_name || `${canonical.toUpperCase()} Key (${masked})`,
        maskedKey: masked,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      });
    }
  }

  const summary: UserKeySummary = {
    hasGemini: keysMap.gemini.length > 0,
    hasGroq: keysMap.groq.length > 0,
    hasOpenRouter: keysMap.openrouter.length > 0,
    geminiKeyCount: keysMap.gemini.length,
    groqKeyCount: keysMap.groq.length,
    openRouterKeyCount: keysMap.openrouter.length,
    keys: keyRecords,
  };

  const entry: CachedKeys = {
    keysMap,
    summary,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  userKeyCache.set(userId, entry);
  return entry;
}

/**
 * Returns decrypted API keys configured by the user for a specific provider.
 * Sorted newest first by createdAt DESC.
 */
export async function getUserApiKeys(
  userId: number | undefined | null,
  provider: ByokProvider
): Promise<string[]> {
  if (!userId || userId <= 0) return [];
  const { keysMap } = await loadDecryptedUserKeys(userId);
  return keysMap[provider] || [];
}

/**
 * Returns all decrypted user keys mapped by provider.
 */
export async function getUserApiKeysMap(
  userId: number | undefined | null
): Promise<{ gemini: string[]; groq: string[]; openrouter: string[] }> {
  if (!userId || userId <= 0) {
    return { gemini: [], groq: [], openrouter: [] };
  }
  const { keysMap } = await loadDecryptedUserKeys(userId);
  return keysMap;
}

/**
 * Returns key summary and masked records for frontend settings UI.
 * Never exposes the plaintext or encrypted keys.
 */
export async function getUserKeySummary(userId: number): Promise<UserKeySummary> {
  if (!userId || userId <= 0) {
    return {
      hasGemini: false,
      hasGroq: false,
      hasOpenRouter: false,
      geminiKeyCount: 0,
      groqKeyCount: 0,
      openRouterKeyCount: 0,
      keys: [],
    };
  }
  const { summary } = await loadDecryptedUserKeys(userId);
  return summary;
}

/**
 * Adds or updates a user API key.
 * Encrypts immediately with Master Key before storing.
 */
export async function saveUserApiKey(params: {
  userId: number;
  provider: string;
  apiKey: string;
  keyName?: string;
}): Promise<{ success: boolean; record?: UserApiKeyRecord; error?: string }> {
  const { userId, provider, apiKey, keyName } = params;

  if (!userId || userId <= 0) {
    return { success: false, error: 'User ID không hợp lệ.' };
  }

  const canonical = normalizeProvider(provider);
  if (!canonical) {
    return {
      success: false,
      error: 'Nhà cung cấp không được hỗ trợ. Vui lòng chọn Google AI Studio, Groq hoặc OpenRouter.',
    };
  }

  const cleanKey = (apiKey || '').trim();
  if (!cleanKey || cleanKey.length < 8) {
    return { success: false, error: 'Độ dài API Key không hợp lệ.' };
  }

  // Basic provider key prefix validation
  if (canonical === 'groq' && !cleanKey.startsWith('gsk_')) {
    console.warn(`[BYOK] Groq key does not start with 'gsk_', continuing anyway.`);
  } else if (canonical === 'openrouter' && !cleanKey.startsWith('sk-or-')) {
    console.warn(`[BYOK] OpenRouter key does not start with 'sk-or-', continuing anyway.`);
  }

  let encryptedPayload;
  try {
    encryptedPayload = encryptApiKey(cleanKey);
  } catch (err: any) {
    return { success: false, error: err?.message || 'Lỗi mã hóa API Key trên máy chủ.' };
  }

  const masked = maskApiKey(cleanKey);
  const resolvedKeyName = (keyName || '').trim() || `${canonical.toUpperCase()} Key (${masked})`;

  const db = getDb();
  let createdId: string | null = null;

  if (db) {
    try {
      const [inserted] = await db
        .insert(userApiKeys)
        .values({
          userId,
          provider: canonical,
          keyName: resolvedKeyName,
          encryptedApiKey: encryptedPayload.encryptedApiKey,
          encryptionIv: encryptedPayload.encryptionIv,
          authTag: encryptedPayload.authTag,
        })
        .returning({ id: userApiKeys.id, createdAt: userApiKeys.createdAt });

      if (inserted) {
        createdId = inserted.id;
      }
    } catch (dbErr) {
      console.warn('[BYOK KeyManager] Drizzle insert failed, falling back to Supabase:', dbErr);
    }
  }

  if (!createdId && supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('user_api_keys')
        .insert({
          user_id: userId,
          provider: canonical,
          key_name: resolvedKeyName,
          encrypted_api_key: encryptedPayload.encryptedApiKey,
          encryption_iv: encryptedPayload.encryptionIv,
          auth_tag: encryptedPayload.authTag,
        })
        .select('id, created_at')
        .single();

      if (error) {
        return { success: false, error: error.message };
      }
      if (data) {
        createdId = data.id;
      }
    } catch (sbErr: any) {
      return { success: false, error: sbErr?.message || 'Lỗi lưu trữ API Key.' };
    }
  }

  if (!createdId) {
    return { success: false, error: 'Không thể kết nối cơ sở dữ liệu để lưu khóa.' };
  }

  // Invalidate in-memory cache so subsequent calls reflect new key immediately
  invalidateUserKeyCache(userId);

  return {
    success: true,
    record: {
      id: createdId,
      userId,
      provider: canonical,
      keyName: resolvedKeyName,
      maskedKey: masked,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * Deletes a user API key by ID (ensures user owns the key).
 */
export async function deleteUserApiKey(
  userId: number,
  keyId: string
): Promise<{ success: boolean; error?: string }> {
  if (!userId || !keyId) {
    return { success: false, error: 'Thông tin không hợp lệ.' };
  }

  const db = getDb();
  let deleted = false;

  if (db) {
    try {
      await db
        .delete(userApiKeys)
        .where(and(eq(userApiKeys.id, keyId), eq(userApiKeys.userId, userId)));
      deleted = true;
    } catch (dbErr) {
      console.warn('[BYOK KeyManager] Drizzle delete failed, attempting Supabase fallback:', dbErr);
    }
  }

  if (!deleted && supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin
        .from('user_api_keys')
        .delete()
        .eq('id', keyId)
        .eq('user_id', userId);

      if (error) {
        return { success: false, error: error.message };
      }
      deleted = true;
    } catch (sbErr: any) {
      return { success: false, error: sbErr?.message || 'Lỗi xóa API Key.' };
    }
  }

  invalidateUserKeyCache(userId);
  return { success: true };
}

