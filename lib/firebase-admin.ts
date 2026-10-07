import { runtimeEnv } from '@/db/runtime';

export type FirebaseRow = { id: string } & Record<string, unknown>;

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreValue>;
};

type FirestoreValue = Record<string, unknown>;

let accessToken: { value: string; expiresAt: number } | null = null;

function encodeBase64Url(value: string | ArrayBuffer) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const env = runtimeEnv();
  const projectId = env.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY || '';
  if (!projectId || !clientEmail || !privateKey) return null;

  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;

  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.replace(/\\n/g, '\n').trim();

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), (char) => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const assertion = `${header}.${payload}.${encodeBase64Url(signature)}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Firebase authentication failed (${response.status})`);
  const token = await response.json() as { access_token?: string; expires_in?: number };
  if (!token.access_token) throw new Error('Firebase authentication returned no access token');
  accessToken = {
    value: token.access_token,
    expiresAt: Date.now() + (token.expires_in || 3600) * 1000,
  };
  return accessToken.value;
}

function getDocumentUrl(collectionName: string, id?: string) {
  const env = runtimeEnv();
  const projectId = env.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  const path = `projects/${projectId}/databases/(default)/documents/${collectionName}${id ? `/${id}` : ''}`;
  return `https://firestore.googleapis.com/v1/${path}`;
}

function decodeValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return ((value.arrayValue as { values?: FirestoreValue[] }).values || []).map(decodeValue);
  if ('mapValue' in value) return Object.fromEntries(Object.entries((value.mapValue as { fields?: Record<string, FirestoreValue> }).fields || {}).map(([key, item]) => [key, decodeValue(item)]));
  return value;
}

function decodeDocument(document: FirestoreDocument): FirebaseRow {
  const id = document.name?.split('/').pop() || '';
  return {
    id,
    ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])),
  };
}

function encodeValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) {
        fields[key] = encodeValue(item);
      }
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

async function firestoreRequest(url: string, init?: RequestInit) {
  const token = await getAccessToken();
  if (!token) return null;
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error(`Firestore request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

export async function getFirebaseRows(
  collectionName: string,
  filters: Record<string, string | number | undefined> = {},
  limit?: number,
): Promise<FirebaseRow[] | null> {
  const url = getDocumentUrl(collectionName);
  if (!url) return null;
  const response = await firestoreRequest(`${url}?pageSize=1000`) as { documents?: FirestoreDocument[] } | null;
  if (!response) return null;
  let rows = (response.documents || []).map(decodeDocument);

  rows = rows.filter((row) => Object.entries(filters).every(([key, value]) => value === undefined || row[key] === value));
  rows.sort((left, right) => String(right.updated_at || right.created_at || right.id).localeCompare(String(left.updated_at || left.created_at || left.id)));
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}

export async function getFirebaseRow(collectionName: string, id: string): Promise<FirebaseRow | null> {
  const url = getDocumentUrl(collectionName, id);
  if (!url) return null;
  const response = await firestoreRequest(url) as FirestoreDocument | null;
  return response ? decodeDocument(response) : null;
}

export async function setFirebaseRow(
  collectionName: string,
  id: string,
  data: Record<string, unknown>,
  updateFields?: string[]
): Promise<FirebaseRow | null> {
  let url = getDocumentUrl(collectionName, id);
  if (!url) return null;
  if (updateFields && updateFields.length > 0) {
    const params = new URLSearchParams();
    updateFields.forEach(f => params.append('updateMask.fieldPaths', f));
    url = `${url}?${params.toString()}`;
  }
  const cleanFields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      cleanFields[key] = encodeValue(value);
    }
  }
  await firestoreRequest(url, {
    method: 'PATCH',
    body: JSON.stringify({ fields: cleanFields }),
  });
  return getFirebaseRow(collectionName, id);
}

export async function deleteFirebaseRow(collectionName: string, id: string) {
  const url = getDocumentUrl(collectionName, id);
  if (!url) return false;
  await firestoreRequest(url, { method: 'DELETE' });
  return true;
}

// Firebase Cloud Messaging (FCM) via Google HTTP v1 REST API
// Bypasses Node.js http2.connect to be 100% compatible with Vinext, Cloudflare Workers & Edge runtimes.

let fcmAccessToken: { value: string; expiresAt: number } | null = null;

async function getFcmOAuthAccessToken(): Promise<string | null> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
  if ((privateKey.startsWith('"') && privateKey.endsWith('"')) || (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) return null;

  if (fcmAccessToken && fcmAccessToken.expiresAt > Date.now() + 60_000) {
    return fcmAccessToken.value;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600,
    })
  );

  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), char => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );

  const assertion = `${header}.${payload}.${encodeBase64Url(signature)}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FCM OAuth authentication failed (${response.status}): ${errorText}`);
  }

  const tokenData = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!tokenData.access_token) {
    throw new Error('FCM OAuth returned no access token');
  }

  fcmAccessToken = {
    value: tokenData.access_token,
    expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
  };
  return fcmAccessToken.value;
}

export interface MulticastPayload {
  notification: {
    title: string;
    body: string;
  };
  data?: Record<string, string>;
  tokens: string[];
}

export interface MulticastResponse {
  responses: Array<{
    success: boolean;
    messageId?: string;
    error?: { message?: string };
  }>;
  successCount: number;
  failureCount: number;
}

export async function sendFcmEachForMulticast(payload: MulticastPayload): Promise<MulticastResponse> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID is not configured');
  }

  const accessToken = await getFcmOAuthAccessToken();
  if (!accessToken) {
    throw new Error('Could not obtain FCM OAuth access token');
  }

  const tokens = payload.tokens || [];
  const results: MulticastResponse['responses'] = [];
  let successCount = 0;
  let failureCount = 0;

  await Promise.allSettled(
    tokens.map(async token => {
      try {
        const eventTag = payload.data?.tag || 'lms-assistant-notification';
        const bodyPayload = {
          message: {
            token,
            notification: {
              title: payload.notification.title,
              body: payload.notification.body,
            },
            data: payload.data || {},
            webpush: {
              notification: {
                title: payload.notification.title,
                body: payload.notification.body,
                icon: '/lms-assistant-icon.png',
                badge: '/lms-assistant-icon.png',
                tag: eventTag,
                renotify: true,
                require_interaction: true,
              },
              fcm_options: {
                link: payload.data?.url || '/home',
              },
            },
          },
        };

        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyPayload),
        });

        const data = (await res.json()) as { name?: string; error?: { message?: string } };
        if (res.ok) {
          successCount++;
          results.push({ success: true, messageId: data.name });
        } else {
          failureCount++;
          results.push({ success: false, error: { message: data.error?.message || `HTTP ${res.status}` } });
        }
      } catch (err) {
        failureCount++;
        results.push({ success: false, error: { message: err instanceof Error ? err.message : String(err) } });
      }
    })
  );

  return {
    successCount,
    failureCount,
    responses: results,
  };
}

export const adminMessaging = {
  sendEachForMulticast: sendFcmEachForMulticast,
};
