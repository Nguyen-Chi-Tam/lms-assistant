'use client';

import useSWR, { type SWRConfiguration } from 'swr';
import type { MoodleData, ErrorResponse } from '@/app/types';

export const defaultSWRConfig: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: false,
  dedupingInterval: 30000, // 30s deduping window
  shouldRetryOnError: false, // Don't hammer slow/failing Moodle servers
};

/**
 * Standard client fetcher with authentication header support
 */
export async function defaultFetcher<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('moodleToken');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  const res = await fetch(url, { headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };

  if (!res.ok) {
    const errorMsg = data?.error || data?.message || `HTTP ${res.status}: Lỗi tải dữ liệu`;
    const error = new Error(errorMsg);
    (error as any).status = res.status;
    (error as any).info = data;
    throw error;
  }

  return data;
}

/**
 * SWR Hook for Moodle data with client-side caching
 */
export function useMoodleData(enabled = true) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('moodleToken') : null;
  const key = enabled ? (token ? `/api/moodle?token=${encodeURIComponent(token.slice(0, 8))}` : '/api/moodle') : null;

  return useSWR<MoodleData & ErrorResponse>(
    key,
    () => defaultFetcher<MoodleData & ErrorResponse>('/api/moodle'),
    defaultSWRConfig
  );
}

/**
 * SWR Hook for teacher students and grade items with client-side caching
 */
export function useTeacherStudents(courseId: number | string | undefined | null, token?: string) {
  const key = courseId ? `/api/teacher/students?courseId=${encodeURIComponent(String(courseId))}` : null;

  return useSWR(
    key,
    () => defaultFetcher(key!),
    defaultSWRConfig
  );
}

/**
 * SWR Hook for course personal materials
 */
export function useCourseMaterials(courseId: number | string | undefined | null, userId: number | string | undefined | null) {
  const key = courseId && userId ? `/api/documents/process?moodleCourseId=${courseId}&userId=${userId}` : null;

  return useSWR(
    key,
    () => defaultFetcher(key!),
    defaultSWRConfig
  );
}

