'use client';

import { getDeviceId } from '@/app/lib/device-id';

// NOTE: The Firebase SDK is intentionally NOT imported at module scope.
// `notification-client` is pulled into the initial client bundle of every page
// (via the root layout's NotificationManager), and `firebase/messaging` is a
// large dependency that is only ever needed when the user has actually granted
// notification permission. It is dynamically imported inside `registerFcmToken`
// so it lands in a separate, on-demand chunk instead of the first-load payload.

/**
 * Client-side notification manager for LMS Assistant.
 * Handles Service Worker registration, permission requesting, and local notification dismissal.
 */

export async function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/',
    });
    // Check and apply service worker updates immediately
    try {
      await registration.update();
    } catch {
      // ignore
    }
    return registration;
  } catch (err) {
    console.warn('[Notification] Failed to register service worker:', err);
    return null;
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }

  // Browsers allow notifications only from HTTPS origins (localhost is the exception).
  if (!window.isSecureContext) {
    console.warn('[Notification] HTTPS is required before a device can grant notification permission.');
    return 'denied';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  try {
    const perm = await Notification.requestPermission();
    return perm;
  } catch (err) {
    console.warn('[Notification] Permission request error:', err);
    return 'denied';
  }
}

export async function registerFcmToken(
  userId: number,
  promptIfNeeded = false,
  userRole?: string
): Promise<string | null> {
  // Push notifications and FCM tokens are strictly for STUDENTS. Skip teachers completely.
  if (userRole && userRole !== 'student') {
    return null;
  }
  try {
    const stored = localStorage.getItem('moodleUser');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.role && parsed.role !== 'student') {
        return null;
      }
    }
  } catch {
    // ignore
  }

  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  let perm = Notification.permission;
  if (perm !== 'granted' && promptIfNeeded) {
    perm = await requestNotificationPermission();
  }

  if (perm !== 'granted') {
    return null;
  }

  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (Object.values(config).some(value => !value) || !vapidKey) {
    console.warn('[Notification] Firebase Web configuration is incomplete.');
    return null;
  }

  try {
    // Lazy-load the Firebase SDK only once we are certain a token is needed.
    const [{ getApps, initializeApp }, { getMessaging, getToken }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    const app = getApps()[0] || initializeApp(config);
    const registration = await registerNotificationServiceWorker();
    if (!registration) return null;

    const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: registration });
    if (!token) return null;

    localStorage.setItem('fcmToken', token);

    // Only register to backend once every 12 hours per user+token to prevent 7+ second blocking calls on every page visit
    const lastRegKey = `fcm_reg_${userId}_${token.slice(-10)}`;
    const lastRegTime = Number(localStorage.getItem(lastRegKey) || 0);
    const now = Date.now();
    if (now - lastRegTime > 12 * 60 * 60 * 1000) {
      try {
        await fetch('/api/fcm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, token, deviceId: getDeviceId(), deviceType: 'web', role: userRole || 'student' }),
        });
        localStorage.setItem(lastRegKey, String(now));
      } catch (postErr) {
        console.warn('[Notification] Error posting FCM token:', postErr);
      }
    }
    return token;
  } catch (err) {
    console.warn('[Notification] Failed to register FCM token:', err);
    return null;
  }
}

export async function unregisterFcmToken(userId?: number): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  const token = localStorage.getItem('fcmToken') || undefined;
  const deviceId = getDeviceId();

  try {
    await fetch('/api/fcm', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, token, deviceId }),
    });
  } catch (err) {
    console.warn('[Notification] Failed to delete FCM token on logout:', err);
  } finally {
    localStorage.removeItem('fcmToken');
  }
  return true;
}

export async function dismissLocalNotificationByTag(tag: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const notifications = await registration.getNotifications({ tag });
    notifications.forEach((n) => n.close());
    return true;
  } catch (err) {
    console.warn('[Notification] Failed to dismiss notification locally:', err);
    return false;
  }
}

export function onServiceWorkerMessage(callback: (event: MessageEvent) => void): () => void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {};
  }

  navigator.serviceWorker.addEventListener('message', callback);
  return () => {
    navigator.serviceWorker.removeEventListener('message', callback);
  };
}

