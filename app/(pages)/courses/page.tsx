'use client';

import { Suspense, useEffect, useState, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ExternalLink } from 'lucide-react';
import { CourseTopBar, type NotificationItem } from '@/app/components/CourseTopBar';
import { CoursesView } from '@/app/components/CoursesView';
import type { Course, MoodleData, MoodleUser } from '@/app/types';
import { registerFcmToken, unregisterFcmToken } from '@/app/lib/notification-client';

function CoursesPageContent() {
  const router = useRouter();
  const [user, setUser] = useState<MoodleUser | null>(null);
  const [moodle, setMoodle] = useState<MoodleData | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [notifications, setNotifications] = useState(false);
  const [profile, setProfile] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(Notification.permission);
    }

    const storedUser = localStorage.getItem('moodleUser');
    const token = localStorage.getItem('moodleToken');
    if (!token) {
      router.push('/login');
      return;
    }
    if (storedUser) {
      try {
        const u = JSON.parse(storedUser);
        setUser(u);
        const uname = (u?.username || '').toLowerCase();
        const fname = (u?.fullname || '').toLowerCase();
        const isTeacherOrAdmin =
          uname === 'admin' ||
          uname.includes('admin') ||
          uname.includes('teacher') ||
          fname.includes('admin') ||
          fname.includes('giảng viên') ||
          fname.includes('thầy') ||
          fname.includes('cô');
        if (isTeacherOrAdmin || u?.role === 'teacher') {
          router.replace('/home');
          return;
        }
        if (u?.id && u?.role !== 'teacher') {
          void registerFcmToken(u.id, false, u.role);
        }
      } catch (e) {
        console.error('Error parsing stored user:', e);
      }
    }

    const cachedData = localStorage.getItem('moodleData');
    if (cachedData) {
      try {
        const parsedMoodle = JSON.parse(cachedData);
        const allTeaching =
          parsedMoodle?.courses?.length > 0 &&
          parsedMoodle.courses.every(
            (c: { isTeacher?: boolean; role?: string }) =>
              c.isTeacher ||
              c.role === 'editingteacher' ||
              c.role === 'teacher' ||
              c.role === 'manager' ||
              c.role === 'coursecreator'
          );
        if (allTeaching) {
          router.replace('/home');
          return;
        }
        setMoodle(parsedMoodle);
      } catch (e) {
        console.error('Error parsing cached moodle data:', e);
      }
    } else {
      void sync();
    }
  }, [router]);

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/moodle', { credentials: 'omit' });
      if (res.ok) {
        const data: MoodleData = await res.json();
        const allTeaching =
          data?.courses?.length > 0 &&
          data.courses.every(
            c =>
              c.isTeacher ||
              c.role === 'editingteacher' ||
              c.role === 'teacher' ||
              c.role === 'manager' ||
              c.role === 'coursecreator'
          );
        if (allTeaching) {
          router.replace('/home');
          return;
        }
        setMoodle(data);
        localStorage.setItem('moodleData', JSON.stringify(data));
        localStorage.setItem('moodleDataSyncedAt', String(Date.now()));
      }
    } catch (e) {
      console.error('Failed to sync Moodle data:', e);
    } finally {
      setSyncing(false);
    }
  };

  const handleLogout = async () => {
    try {
      await unregisterFcmToken(user?.id);
    } catch (e) {
      console.warn('FCM unregister error on logout:', e);
    }
    localStorage.removeItem('moodleToken');
    localStorage.removeItem('moodleUser');
    localStorage.removeItem('moodleData');
    localStorage.removeItem('moodleDataSyncedAt');
    router.push('/login');
  };

  const moodleCourses = (moodle?.courses ?? []).map(c => ({
    id: c.id,
    name: c.fullname,
    code: c.shortname,
    role: c.role,
    isTeacher: Boolean(c.isTeacher),
  }));

  const lmsProfileUrl = useMemo(() => {
    let baseUrl = moodle?.moodleUrl;
    if (!baseUrl && moodle?.resources?.length) {
      const resWithUrl = moodle.resources.find(
        r => r.url && (r.url.startsWith('http://') || r.url.startsWith('https://'))
      );
      if (resWithUrl?.url) {
        try {
          baseUrl = new URL(resWithUrl.url).origin;
        } catch {}
      }
    }
    const cleanBase = (baseUrl || 'https://moodletvk.duckdns.org').replace(/\/$/, '');
    if (user?.id) {
      return `${cleanBase}/user/profile.php?id=${user.id}`;
    }
    return `${cleanBase}/user/profile.php`;
  }, [moodle?.moodleUrl, moodle?.resources, user?.id]);

  return (
    <main className="app-shell">
      <CourseTopBar
        search={search}
        onSearchChange={setSearch}
        searchRef={searchRef}
        syncing={syncing}
        onSync={() => void sync()}
        notifications={notifications}
        onToggleNotifications={() => setNotifications(!notifications)}
        onCloseNotifications={() => setNotifications(false)}
        notificationPermission={notificationPermission}
        courses={moodleCourses}
        user={user}
        displayName={user?.fullname || 'Student'}
        onOpenProfile={() => setProfile(true)}
        lmsUrl={moodle?.moodleUrl || 'http://moodle.test'}
      />

      <section
        style={{
          maxWidth: '1440px',
          margin: '0 auto',
          padding: '88px 2.5rem 4rem',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <CoursesView
          moodle={moodle}
          onSync={() => void sync()}
          syncing={syncing}
          onBack={() => router.push('/home')}
          openCourse={(c: Course) =>
            router.push(
              `/course?code=${encodeURIComponent(c.code)}&name=${encodeURIComponent(c.name)}&id=${c.id ?? ''}`
            )
          }
          onOpenTeacherCourse={(c: Course) =>
            router.push(
              `/course?code=${encodeURIComponent(c.code)}&name=${encodeURIComponent(c.name)}&id=${c.id ?? ''}&mode=teacher`
            )
          }
        />
      </section>

      {/* Profile Modal */}
      {profile && (
        <div
          className="modal-backdrop"
          onClick={() => setProfile(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            className="modal-content"
            onClick={e => e.stopPropagation()}
            style={{
              background: '#13121a',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '16px',
              padding: '1.75rem',
              width: '90%',
              maxWidth: '420px',
            }}
          >
            <div className="profile-modal">
              <span className="profile-avatar large">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" />
                ) : (
                  (user?.fullname || 'Student').slice(0, 2).toUpperCase()
                )}
              </span>
              <h3>{user?.fullname || 'Student'}</h3>
              <p>{user?.username || 'Sinh viên'}</p>
              <div style={{ marginTop: '1.25rem', display: 'flex', gap: '8px', justifyContent: 'center' }}>
                <a
                  href={lmsProfileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setProfile(false)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '0.5rem 1rem',
                    borderRadius: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    background: 'rgba(255, 255, 255, 0.05)',
                    color: '#e2e8f0',
                    textDecoration: 'none',
                    cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  <ShieldCheck size={14} />
                  Thông tin tài khoản
                </a>
                <button
                  type="button"
                  className="logout-btn"
                  style={{
                    background: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '0.5rem 1rem',
                    cursor: 'pointer',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '13px',
                  }}
                  onClick={handleLogout}
                >
                  <ExternalLink size={14} />
                  Đăng xuất
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default function CoursesPage() {
  return (
    <Suspense fallback={<div className="loading-state">Đang tải danh sách khóa học...</div>}>
      <CoursesPageContent />
    </Suspense>
  );
}

