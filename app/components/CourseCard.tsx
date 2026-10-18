'use client';

import type { CSSProperties } from 'react';
import {
  GraduationCap,
  BookOpen,
  Clock,
  Settings,
  Sparkles,
  ArrowRight,
  FileText,
  Award,
  Calendar,
} from 'lucide-react';
import type { Course } from '@/app/types';

export interface CourseCardProps {
  course: Course;
  onOpen: () => void;
  onOpenTeacher?: (course: Course) => void;
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
  onOpenTeacher,
  resourcesCount,
  latestGrade,
  pendingHomeworkCount,
  showDetails = false,
}: CourseCardProps) {
  const isTeacher = Boolean(
    c.isTeacher ||
      c.role === 'editingteacher' ||
      c.role === 'teacher' ||
      c.role === 'manager' ||
      c.role === 'coursecreator'
  );

  return (
    <article
      className="course-card full-colored"
      style={
        {
          '--course-color': c.color,
          background: `linear-gradient(145deg, ${c.color}f0 0%, ${c.color}aa 32%, rgba(18, 15, 26, 0.76) 88%)`,
          borderColor: `${c.color}55`,
        } as CSSProperties
      }
    >
      <div className="course-card-inner">
        <div className="course-card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span className="course-card-badge" style={{ display: 'inline-flex', alignItems: 'center' }}>
              <Sparkles size={12} />
            </span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: 'rgba(255, 255, 255, 0.9)',
                letterSpacing: '0.5px',
              }}
            >
              {(c.code || String(c.id || '')).toUpperCase()}
            </span>
          </div>

          {/* Role badge */}
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: '12px',
              background: isTeacher ? 'rgba(124, 109, 242, 0.35)' : 'rgba(255, 255, 255, 0.12)',
              color: isTeacher ? '#e0d8ff' : 'rgba(255, 255, 255, 0.8)',
              border: isTeacher ? '1px solid rgba(124, 109, 242, 0.6)' : '1px solid rgba(255, 255, 255, 0.1)',
              letterSpacing: '0.3px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {isTeacher ? <GraduationCap size={12} /> : <BookOpen size={12} />}
            <span>{isTeacher ? 'Giảng dạy' : 'Học tập'}</span>
          </span>
        </div>

        <div className="course-body">
          <h3 style={{ margin: '0 0 6px', fontSize: showDetails ? '16px' : '17px', fontWeight: 700, lineHeight: 1.35 }}>
            {c.name}
          </h3>

          {showDetails ? (
            <>
              {/* Course stats panel - adapts to rows on half desktop screens */}
              <div className="course-card-stats">
                {/* 1. Resources */}
                <div className="course-stat-item">
                  <span className="course-stat-label">
                    <FileText size={11} style={{ opacity: 0.85 }} /> Tài liệu
                  </span>
                  <strong className="course-stat-value" style={{ color: '#f8fafc' }}>
                    {typeof resourcesCount === 'number' ? `${resourcesCount} tệp` : '0 tệp'}
                  </strong>
                </div>

                {/* 2. Latest Grade */}
                <div className="course-stat-item course-stat-grade">
                  <span className="course-stat-label">
                    <Award size={11} style={{ opacity: 0.85 }} /> Điểm gần nhất
                  </span>
                  <strong
                    className="course-stat-value"
                    style={{
                      color: latestGrade
                        ? latestGrade.passed
                          ? '#4ade80'
                          : '#f87171'
                        : 'rgba(255, 255, 255, 0.45)',
                    }}
                  >
                    {latestGrade ? `${latestGrade.score}/${latestGrade.maxScore}` : 'Chưa có'}
                  </strong>
                </div>

                {/* 3. Homework / Deadline */}
                <div className="course-stat-item">
                  <span className="course-stat-label">
                    <Calendar size={11} style={{ opacity: 0.85 }} /> Bài tập
                  </span>
                  <strong
                    className="course-stat-value"
                    style={{
                      color: (pendingHomeworkCount ?? 0) > 0 ? '#fbbf24' : '#94a3b8',
                    }}
                  >
                    {(pendingHomeworkCount ?? 0) > 0 ? `${pendingHomeworkCount} cần làm` : 'Không có'}
                  </strong>
                </div>
              </div>
            </>
          ) : (
            <p style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Clock size={12} style={{ opacity: 0.7 }} />
              <span>{c.next || 'Xem nội dung khóa học'}</span>
            </p>
          )}

          <div style={{ marginTop: 'auto', paddingTop: '4px' }}>
            {isTeacher ? (
              <button
                className="liquid-glass-btn"
                onClick={e => {
                  e.stopPropagation();
                  if (onOpenTeacher) onOpenTeacher(c);
                  else onOpen();
                }}
                title="Mở Bảng điểm & Tạo đề Moodle XML"
                style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '10px 18px' }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <Settings size={13} />
                  <span>Điểm &amp; Quiz</span>
                </span>
                <ArrowRight size={13} />
              </button>
            ) : (
              <button
                className="liquid-glass-btn"
                onClick={onOpen}
                style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '10px 18px' }}
              >
                <span>{showDetails ? 'Vào không gian học' : 'Tiếp tục học'}</span>
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export default CourseCard;
