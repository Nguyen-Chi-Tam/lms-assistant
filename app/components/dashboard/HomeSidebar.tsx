'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  CalendarClock,
  CheckSquare,
  Clock,
  ExternalLink,
  FileText,
  GraduationCap,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  RotateCcw,
} from 'lucide-react';
import type { MoodleUser } from '@/app/types';
import type { NotificationItem } from '@/app/components/course/CourseTopBar';
import { ByokSettingsModal } from '@/app/components/settings/ByokSettingsModal';
import { useGlassSlider } from '@/app/lib/use-glass-slider';

export type HomeSidebarTab = 'Tổng quan' | 'Khóa học' | 'Hoạt động' | 'Bảng điểm' | 'AI Helper';

const NAV_ITEMS: Array<{ tab: HomeSidebarTab; label: string; icon: typeof LayoutDashboard }> = [
  { tab: 'Tổng quan', label: 'Tổng quan', icon: LayoutDashboard },
  { tab: 'Khóa học', label: 'Khóa học', icon: BookOpen },
  { tab: 'Hoạt động', label: 'Hoạt động', icon: CalendarClock },
  { tab: 'Bảng điểm', label: 'Bảng điểm', icon: BarChart3 },
  { tab: 'AI Helper', label: 'AI Helper', icon: Bot },
];

export interface HomeSidebarProps {
  active: string;
  onSelect: (tab: HomeSidebarTab) => void;
  user?: MoodleUser | null;
  displayName: string;
  syncing?: boolean;
  onSync?: () => void;
  onOpenProfile: () => void;
  onOpenNotification?: (item: NotificationItem) => void;
  courses?: Array<{ id?: number | string; name: string }>;
  lmsUrl?: string;
}

