'use client';

import type { CSSProperties } from 'react';
import {
  Clock,
  ArrowRight,
  FileText,
  Award,
  Calendar,
} from 'lucide-react';
import type { Course } from '@/app/types';

export interface CourseCardProps {
  course: Course;
  onOpen: () => void;
  resourcesCount?: number;
  latestGrade?: {
    name?: string;
    score: number;
    maxScore: number;
    passed?: boolean;
    percentage?: string;
  } | null;
  pendingHomeworkCount?: number;
  showDetails?: boolean;
}

export function CourseCard({
  course: c,
  onOpen,
  resourcesCount,
  latestGrade,
  pendingHomeworkCount,
  showDetails = false,
}: CourseCardProps) {
  const accent = c.color || '#b92b47';

  return (
    <article
      className="course-card clean-course-card"
      style={
        {
          '--course-color': accent,
          borderColor: `${accent}b8`,
        } as CSSProperties
      }
    >
      <div className="course-card-inner">
        <div className="course-card-header">
          <span
            className="clean-course-code"
            style={{
              color: accent,
              background: `${accent}18`,
              borderColor: `${accent}38`,
            }}
          >
            {(c.code || String(c.id || '')).toUpperCase()}
          </span>
        </div>

        <div className="course-body">
          <h3 className="clean-course-title" title={c.name}>
            {c.name}
          </h3>

          {showDetails ? (
            <div className="course-card-stats">
              <div className="course-stat-item">
                <span className="course-stat-label">
                  <FileText size={11} /> Tài liệu
                </span>
                <strong className="course-stat-value" style={{ color: '#e2e8f0' }}>
                  {typeof resourcesCount === 'number' ? resourcesCount : 0}
                </strong>
              </div>

              <div className="course-stat-item course-stat-grade">
                <span className="course-stat-label">
                  <Award size={11} /> Điểm gần nhất
                </span>
                <strong
                  className="course-stat-value"
                  style={{
                    color: latestGrade
                      ? latestGrade.passed
                        ? '#4ade80'
                        : '#f87171'
                      : '#64748b',
                  }}
                >
                  {latestGrade ? `${latestGrade.score}/${latestGrade.maxScore}` : '—'}
                </strong>
              </div>

              <div className="course-stat-item">
                <span className="course-stat-label">
                  <Calendar size={11} /> Bài tập
                </span>
                <strong
                  className="course-stat-value"
                  style={{
                    color: (pendingHomeworkCount ?? 0) > 0 ? '#fbbf24' : '#94a3b8',
                  }}
                >
                  {(pendingHomeworkCount ?? 0) > 0 ? `${pendingHomeworkCount} cần làm` : '0'}
                </strong>
              </div>
            </div>
          ) : (
            <p className="clean-course-meta">
              <Clock size={12} />
              <span>{c.next || 'Mở khóa học'}</span>
            </p>
          )}

          <div style={{ marginTop: 'auto', paddingTop: '8px' }}>
            <button
              type="button"
              className="clean-course-cta"
              onClick={onOpen}
            >
              <span>{showDetails ? 'Mở khóa học' : 'Vào học'}</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export default CourseCard;
