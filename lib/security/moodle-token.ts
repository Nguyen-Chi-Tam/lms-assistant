import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer | null {
  const value = process.env.MOODLE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value) return null;

  try {
    const key = Buffer.from(value, 'base64');
    if (key.length === 32) return key;
  } catch {
    // Fall through to the hex form.
  }

  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  return null;
}

export function encryptMoodleToken(token: string): string | null {
  const key = getKey();
  if (!key) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptMoodleToken(value: string): string | null {
  const key = getKey();
  const [version, ivValue, tagValue, encryptedValue] = value.split('.');
  if (!key || version !== 'v1' || !ivValue || !tagValue || !encryptedValue) return null;

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}