/** Desktop left navigation for the home dashboard. */
export function HomeSidebar({
  active,
  onSelect,
  user,
  displayName,
  syncing = false,
  onSync,
  onOpenProfile,
  onOpenNotification,
  courses,
  lmsUrl,
}: HomeSidebarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const [events, setEvents] = useState<NotificationItem[]>([]);
  const [showByok, setShowByok] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const prevSyncingRef = useRef(syncing);

  const fetchNotifications = useCallback(async () => {
    let uid = user?.id;
    if (!uid) {
      try {
        uid = JSON.parse(localStorage.getItem('moodleUser') || '{}')?.id;
      } catch {
        uid = undefined;
      }
    }
    if (!uid || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch(`/api/notifications?userId=${uid}`, { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { events?: NotificationItem[] };
        if (Array.isArray(data?.events)) setEvents(data.events);
      }
    } catch {
      // ignore
    } finally {
      inFlightRef.current = false;
    }
  }, [user?.id]);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    if (notifOpen) void fetchNotifications();
  }, [notifOpen, fetchNotifications]);

  useEffect(() => {
    if (prevSyncingRef.current && !syncing) void fetchNotifications();
    prevSyncingRef.current = syncing;
  }, [syncing, fetchNotifications]);

  useEffect(() => {
    if (!notifOpen) return;
    const close = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNotifOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [notifOpen]);

  const initials = (displayName || 'User').slice(0, 2).toUpperCase();
  const activeIndex = NAV_ITEMS.findIndex(item => item.tab === active);
  const slider = useGlassSlider({
    count: NAV_ITEMS.length,
    activeIndex,
    stepPx: 45, // 42px item height + 3px gap
    onSelectIndex: idx => {
      const target = NAV_ITEMS[idx];
      if (target) onSelect(target.tab);
    },
  });

  return (
    <aside className="home-sidebar" aria-label="Điều hướng chính">
      <Link
        href="/home"
        className="home-sidebar-brand"
        title="LMS Assistant"
        onClick={() => onSelect('Tổng quan')}
      >
        <img src="/lms-assistant-icon.png" alt="LMS Assistant" />
        <span>LMS Assistant</span>
      </Link>

      <p className="home-sidebar-label">MENU</p>
      <nav
        className="home-sidebar-nav"
        ref={slider.containerRef}
        {...slider.handlers}
      >
        {activeIndex >= 0 && (
          <span
            className={`home-sidebar-slider ${slider.isDragging ? 'dragging' : ''}`}
            style={{ transform: `translateY(${slider.sliderY})` }}
            aria-hidden="true"
          />
        )}
        {NAV_ITEMS.map(({ tab, label, icon: Icon }, idx) => (
          <button
            key={tab}
            type="button"
            className={`home-sidebar-item ${slider.effectiveIndex === idx ? 'active' : ''}`}
            onClick={() => {
              if (!slider.justDraggedRef.current) onSelect(tab);
            }}
            aria-current={active === tab ? 'page' : undefined}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {lmsUrl && (
        <a
          href={lmsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="home-sidebar-item"
          title="Mở Moodle LMS"
          style={{ marginTop: 3, textDecoration: 'none' }}
        >
          <GraduationCap size={17} />
          <span>Mở Moodle</span>
          <ExternalLink size={13} style={{ marginLeft: 'auto', opacity: 0.6 }} />
        </a>
      )}

      <div className="home-sidebar-bottom">
        <p className="home-sidebar-label" style={{ marginTop: 4 }}>TIỆN ÍCH</p>
        {onSync && (
          <button
            type="button"
            className={`home-sidebar-item ${syncing ? 'syncing' : ''}`}
            onClick={onSync}
            title="Đồng bộ dữ liệu Moodle"
          >
            <RotateCcw size={16} className={syncing ? 'animate-spin' : ''} />
            <span>{syncing ? 'Đang đồng bộ…' : 'Đồng bộ Moodle'}</span>
          </button>
        )}

        <div className="home-sidebar-notif-wrap" ref={notifRef}>
          <button
            type="button"
            className={`home-sidebar-item ${notifOpen ? 'active' : ''}`}
            onClick={() => setNotifOpen(v => !v)}
            aria-expanded={notifOpen}
          >
            <Bell size={16} className={notifOpen ? 'bell-ring' : ''} />
            <span>Thông báo</span>
            {events.length > 0 && <em className="home-sidebar-badge">{events.length > 99 ? '99+' : events.length}</em>}
          </button>

          {notifOpen && (
            <div className="home-sidebar-popover" role="dialog" aria-label="Thông báo">
              <header className="course-topbar-popover-header">
                <strong>Thông báo ({events.length})</strong>
                <button type="button" className="course-topbar-popover-close" onClick={() => setNotifOpen(false)} aria-label="Đóng">
                  ×
                </button>
              </header>
              <div className="course-topbar-popover-content">
                {events.length === 0 ? (
                  <div className="course-topbar-notif-empty">Không có thông báo mới.</div>
                ) : (
                  events.map(d => {
                    const title = d.title || d.name || 'Thông báo';
                    const lower = title.toLowerCase();
                    const url = (d.url || '').toLowerCase();
                    const isManual = d.eventType === 'manual';
                    const isAttendance =
                      !isManual && (d.eventType === 'attendance' || lower.includes('attendance') || lower.includes('điểm danh') || url.includes('/mod/attendance/'));
                    const isExam =
                      !isManual && !isAttendance &&
                      (d.eventType === 'quiz' || d.eventType === 'exam' || lower.includes('thi') || lower.includes('kiểm tra') || lower.includes('quiz') || url.includes('/mod/quiz/'));
                    const courseName =
                      d.courseName ||
                      (d.moodleCourseId ? courses?.find(c => Number(c.id) === Number(d.moodleCourseId))?.name : undefined);
                    const item = courseName && courseName !== d.courseName ? { ...d, courseName } : d;
                    const open = () => {
                      setNotifOpen(false);
                      onOpenNotification?.(item);
                    };
                    return (
                      <div
                        key={d.id}
                        className="course-topbar-notif-item"
                        role="button"
                        tabIndex={0}
                        onClick={open}
                        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && open()}
                      >
                        <span className={`course-topbar-notif-badge ${isManual ? 'manual' : ''}`}>
                          {isManual ? <Megaphone size={14} /> : isAttendance ? <Clock size={14} /> : isExam ? <CheckSquare size={14} /> : <FileText size={14} />}
                        </span>
                        <div className="course-topbar-notif-text" style={{ flex: 1, minWidth: 0 }}>
                          <b>{courseName ? `${courseName}: ${title}` : title}</b>
                          <small>
                            {isManual ? 'Sự kiện · ' : isAttendance ? 'Điểm danh · ' : isExam ? 'Kiểm tra · ' : 'Hạn nộp · '}
                            {new Date(d.timestamp).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </small>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <button type="button" className="home-sidebar-item" onClick={() => setShowByok(true)} title="Cài đặt API Key">
          <KeyRound size={16} className={showByok ? 'key-rotate' : ''} />
          <span>API Key</span>
        </button>

        <button type="button" className="home-sidebar-profile" onClick={onOpenProfile} title={`Tài khoản: ${displayName}`}>
          <span className="home-sidebar-avatar">
            {user?.avatarUrl && !avatarError ? (
              <img src={user.avatarUrl} alt={displayName} onError={() => setAvatarError(true)} />
            ) : (
              initials
            )}
          </span>
          <span className="home-sidebar-profile-text">
            <strong>{displayName}</strong>
            <small>{user?.username || 'Tài khoản'}</small>
          </span>
        </button>
      </div>

      <ByokSettingsModal isOpen={showByok} onClose={() => setShowByok(false)} userId={user?.id} />
    </aside>
  );
}

export default HomeSidebar;
