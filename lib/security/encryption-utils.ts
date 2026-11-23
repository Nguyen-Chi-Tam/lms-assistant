import crypto from 'crypto';
import { runtimeEnv } from '@/db/runtime';

const ALGORITHM = 'aes-256-gcm';

/**
 * Retrieves the 32-byte Master Key buffer from environment variables.
 * Expects MASTER_ENCRYPTION_KEY to be either:
 * - A 64-character hex string (32 bytes)
 * - A 44-character base64 string (32 bytes)
 */
export function getMasterKey(): Buffer | null {
  const env = runtimeEnv();
  const value = (env.MASTER_ENCRYPTION_KEY || process.env.MASTER_ENCRYPTION_KEY || '').trim();
  if (!value) {
    console.warn('[BYOK Encryption] MASTER_ENCRYPTION_KEY is not set.');
    return null;
  }

  // Check 64-char hex
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }

  // Check base64
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length === 32) {
      return buf;
    }
  } catch {
    // ignore
  }

  // Fallback: derive 32-byte key via sha256 if user provided custom passphrase
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export interface EncryptedPayload {
  encryptedApiKey: string;
  encryptionIv: string;
  authTag: string;
}

/**
 * Encrypts an API key using AES-256-GCM with the Master Key.
 * Returns encrypted ciphertext, initialization vector (IV), and authentication tag in hex.
 */
export function encryptApiKey(apiKey: string): EncryptedPayload {
  const key = getMasterKey();
  if (!key) {
    throw new Error('Master encryption key not configured on server.');
  }

  const iv = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedApiKey: encrypted.toString('hex'),
    encryptionIv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypts an API key using AES-256-GCM with the Master Key.
 * Returns the decrypted plaintext or null if decryption/authentication fails.
 */
export function decryptApiKey(
  encryptedApiKey: string,
  encryptionIv: string,
  authTag: string
): string | null {
  const key = getMasterKey();
  if (!key) {
    console.warn('[BYOK Encryption] Cannot decrypt key: MASTER_ENCRYPTION_KEY missing.');
    return null;
  }

  if (!encryptedApiKey || !encryptionIv || !authTag) {
    return null;
  }

  try {
    const iv = Buffer.from(encryptionIv, 'hex');
    const tag = Buffer.from(authTag, 'hex');
    const encrypted = Buffer.from(encryptedApiKey, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.warn('[BYOK Encryption] Decryption failed (invalid auth tag or corrupted payload):', err);
    return null;
  }
}

/**
 * Mask an API key for safe display in UI or logs (never leak full secret).
 * Examples:
 * - AIzaSyApitr5...Ek -> AIzaSy...9Ek
 * - gsk_xJXXBkU3...23j -> gsk_...23j
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '****';
  const clean = apiKey.trim();
  if (clean.length <= 8) return '****';
  if (clean.length <= 16) return `${clean.slice(0, 4)}...${clean.slice(-3)}`;
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

