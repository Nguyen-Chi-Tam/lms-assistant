'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, FileText, RotateCcw, Megaphone, Clock, CheckSquare, Key, LayoutDashboard, BookOpen } from 'lucide-react';
import type { MoodleUser } from '@/app/types';
import { ByokSettingsModal } from '../settings/ByokSettingsModal';

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
  onOpenByok?: () => void;
  menuItems?: Array<{ key: string; label: string; icon?: React.ReactNode }>;
  activeMenuKey?: string;
  onSelectMenu?: (key: string) => void;
}

export function CourseTopBar({
  syncing = false,
  onSync,
  notifications,
  onToggleNotifications,
  onCloseNotifications,
  notificationPermission = 'default',
  onRequestNotificationPermission,
  events: propEvents,
  courses,
  user,
  displayName,
  onOpenProfile,
  onOpenNotification,
  onOpenByok,
}: CourseTopBarProps) {
  const pathname = usePathname();
  const notifRef = useRef<HTMLDivElement>(null);
  const [dbEvents, setDbEvents] = useState<NotificationItem[]>([]);
  const [avatarError, setAvatarError] = useState(false);
  const [showByok, setShowByok] = useState(false);
  const prevSyncingRef = useRef(syncing);
  const lastNotifFetchRef = useRef(0);
  const notifFetchInFlightRef = useRef(false);

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

    const now = Date.now();
    if (notifFetchInFlightRef.current) return;
    if (!opts?.force && now - lastNotifFetchRef.current < 15_000) return;

    notifFetchInFlightRef.current = true;
    try {
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
    }
  }, [user?.id]);

  useEffect(() => {
    void fetchDbNotifications();
  }, [fetchDbNotifications]);

  useEffect(() => {
    if (notifications) {
      void fetchDbNotifications({ force: true });
    }
  }, [notifications, fetchDbNotifications]);

  useEffect(() => {
    if (prevSyncingRef.current && !syncing) {
      void fetchDbNotifications();
    }
    prevSyncingRef.current = syncing;
  }, [syncing, fetchDbNotifications]);

  const displayEvents: NotificationItem[] = propEvents ?? dbEvents;

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
  const showDesktopNav = pathname !== '/home';

  return (
    <header className="course-topbar-root" aria-label="Thanh điều hướng">
      {/* Left: Brand Logo & Standard Top Navigation */}
      <div className="course-topbar-left">
        <Link href="/home" className="course-topbar-brand" title="Về trang chủ">
          <img
            className="course-topbar-logo"
            src="/lms-assistant-icon.png"
            alt="LMS Assistant"
          />
          <span className="course-topbar-title">LMS Assistant</span>
        </Link>

        {showDesktopNav && (
          <nav className="topbar-inline-nav" aria-label="Điều hướng nhanh">
            <Link
              href="/home"
              className={`topbar-inline-link ${pathname === '/home' ? 'active' : ''}`}
            >
              <LayoutDashboard size={14} />
              <span>Tổng quan</span>
            </Link>
            <Link
              href="/home?tab=courses"
              className={`topbar-inline-link ${pathname === '/courses' || pathname === '/course' ? 'active' : ''}`}
            >
              <BookOpen size={14} />
              <span>Khóa học</span>
            </Link>
          </nav>
        )}
      </div>

      {/* Right: Actions, Notification Bell, User Avatar */}
      <div className="course-topbar-right">
        {onSync && (
          <button
            type="button"
            className={`course-topbar-btn sync-btn ${syncing ? 'syncing' : ''}`}
            onClick={onSync}
            title="Đồng bộ dữ liệu Moodle"
            aria-label="Đồng bộ dữ liệu Moodle"
          >
            <RotateCcw size={13} className={syncing ? 'animate-spin' : ''} />
            <span className="sync-btn-label">{syncing ? 'Đang tải…' : 'Đồng bộ'}</span>
          </button>
        )}

        <button
          type="button"
          className="course-topbar-btn byok-btn"
          onClick={() => {
            if (onOpenByok) onOpenByok();
            else setShowByok(true);
          }}
          title="Cài đặt API Key"
          aria-label="Cài đặt API Key"
        >
          <Key size={13} className={showByok ? 'key-rotate' : ''} />
          <span className="byok-btn-label">API Key</span>
        </button>

        {/* Notification Bell */}
        <div className="course-topbar-notif-wrap" ref={notifRef}>
          <button
            type="button"
            aria-label="Thông báo"
            className={`course-topbar-icon-btn ${notifications ? 'active' : ''}`}
            onClick={onToggleNotifications}
            title="Thông báo"
          >
            <Bell size={16} className={notifications ? 'bell-ring' : ''} />
            {displayEvents.length > 0 && <span className="course-topbar-unread-dot" />}
          </button>

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
                    {notificationPermission === 'denied' ? 'Thông báo đang bị chặn' : 'Bật thông báo nhắc hạn'}
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

                    let badgeBg: string | undefined;
                    let badgeColor: string | undefined;
                    if (isManual) {
                      badgeBg = 'rgba(185, 43, 71, 0.15)';
                      badgeColor = '#e06c82';
                    } else if (isAttendance) {
                      badgeBg = 'rgba(185, 43, 71, 0.15)';
                      badgeColor = '#e06c82';
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
                            {isManual ? 'Sự kiện · ' : isAttendance ? 'Điểm danh · ' : isExam ? 'Kiểm tra · ' : 'Hạn nộp · '}
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
                    Không có thông báo mới.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Profile Avatar Button */}
        <div className="course-topbar-profile-wrap">
          <button
            type="button"
            className="course-topbar-profile-btn"
            onClick={onOpenProfile}
            title={`Tài khoản: ${displayName}`}
            aria-label="Tài khoản"
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
              <small>{user?.username || 'Học viên'}</small>
            </div>
          </button>
        </div>
      </div>

      <ByokSettingsModal
        isOpen={showByok}
        onClose={() => setShowByok(false)}
        userId={user?.id}
      />
    </header>
  );
}

export default CourseTopBar;
