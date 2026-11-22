'use client';

import { useState } from 'react';
import { BarChart3, BookOpen, CalendarClock, ExternalLink, X } from 'lucide-react';
import type { Course, ExamResult } from '@/app/types';

export type DashboardActivity = {
  id: string | number;
  name: string;
  timestamp: number;
  closeTimestamp?: number;
  url?: string;
  type: 'homework' | 'exam' | 'quiz' | 'task';
};

interface LearningDashboardProps {
  course: Course;
  grades: ExamResult[];
  activities: DashboardActivity[];
  lmsCourseUrl: string;
  onClose: () => void;
  onAnalyzeGrade: (grade: ExamResult) => void | Promise<void>;
}

export function LearningDashboard({
  course,
  grades,
  activities,
  lmsCourseUrl,
  onClose,
  onAnalyzeGrade,
}: LearningDashboardProps) {
  const [mobileTab, setMobileTab] = useState<'activities' | 'grades'>('activities');
  const now = Date.now();
  const isUpcoming = (a: DashboardActivity) => (a.closeTimestamp || a.timestamp) >= now;
  const upcomingCount = activities.filter(isUpcoming).length;
  const sortedActivities = [...activities].sort((a, b) => {
    const aUp = isUpcoming(a);
    const bUp = isUpcoming(b);
    if (aUp !== bUp) return aUp ? -1 : 1;
    // Upcoming: soonest first; Past: most recent first
    const aTime = a.closeTimestamp || a.timestamp;
    const bTime = b.closeTimestamp || b.timestamp;
    return aUp ? aTime - bTime : bTime - aTime;
  });
  const sortedGrades = [...grades].sort((a, b) => Number(b.gradedAt || 0) - Number(a.gradedAt || 0));

  return (
    <div className="learning-dashboard-overlay" onClick={onClose}>
      <section
        className="learning-dashboard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="learning-dashboard-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="learning-dashboard-header">
          <div className="learning-dashboard-heading">
            <h2 id="learning-dashboard-title">Bài tập &amp; Bảng điểm</h2>
            <p>{course.name} · dữ liệu đồng bộ từ Moodle</p>
          </div>
          <button type="button" className="learning-dashboard-close" onClick={onClose} aria-label="Đóng">
            <X size={17} />
          </button>
        </header>

        <div className="learning-dashboard-tabs" role="tablist" aria-label="Chuyển mục">
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === 'activities'}
            className={mobileTab === 'activities' ? 'active' : ''}
            onClick={() => setMobileTab('activities')}
          >
            <CalendarClock size={14} />
            <span>Hoạt động</span>
            <em>{upcomingCount}</em>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === 'grades'}
            className={mobileTab === 'grades' ? 'active' : ''}
            onClick={() => setMobileTab('grades')}
          >
            <BarChart3 size={14} />
            <span>Bảng điểm</span>
            <em>{sortedGrades.length}</em>
          </button>
        </div>

        <div className="learning-dashboard-body">
          <div className="learning-dashboard-grid">
            <article className={`learning-dashboard-panel ${mobileTab !== 'activities' ? 'mobile-tab-hidden' : ''}`}>
              <div className="learning-dashboard-panel-title">
                <BookOpen size={17} />
                <span>Bài tập cần làm</span>
                <em>{sortedActivities.filter(isUpcoming).length}</em>
              </div>
              {sortedActivities.length === 0 ? (
                <p className="learning-dashboard-empty">Chưa có hoạt động nào.</p>
              ) : sortedActivities.map(activity => {
                const upcoming = isUpcoming(activity);
                return (
                <a
                  className="learning-activity-row"
                  href={activity.url || lmsCourseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  key={`${activity.id}-${activity.name}`}
                  style={upcoming ? undefined : { opacity: 0.62 }}
                >
                  <span className={upcoming ? 'urgent' : ''}>
                    <BookOpen size={14} />
                  </span>
                  <div>
                    <b>{activity.name}</b>
                    <small>
                      {upcoming ? 'Sắp tới · ' : 'Đã qua · '}
                      {new Date(activity.closeTimestamp || activity.timestamp).toLocaleString('vi-VN', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </small>
                  </div>
                  <ExternalLink size={13} />
                </a>
                );
              })}
            </article>

            <article className={`learning-dashboard-panel ${mobileTab !== 'grades' ? 'mobile-tab-hidden' : ''}`}>
              <div className="learning-dashboard-panel-title">
                <BarChart3 size={17} />
                <span>Bảng điểm</span>
                <em>{sortedGrades.length} đầu điểm</em>
              </div>
              {sortedGrades.length === 0 ? (
                <p className="learning-dashboard-empty">Chưa có điểm từ Moodle.</p>
              ) : sortedGrades.map(grade => {
                const percent = Math.min(100, Math.max(0, (grade.score / (grade.maxScore || 10)) * 100));
                return (
                  <div key={`${grade.id}-${grade.name}`}>
                    <div className="learning-grade-row">
                      <div>
                        <b>{grade.name}</b>
                        <small>{grade.gradedAt ? new Date(grade.gradedAt).toLocaleDateString('vi-VN') : 'Moodle'}</small>
                      </div>
                      <div className="learning-grade-score">
                        <span>{grade.score}/{grade.maxScore}</span>
                        <i><u style={{ width: `${percent}%` }} /></i>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '.4rem', paddingBottom: '.55rem' }}>
                      <a
                        href={grade.url || lmsCourseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '.25rem', padding: '.35rem .55rem', border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, color: '#cbd5e1', background: 'rgba(255,255,255,.04)', fontSize: 11, fontWeight: 600, textDecoration: 'none' }}
                      >
                        Mở trên LMS <ExternalLink size={11} />
                      </a>
                      <button
                        type="button"
                        onClick={() => void onAnalyzeGrade(grade)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '.25rem', padding: '.35rem .55rem', border: '1px solid rgba(185, 43, 71,.35)', borderRadius: 8, color: '#f7cbd4', background: 'rgba(185, 43, 71,.12)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                      >
                        Xem lại phân tích
                      </button>
                    </div>
                  </div>
                );
              })}
            </article>
          </div>
        </div>
      </section>
    </div>
  );
}
