'use client';

import { useEffect, useState, useCallback } from 'react';
import { registerNotificationServiceWorker, onServiceWorkerMessage } from '@/app/lib/notification-client';
import { Bell, X } from 'lucide-react';

interface ToastNotice {
  id: string;
  title: string;
  body: string;
  url?: string;
}

function playNotificationChime() {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    // Gentle melodic chime: D5 (587.3Hz) -> A5 (880Hz)
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // Audio may be muted by browser policy if user has not interacted with DOM yet
  }
}

export function NotificationManager() {
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    // 1. Register Service Worker for push notifications & silent dismiss
    void registerNotificationServiceWorker();

    // 2. Listen to service worker postMessage events
    const unsubscribe = onServiceWorkerMessage((event) => {
      if (event.data?.type === 'NOTIFICATION_DISMISSED') {
        const tag = event.data.tag;
        setToasts((prev) => prev.filter((t) => t.id !== tag));
      } else if (event.data?.type === 'NOTIFICATION_RECEIVED') {
        const title =
          event.data.title ||
          event.data.payload?.notification?.title ||
          event.data.payload?.data?.title ||
          'Thông báo mới';
        const body =
          event.data.body ||
          event.data.payload?.notification?.body ||
          event.data.payload?.data?.body ||
          '';
        const tag =
          event.data.payload?.notification?.tag ||
          event.data.payload?.data?.tag ||
          `toast-${Date.now()}`;
        const url =
          event.data.payload?.data?.url ||
          event.data.payload?.notification?.click_action ||
          '/home';

        playNotificationChime();

        setToasts((prev) => {
          const filtered = prev.filter((t) => t.id !== tag);
          return [...filtered, { id: tag, title, body, url }];
        });

        // Auto remove toast after 8 seconds
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== tag));
        }, 8000);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: '20px',
        right: '20px',
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        maxWidth: '380px',
        width: 'calc(100vw - 40px)',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            pointerEvents: 'auto',
            background: 'linear-gradient(135deg, rgba(30, 27, 75, 0.95), rgba(15, 23, 42, 0.98))',
            border: '1px solid rgba(129, 140, 248, 0.35)',
            boxShadow: '0 10px 30px -5px rgba(0, 0, 0, 0.6), 0 0 15px rgba(99, 102, 241, 0.25)',
            backdropFilter: 'blur(16px)',
            borderRadius: '16px',
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px',
            color: '#f8fafc',
            cursor: 'pointer',
          }}
          onClick={() => {
            if (toast.url) window.location.href = toast.url;
            dismissToast(toast.id);
          }}
        >
          <div
            style={{
              padding: '8px',
              borderRadius: '12px',
              backgroundColor: 'rgba(99, 102, 241, 0.2)',
              color: '#a5b4fc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Bell size={20} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h4
              style={{
                margin: 0,
                fontSize: '14px',
                fontWeight: 600,
                color: '#ffffff',
                lineHeight: 1.3,
              }}
            >
              {toast.title}
            </h4>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: '13px',
                color: '#cbd5e1',
                lineHeight: 1.4,
              }}
            >
              {toast.body}
            </p>
          </div>
          <button
            type="button"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '2px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
            }}
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(toast.id);
            }}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
