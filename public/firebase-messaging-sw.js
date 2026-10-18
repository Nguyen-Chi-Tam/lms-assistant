// Firebase Cloud Messaging Service Worker
// Handles background push notifications, custom notification tags, and silent data dismissal.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    try {
      payload = { notification: { title: 'LMS Assistant', body: event.data.text() } };
    } catch {
      return;
    }
  }

  // 1. Silent Push (Data Message): Intercept and dismiss stale notifications across devices
  if (payload.data && payload.data.action === 'dismiss') {
    const tagToRemove = payload.data.tag;
    if (tagToRemove) {
      event.waitUntil(
        Promise.all([
          // Programmatically close any active system/browser notification with this tag
          self.registration.getNotifications({ tag: tagToRemove }).then((notifications) => {
            notifications.forEach((notification) => {
              notification.close();
            });
          }),
          // Notify any active browser tabs of this app to update in-app UI/badges
          self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            clients.forEach((client) => {
              client.postMessage({
                type: 'NOTIFICATION_DISMISSED',
                tag: tagToRemove,
                data: payload.data,
              });
            });
          }),
        ])
      );
    }
    // Return early to prevent OS from displaying any popup banner
    return;
  }

  // 2. Normal Display Notification: Display message with mandatory tag and deduplication
  const title = payload.notification?.title || payload.data?.title || 'Thông báo LMS Assistant';
  const body = payload.notification?.body || payload.data?.body || '';
  const icon = payload.notification?.icon || payload.data?.icon || '/lms-assistant-icon.png';
  const tag =
    payload.notification?.tag ||
    payload.data?.tag ||
    (payload.data?.eventId ? `event-${payload.data.eventId}` : `lms-${Date.now()}`);
  const clickAction = payload.data?.url || payload.notification?.click_action || '/home';

  const notificationOptions = {
    body,
    icon,
    badge: '/lms-assistant-icon.png',
    tag, // Mandatory non-empty string when renotify is true
    renotify: true,
    requireInteraction: true,
    data: {
      url: clickAction,
      tag,
      receivedAt: Date.now(),
      ...payload.data,
    },
  };

  event.waitUntil(
    Promise.all([
      self.registration
        .showNotification(title, notificationOptions)
        .catch((err) => {
          console.error('[SW] showNotification failed with options, attempting fallback:', err);
          return self.registration.showNotification(title, {
            body,
            icon: '/lms-assistant-icon.png',
          });
        }),
      // Forward push to open windows if any
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'NOTIFICATION_RECEIVED',
            title,
            body,
            payload,
          });
        });
      }),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/home';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a matching tab is already open, focus it
      for (const client of clientList) {
        if (client.url && client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // If any LMS tab is open, navigate and focus
      if (clientList.length > 0 && 'focus' in clientList[0] && 'navigate' in clientList[0]) {
        clientList[0].focus();
        return clientList[0].navigate(targetUrl);
      }
      // Otherwise open a new browser window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

