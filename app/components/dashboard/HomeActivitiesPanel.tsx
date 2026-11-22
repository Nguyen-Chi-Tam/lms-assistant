'use client';

import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileCheck2,
  Flame,
  RotateCcw,
  UserCheck,
  XCircle,
} from 'lucide-react';
import type { Course, MoodleActivityItem } from '@/app/types';
import { MonthCalendar } from '@/app/components/ui/MonthCalendar';

interface HomeActivitiesPanelProps {
  courses: Course[];
  activities: MoodleActivityItem[];
  syncing?: boolean;
  onSync?: () => void;
  onOpenCourse: (course: { id?: number; code?: string; name: string }) => void;
}

type TypeFilter = 'all' | 'homework' | 'attendance' | 'quiz';
type StatusFilter = 'all' | 'action_needed' | 'missed' | 'completed';

function formatDateTime(ms?: number | null) {
  if (!ms) return 'Không giới hạn';
  return new Date(ms).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function typeLabel(type: MoodleActivityItem['type']) {
  if (type === 'homework') return 'Bài tập';
  if (type === 'attendance') return 'Điểm danh';
  return 'Kiểm tra';
}

function statusMeta(item: MoodleActivityItem) {
  if (item.status === 'completed') {
    return { label: item.type === 'homework' ? 'Đã nộp' : 'Đã hoàn thành', cls: 'completed' };
  }
  if (item.status === 'open_now') {
    return { label: item.type === 'attendance' ? 'Đang mở điểm danh' : 'Đang mở', cls: 'open-now' };
  }
  if (item.status === 'missed') {
    return {
      label: item.type === 'attendance' ? 'Đã qua / Quên điểm danh' : 'Chưa làm · Quá hạn',
      cls: 'missed',
    };
  }
  return { label: 'Sắp tới', cls: 'pending' };
}

function isPendingUnended(item: MoodleActivityItem, nowMs: number) {
  if (item.status === 'completed' || item.status === 'missed') return false;
  if (item.closeTimestamp && item.closeTimestamp < nowMs) return false;
  return item.status === 'pending' || item.status === 'open_now';
}

function getActivitySortTimestamp(item: MoodleActivityItem) {
  if (item.status === 'completed' && item.submittedAt) {
    return item.submittedAt;
  }
  return item.closeTimestamp || item.timestamp || item.openTimestamp || 0;
}

export function HomeActivitiesPanel({
  courses,
  activities,
  syncing = false,
  onSync,
  onOpenCourse,
}: HomeActivitiesPanelProps) {
  const [selectedCourseId, setSelectedCourseId] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const listRef = useRef<HTMLDivElement>(null);

  const handleSelectCourse = (courseIdStr: string) => {
    setSelectedCourseId(prev => (prev === courseIdStr ? 'all' : courseIdStr));
    if (typeof window !== 'undefined' && window.innerWidth <= 1000) {
      window.setTimeout(() => {
        listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 40);
    }
  };

  const courseStats = useMemo(() => {
    const map = new Map<
      number,
      {
        courseId: number;
        courseName: string;
        courseCode: string;
        missedHomework: number;
        missedAttendance: number;
        pendingOrOpen: number;
        completed: number;
        total: number;
      }
    >();

    for (const c of courses) {
      if (!c.id) continue;
      map.set(Number(c.id), {
        courseId: Number(c.id),
        courseName: c.name,
        courseCode: c.code,
        missedHomework: 0,
        missedAttendance: 0,
        pendingOrOpen: 0,
        completed: 0,
        total: 0,
      });
    }

    for (const act of activities) {
      let entry = map.get(act.courseId);
      if (!entry) {
        entry = {
          courseId: act.courseId,
          courseName: act.courseName,
          courseCode: act.courseCode,
          missedHomework: 0,
          missedAttendance: 0,
          pendingOrOpen: 0,
          completed: 0,
          total: 0,
        };
        map.set(act.courseId, entry);
      }
      entry.total += 1;
      if (act.status === 'completed') entry.completed += 1;
      else if (act.status === 'missed') {
        if (act.type === 'attendance') entry.missedAttendance += 1;
        else if (act.type === 'homework') entry.missedHomework += 1;
      } else {
        entry.pendingOrOpen += 1;
      }
    }

    return Array.from(map.values());
  }, [courses, activities]);

  const scopedActivities = useMemo(() => {
    const nowMs = Date.now();
    return activities
      .filter(act => {
        if (selectedCourseId !== 'all' && String(act.courseId) !== selectedCourseId) return false;
        if (typeFilter !== 'all' && act.type !== typeFilter) return false;
        if (statusFilter === 'action_needed' && !isPendingUnended(act, nowMs)) return false;
        if (statusFilter === 'missed' && act.status !== 'missed') return false;
        if (statusFilter === 'completed' && act.status !== 'completed') return false;
        return true;
      })
      .sort((a, b) => {
        const aPending = isPendingUnended(a, nowMs);
        const bPending = isPendingUnended(b, nowMs);
        if (aPending !== bPending) {
          return aPending ? -1 : 1;
        }
        return getActivitySortTimestamp(b) - getActivitySortTimestamp(a);
      });
  }, [activities, selectedCourseId, typeFilter, statusFilter]);

  const scopeSummary = useMemo(() => {
    const base = selectedCourseId === 'all'
      ? activities
      : activities.filter(a => String(a.courseId) === selectedCourseId);
    return {
      openNow: base.filter(a => a.status === 'open_now').length,
      pending: base.filter(a => a.status === 'pending' || a.status === 'open_now').length,
      missedHomework: base.filter(a => a.type === 'homework' && a.status === 'missed').length,
      missedAttendance: base.filter(a => a.type === 'attendance' && a.status === 'missed').length,
      completed: base.filter(a => a.status === 'completed').length,
    };
  }, [activities, selectedCourseId]);

  const criticalCourses = useMemo(() => {
    return courseStats.filter(s => s.missedAttendance >= 2 || s.missedHomework >= 1);
  }, [courseStats]);

  const calendarPendingDates = useMemo(() => {
    const now = new Date();
    const base = selectedCourseId === 'all'
      ? activities
      : activities.filter(a => String(a.courseId) === selectedCourseId);
    return base
      .filter(a => a.status !== 'completed')
      .map(a => new Date(a.closeTimestamp || a.timestamp))
      .filter(d => d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear())
      .map(d => d.getDate());
  }, [activities, selectedCourseId]);

  const missedHomeworkItems = useMemo(
    () => activities.filter(a => a.type === 'homework' && a.status === 'missed'),
    [activities]
  );

  const missedAttendanceItems = useMemo(
    () => activities.filter(a => a.type === 'attendance' && a.status === 'missed'),
    [activities]
  );

  return (
    <div className="page fade-in home-activities-page">
      <section className="hero-row">
        <div>
          <h1>Hoạt động</h1>
          <p className="subtitle">
            Quản lý bài tập, kiểm tra và lịch điểm danh
          </p>
        </div>
        {onSync && (
          <button
            type="button"
            className="home-learning-dashboard-history"
            onClick={onSync}
            disabled={syncing}
          >
            <RotateCcw size={14} className={syncing ? 'animate-spin' : ''} />
            <span>{syncing ? 'Đang đồng bộ…' : 'Làm mới'}</span>
          </button>
        )}
      </section>

      {/* Crucial Warning Banner for Missed Attendance & Undone Homework */}
      {(missedHomeworkItems.length > 0 || missedAttendanceItems.length > 0 || scopeSummary.openNow > 0) && (
        <section className="activity-warning-banner" role="alert">
          <div className="activity-warning-icon">
            <AlertTriangle size={18} />
          </div>
          <div className="activity-warning-body">
            <strong>
              {missedAttendanceItems.length > 0 || missedHomeworkItems.length > 0
                ? 'Cần xử lý'
                : 'Đang mở ngay'}
            </strong>
            <div className="activity-warning-details">
              {missedHomeworkItems.length > 0 && (
                <span>
                  • Có <b>{missedHomeworkItems.length} bài tập về nhà chưa nộp / quá hạn</b>:{' '}
                  {missedHomeworkItems.slice(0, 3).map(h => `${h.courseCode}: ${h.name}`).join(', ')}
                  {missedHomeworkItems.length > 3 ? '…' : ''}
                </span>
              )}
              {missedAttendanceItems.length > 0 && (
                <span>
                  • Ghi nhận <b>{missedAttendanceItems.length} buổi điểm danh đã qua</b>
                  {criticalCourses.some(c => c.missedAttendance >= 2)
                    ? ` (Cảnh báo: ${criticalCourses
                        .filter(c => c.missedAttendance >= 2)
                        .map(c => `${c.courseName} vắng/bỏ lỡ ${c.missedAttendance} buổi`)
                        .join('; ')})`
                    : ''}
                </span>
              )}
              {scopeSummary.openNow > 0 && (
                <span>• Hiện có <b>{scopeSummary.openNow} hoạt động đang mở</b> có thể làm / điểm danh ngay!</span>
              )}
            </div>
          </div>
          {(missedHomeworkItems.length > 0 || missedAttendanceItems.length > 0) && (
            <button
              type="button"
              className="activity-warning-btn"
              onClick={() => setStatusFilter(statusFilter === 'missed' ? 'all' : 'missed')}
            >
              {statusFilter === 'missed' ? 'Xem tất cả' : 'Lọc mục bỏ lỡ'}
            </button>
          )}
        </section>
      )}

      {/* Summary KPI Strip */}
      <section className="activity-kpi-strip">
        <div className="activity-kpi-card">
          <span>Cần làm / Sắp tới</span>
          <strong className="kpi-cyan">{scopeSummary.pending}</strong>
          <small>{scopeSummary.openNow > 0 ? `${scopeSummary.openNow} đang mở ngay` : 'Bài tập, quiz & điểm danh'}</small>
        </div>
        <div className={`activity-kpi-card ${scopeSummary.missedHomework > 0 ? 'danger' : ''}`}>
          <span>Bài tập chưa nộp</span>
          <strong className="kpi-red">{scopeSummary.missedHomework}</strong>
          <small>{scopeSummary.missedHomework > 0 ? 'Cần hoàn thành gấp' : 'Không có bài tập trễ'}</small>
        </div>
        <div className={`activity-kpi-card ${scopeSummary.missedAttendance >= 2 ? 'danger' : ''}`}>
          <span>Điểm danh đã qua / lỡ</span>
          <strong className={scopeSummary.missedAttendance >= 2 ? 'kpi-red' : 'kpi-amber'}>
            {scopeSummary.missedAttendance}
          </strong>
          <small>
            {scopeSummary.missedAttendance >= 2
              ? 'Cảnh báo: Vắng từ 2 buổi trở lên'
              : 'Theo dõi chuyên cần trên LMS'}
          </small>
        </div>
        <div className="activity-kpi-card">
          <span>Đã hoàn thành</span>
          <strong className="kpi-green">{scopeSummary.completed}</strong>
          <small>Đã nộp bài hoặc có điểm</small>
        </div>
      </section>

      {/* Type & Status Filter Bar */}
      <section className="activity-filter-bar">
        <div className="activity-subfilters">
          <div className="activity-seg">
            {(
              [
                ['all', 'Tất cả'],
                ['homework', 'Bài tập'],
                ['attendance', 'Điểm danh'],
                ['quiz', 'Kiểm tra'],
              ] as Array<[TypeFilter, string]>
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                className={typeFilter === k ? 'active' : ''}
                onClick={() => setTypeFilter(k)}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="activity-seg">
            {(
              [
                ['all', 'Mọi trạng thái'],
                ['action_needed', 'Cần làm'],
                ['missed', 'Bỏ lỡ / Chưa làm'],
                ['completed', 'Đã xong'],
              ] as Array<[StatusFilter, string]>
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                className={statusFilter === k ? 'active' : ''}
                onClick={() => setStatusFilter(k)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="home-activity-grid">
        <div className="home-activity-side">
          <MonthCalendar pendingDates={calendarPendingDates} />

          {/* Per-course breakdown */}
          <article className="deadline-card" style={{ marginTop: '16px' }}>
            <div className="section-head compact">
              <div>
                <h2>Tổng kết theo môn</h2>
                <p>Nhấn vào môn để lọc hoạt động</p>
              </div>
              {selectedCourseId !== 'all' && (
                <button type="button" onClick={() => setSelectedCourseId('all')}>
                  Tất cả
                </button>
              )}
            </div>
            <div className="activity-course-summary-list">
              {courseStats.map(cs => (
                <button
                  key={cs.courseId}
                  type="button"
                  className={`activity-course-summary-row ${selectedCourseId === String(cs.courseId) ? 'active' : ''}`}
                  onClick={() => handleSelectCourse(String(cs.courseId))}
                >
                  <div className="activity-course-summary-info">
                    <strong>{cs.courseCode || cs.courseName}</strong>
                    <small>{cs.courseName}</small>
                  </div>
                  <div className="activity-course-summary-badges">
                    {cs.missedAttendance > 0 && (
                      <span className="mini-badge red" title="Buổi điểm danh đã qua">
                        <UserCheck size={11} /> {cs.missedAttendance}
                      </span>
                    )}
                    {cs.missedHomework > 0 && (
                      <span className="mini-badge amber" title="Bài tập chưa nộp">
                        <XCircle size={11} /> {cs.missedHomework}
                      </span>
                    )}
                    {cs.missedAttendance === 0 && cs.missedHomework === 0 && (
                      <span className="mini-badge green">
                        <CheckCircle2 size={11} />
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </article>
        </div>

        <div className="home-activity-lists" ref={listRef}>
          <article className="deadline-card">
            <div className="section-head compact">
              <div>
                <h2>Danh sách hoạt động ({scopedActivities.length})</h2>
                <p>Chọn mục để mở trên Moodle</p>
              </div>
            </div>

            {scopedActivities.length === 0 ? (
              <div className="empty-state" style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#94a3b8' }}>
                <CalendarClock size={32} style={{ margin: '0 auto 0.5rem', opacity: 0.6 }} />
                <p style={{ margin: 0, fontWeight: 600, color: '#e2e8f0' }}>Không có hoạt động nào khớp bộ lọc</p>
                <small>Thử chọn &ldquo;Tất cả môn học&rdquo; hoặc đồng bộ lại dữ liệu từ Moodle.</small>
              </div>
            ) : (
              <div className="activity-cards-list">
                {scopedActivities.map(act => {
                  const nowMs = Date.now();
                  const isPending = isPendingUnended(act, nowMs);
                  const st = statusMeta(act);
                  const TypeIcon =
                    act.type === 'attendance' ? UserCheck : act.type === 'quiz' ? Flame : FileCheck2;
                  const showOpenCourseBtn = isPending && (act.type === 'homework' || act.type === 'quiz');
                  const ctaLabel = !isPending
                    ? act.status === 'completed'
                      ? 'Xem lại trên LMS'
                      : 'Mở trên LMS'
                    : act.type === 'attendance'
                      ? 'Điểm danh ngay'
                      : act.type === 'quiz'
                        ? 'Vào làm bài thi'
                        : 'Làm & Nộp bài';

                  return (
                    <div key={act.id} className={`activity-row-card ${st.cls}`}>
                      <div className="activity-row-left">
                        <span className={`activity-type-badge ${act.type}`}>
                          <TypeIcon size={16} />
                        </span>
                        <div className="activity-row-info">
                          <div className="activity-row-tags">
                            <span className="result-course-code">{(act.courseCode || 'MOODLE').toUpperCase()}</span>
                            <span className="activity-kind-tag">{typeLabel(act.type)}</span>
                            <span className={`activity-status-pill ${st.cls}`}>{st.label}</span>
                          </div>
                          <strong>{act.name}</strong>
                          <small>
                            {act.courseName} ·{' '}
                            {act.status === 'completed' && act.submittedAt
                              ? `Hoàn thành lúc ${formatDateTime(act.submittedAt)}`
                              : `${act.type === 'attendance' ? 'Thời gian' : 'Hạn chót'}: ${formatDateTime(act.closeTimestamp || act.timestamp)}`}
                            {act.score !== null && act.score !== undefined
                              ? ` · Điểm: ${act.score}/${act.maxScore ?? 10}`
                              : ''}
                          </small>
                        </div>
                      </div>

                      <div className="activity-row-actions">
                        {showOpenCourseBtn && (
                          <button
                            type="button"
                            className="activity-course-btn"
                            onClick={() => onOpenCourse({ id: act.courseId, code: act.courseCode, name: act.courseName })}
                            title="Mở không gian học AI của môn này"
                          >
                            <BookOpen size={13} />
                            <span>Ôn tập AI</span>
                          </button>
                        )}
                        <a
                          href={act.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`activity-lms-btn ${isPending ? 'urgent' : ''}`}
                        >
                          <span>{ctaLabel}</span>
                          <ExternalLink size={13} />
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}
