'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * localStorage-backed numeric goal (0–10), safe for server rendering.
 *
 * `useSyncExternalStore` renders the server snapshot (the fallback) during
 * hydration, so the first client paint always matches the SSR HTML. The saved
 * value is applied right after hydration, and the hook also follows changes
 * made in other tabs through the `storage` event.
 */

const listenersByKey = new Map<string, Set<() => void>>();

function listenersFor(key: string) {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  return listeners;
}

const clampTarget = (value: number) => Math.min(10, Math.max(0, value));

function readTarget(key: string, fallback: number) {
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === null) return fallback;
    const parsed = Number(saved);
    return Number.isFinite(parsed) ? clampTarget(parsed) : fallback;
  } catch {
    return fallback;
  }
}

function subscribeToTarget(key: string, onChange: () => void) {
  const listeners = listenersFor(key);
  listeners.add(onChange);

  const onStorage = (event: StorageEvent) => {
    if (event.key === key) onChange();
  };
  window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useStoredTarget(storageKey: string, fallback = 8) {
  const subscribe = useCallback((onChange: () => void) => subscribeToTarget(storageKey, onChange), [storageKey]);

  const target = useSyncExternalStore(
    subscribe,
    () => readTarget(storageKey, fallback),
    () => fallback
  );

  const setTarget = useCallback(
    (value: number) => {
      const next = clampTarget(value);
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        // Storage can be unavailable (private mode/quota); keep the UI in sync anyway.
      }
      listenersFor(storageKey).forEach(listener => listener());
    },
    [storageKey]
  );

  return [target, setTarget] as const;
}
