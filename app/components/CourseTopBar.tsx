'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { Bell, FileText, RotateCcw, Megaphone, GraduationCap, ExternalLink, Clock, CheckSquare } from 'lucide-react';
import type { MoodleUser } from '@/app/types';

export interface NotificationItem {
  id: number | string;
  name?: string;
  title?: string;
  courseName?: string;
  eventType?: string;
  timestamp: number;
  url?: string;
  moodleEventId?: number | null;
  moodleCourseId?: number | null;
  eventDetails?: string | null;
}

export interface CourseTopBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  syncing?: boolean;
  onSync?: () => void;
  notifications: boolean;
  onToggleNotifications: () => void;
  onCloseNotifications: () => void;
  notificationPermission?: NotificationPermission;
  onRequestNotificationPermission?: () => Promise<void> | void;
  deadlines?: NotificationItem[];
  events?: NotificationItem[];
  courses?: Array<{ id?: number | string; name: string; code?: string }>;
  user?: MoodleUser | null;
  displayName: string;
  onOpenProfile: () => void;
  onOpenNotification?: (item: NotificationItem) => void;
  lmsUrl?: string;
}

export function CourseTopBar({
  search,
  onSearchChange,
  searchRef,
  syncing = false,
  onSync,
  notifications,
  onToggleNotifications,
  onCloseNotifications,
  notificationPermission = 'default',
  onRequestNotificationPermission,
  deadlines,
  events: propEvents,
  courses,
  user,
  displayName,
  onOpenProfile,
  onOpenNotification,
  lmsUrl,
}: CourseTopBarProps) {
  const notifRef = useRef<HTMLDivElement>(null);
  const [dbEvents, setDbEvents] = useState<NotificationItem[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const prevSyncingRef = useRef(syncing);
  // Guards so mount + sync-finish + popover-open collapse into a single request.
  const lastNotifFetchRef = useRef(0);
  const notifFetchInFlightRef = useRef(false);

  // Fetch notifications from events table
  const fetchDbNotifications = useCallback(async (opts?: { force?: boolean }) => {
    let uid = user?.id;
    if (!uid && typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('moodleUser');
        if (stored) {
          const parsed = JSON.parse(stored);
          uid = parsed?.id;
        }
      } catch {
        // ignore parse error
      }
    }
    if (!uid) return;

    // Collapse duplicate triggers (mount + user change + sync finishing) into
    // one network call within a short window, and never run two in parallel.
    const now = Date.now();
    if (notifFetchInFlightRef.current) return;
    if (!opts?.force && now - lastNotifFetchRef.current < 15_000) return;

    notifFetchInFlightRef.current = true;
    try {
      setLoadingEvents(true);
      const res = await fetch(`/api/notifications?userId=${uid}`, { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { success?: boolean; events?: NotificationItem[] };
        if (data && Array.isArray(data.events)) {
          setDbEvents(data.events);
        }
      }
      lastNotifFetchRef.current = Date.now();
    } catch (err) {
      console.warn('Error loading notifications from events table:', err);
    } finally {
      notifFetchInFlightRef.current = false;
      setLoadingEvents(false);
    }
  }, [user?.id]);

  // Load events on mount / user change
  useEffect(() => {
    void fetchDbNotifications();
  }, [fetchDbNotifications]);

  // Re-fetch when notification dialog opens
  useEffect(() => {
    if (notifications) {
      void fetchDbNotifications({ force: true });
    }
  }, [notifications, fetchDbNotifications]);

  // Re-fetch when syncing finishes
  useEffect(() => {
    if (prevSyncingRef.current && !syncing) {
      void fetchDbNotifications();
    }
    prevSyncingRef.current = syncing;
  }, [syncing, fetchDbNotifications]);

  // Active notification list: priorize propEvents if explicitly passed, otherwise use dbEvents from events table
  const displayEvents: NotificationItem[] = propEvents ?? dbEvents;

  // Close notifications popover on click outside
  useEffect(() => {
    if (!notifications) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        onCloseNotifications();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [notifications, onCloseNotifications]);

  useEffect(() => {
    if (!notifications || notificationPermission !== 'default' || !onRequestNotificationPermission) return;

    void onRequestNotificationPermission();
    const retryWhenFocused = () => void onRequestNotificationPermission();
    window.addEventListener('focus', retryWhenFocused);
    return () => window.removeEventListener('focus', retryWhenFocused);
  }, [notifications, notificationPermission, onRequestNotificationPermission]);

  const initials = (displayName || 'User').slice(0, 2).toUpperCase();

  return (
    <header className="course-topbar-root" aria-label="Thanh điều hướng">
      {/* Left: Brand Logo & Title */}
      <div className="course-topbar-left">
        <Link href="/home" className="course-topbar-brand" title="Về trang chủ LMS Assistant">
          <img
            className="course-topbar-logo"
            src="/lms-assistant-icon.png"
            alt="LMS Assistant Logo"
          />
          <span className="course-topbar-title">LMS Assistant</span>
        </Link>
      </div>

      {/* Right: Actions, Notification Bell, User Avatar */}
      <div className="course-topbar-right">
        {/* Sync LMS data button (desktop) */}
        {onSync && (
          <button
            type="button"
            className={`course-topbar-btn desktop-only sync-btn ${syncing ? 'syncing' : ''}`}
            onClick={onSync}
            title="Đồng bộ lại tài liệu từ LMS"
          >
            <RotateCcw size={13} className={syncing ? 'animate-spin' : ''} />
            <span>{syncing ? 'Đang tải…' : 'Đồng bộ LMS'}</span>
          </button>
        )}

        {/* Notification Bell (Mobile & Desktop) */}
        <div className="course-topbar-notif-wrap" ref={notifRef}>
          <button
            type="button"
            aria-label="Thông báo"
            className={`course-topbar-icon-btn ${notifications ? 'active' : ''}`}
            onClick={() => {
              onToggleNotifications();
            }}
            title="Thông báo"
          >
            <Bell size={17} />
            {displayEvents.length > 0 && <span className="course-topbar-unread-dot" />}
          </button>

          {/* Notification Popover */}
          {notifications && (
            <div className="course-topbar-popover" role="dialog" aria-modal="true">
              <header className="course-topbar-popover-header">
                <strong>Thông báo ({displayEvents.length})</strong>
                <button
                  type="button"
                  onClick={onCloseNotifications}
                  aria-label="Đóng thông báo"
                  className="course-topbar-popover-close"
                >
                  ×
                </button>
              </header>

              <div className="course-topbar-popover-content">
                {Boolean(onRequestNotificationPermission) && notificationPermission !== 'granted' && (
                  <button
                    type="button"
                    className="notification-permission-button"
                    disabled={notificationPermission === 'denied'}
                    onClick={() => void onRequestNotificationPermission?.()}
                  >
                    {notificationPermission === 'denied' ? 'Thông báo đang bị chặn trong trình duyệt' : 'Bật thông báo nhắc hạn'}
                  </button>
                )}
                {displayEvents.length > 0 ? (
                  displayEvents.map(d => {
                    const date = new Date(d.timestamp);
                    const titleText = d.title || d.name || 'Thông báo';
                    const isManual = d.eventType === 'manual';
                    const isAttendance =
                      !isManual &&
                      (d.eventType === 'attendance' ||
                        titleText.toLowerCase().includes('attendance') ||
                        titleText.toLowerCase().includes('điểm danh') ||
                        (d.url && d.url.toLowerCase().includes('/mod/attendance/')));
                    const isExam =
                      !isManual &&
                      !isAttendance &&
                      (d.eventType === 'quiz' ||
                        d.eventType === 'exam' ||
                        titleText.toLowerCase().includes('thi') ||
                        titleText.toLowerCase().includes('kiểm tra') ||
                        titleText.toLowerCase().includes('quiz') ||
                        (d.url && d.url.toLowerCase().includes('/mod/quiz/')));
                    const resolvedCourseName =
                      d.courseName ||
                      (courses && d.moodleCourseId
                        ? courses.find(c => Number(c.id) === Number(d.moodleCourseId))?.name
                        : undefined);
                    const notifWithCourse: NotificationItem = resolvedCourseName && resolvedCourseName !== d.courseName
                      ? { ...d, courseName: resolvedCourseName }
                      : d;

                    let badgeBg = undefined;
                    let badgeColor = undefined;
                    if (isManual) {
                      badgeBg = 'rgba(236, 72, 153, 0.15)';
                      badgeColor = '#ec4899';
                    } else if (isAttendance) {
                      badgeBg = 'rgba(59, 130, 246, 0.15)';
                      badgeColor = '#60a5fa';
                    } else if (isExam) {
                      badgeBg = 'rgba(245, 158, 11, 0.15)';
                      badgeColor = '#fbbf24';
                    }

                    return (
                      <div
                        key={d.id}
                        className="course-topbar-notif-item"
                        onClick={() => {
                          onCloseNotifications();
                          onOpenNotification?.(notifWithCourse);
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            onCloseNotifications();
                            onOpenNotification?.(notifWithCourse);
                          }
                        }}
                      >
                        <span className={`course-topbar-notif-badge ${isManual ? 'manual' : ''}`} style={badgeBg ? { backgroundColor: badgeBg, color: badgeColor } : undefined}>
                          {isManual ? <Megaphone size={14} /> : isAttendance ? <Clock size={14} /> : isExam ? <CheckSquare size={14} /> : <FileText size={14} />}
                        </span>
                        <div className="course-topbar-notif-text" style={{ flex: 1, minWidth: 0 }}>
                          <b>{resolvedCourseName ? `${resolvedCourseName}: ${titleText}` : titleText}</b>
                          {isManual && d.eventDetails && (
                            <p style={{ margin: '2px 0 3px', fontSize: '11px', color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {d.eventDetails}
                            </p>
                          )}
                          <small>
                            {isManual ? 'sự kiện ' : isAttendance ? 'điểm danh ' : isExam ? 'kiểm tra ' : 'hạn nộp '}
                            {date.toLocaleString('vi-VN', {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </small>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="course-topbar-notif-empty">
                    Không có bài tập hoặc thông báo mới từ LMS.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Profile Avatar Button */}
        <button
          type="button"
          className="course-topbar-profile-btn"
          onClick={onOpenProfile}
          title={`Hồ sơ cá nhân: ${displayName}`}
          aria-label="Hồ sơ cá nhân"
        >
          <span className="course-topbar-avatar">
            {user?.avatarUrl && !avatarError ? (
              <img
                src={user.avatarUrl}
                alt={displayName}
                onError={() => setAvatarError(true)}
              />
            ) : (
              <span className="course-topbar-avatar-initials">{initials}</span>
            )}
          </span>
          <div className="course-topbar-profile-text desktop-only">
            <strong>{displayName}</strong>
            <small>{user?.username || 'Sinh viên LMS'}</small>
          </div>
        </button>
      </div>
    </header>
  );
}

export default CourseTopBar;

