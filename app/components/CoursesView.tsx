'use client';

import { useState, useMemo } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import type { Course, MoodleData } from '@/app/types';
import { CourseCard } from '@/app/components/CourseCard';

export const defaultCourseColors = ['#6c5ce7', '#ff8a65', '#20bfa9', '#3b82f6', '#ec4899', '#f59e0b'];

export interface CoursesViewProps {
  moodle: MoodleData | null;
  onSync?: () => void;
  openCourse: (course: Course) => void;
  syncing?: boolean;
  onOpenTeacherCourse?: (course: Course) => void;
  onBack?: () => void;
}

export function CoursesView({
  moodle,
  onSync,
  openCourse,
  syncing,
  onOpenTeacherCourse,
}: CoursesViewProps) {
  const [search, setSearch] = useState('');

  const data: Course[] = moodle?.courses?.length
    ? moodle.courses.map((m, i) => {
        const isTeacher =
          m.role === 'editingteacher' ||
          m.role === 'teacher' ||
          m.role === 'manager' ||
          m.role === 'coursecreator' ||
          m.role === 'admin' ||
          Boolean(m.isTeacher);
        return {
          id: m.id,
          code: m.shortname,
          name: m.fullname,
          progress: m.progress ?? 0,
          color: defaultCourseColors[i % defaultCourseColors.length],
          icon: m.shortname.slice(0, 2).toUpperCase(),
          next: isTeacher ? 'Quản lý khóa học & Giảng dạy' : 'Xem nội dung khóa học',
          role: m.role || (isTeacher ? 'editingteacher' : 'student'),
          isTeacher,
          startdate: m.startdate,
          lastaccess: m.lastaccess,
        };
      })
      .sort((a, b) => {
        if (a.lastaccess && b.lastaccess && a.lastaccess !== b.lastaccess) {
          return b.lastaccess - a.lastaccess;
        }
        if (a.startdate && b.startdate && a.startdate !== b.startdate) {
          return b.startdate - a.startdate;
        }
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      })
    : [];

  const filteredCourses = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.toLowerCase().trim();
    return data.filter(
      c => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
    );
  }, [data, search]);

  const getCourseDetails = (c: Course) => {
    // 1. Sources count
    const resourcesCount = (moodle?.resources ?? []).filter(
      r =>
        (r.courseCode && r.courseCode.toLowerCase() === c.code.toLowerCase()) ||
        (r.courseName && r.courseName.toLowerCase() === c.name.toLowerCase()) ||
        (c.id && r.courseId === Number(c.id))
    ).length;

    // 2. Latest grade (excluding attendance sessions)
    const courseGrades = (moodle?.examResults ?? [])
      .filter(r => {
        const mod = (r.itemModule || '').toLowerCase();
        const name = (r.name || '').toLowerCase();
        if (
          mod === 'attendance' ||
          mod.includes('attendance') ||
          name.includes('attendance') ||
          name.includes('điểm danh')
        ) {
          return false;
        }
        return (
          (c.id && Number(r.courseId) === Number(c.id)) ||
          (r.courseCode && r.courseCode.toLowerCase() === c.code.toLowerCase()) ||
          (r.courseName && r.courseName.toLowerCase() === c.name.toLowerCase())
        );
      })
      .sort((a, b) => (b.gradedAt || 0) - (a.gradedAt || 0));
    const latestGrade = courseGrades[0] || null;

    // 3. Homework / Deadlines
    const now = Date.now();
    const pendingHomeworkCount = (moodle?.deadlines ?? []).filter(d => {
      const isThisCourse =
        (d.courseName && d.courseName.toLowerCase() === c.name.toLowerCase()) ||
        (c.id && (d as { courseId?: number }).courseId && Number((d as { courseId?: number }).courseId) === Number(c.id));
      if (!isThisCourse) return false;
      const dueTime = (d as { closeTimestamp?: number }).closeTimestamp || d.timestamp;
      return dueTime > now;
    }).length;

    return { resourcesCount, latestGrade, pendingHomeworkCount };
  };

  return (
    <div className="workspace-page fade-in">
      <div
        className="workspace-title"
        style={{
          marginBottom: '1.75rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <p className="eyebrow">ĐỒNG BỘ TỪ MOODLE</p>
          <h1>Khóa học của bạn</h1>
          <p>
            {search.trim() && filteredCourses.length !== data.length
              ? `${filteredCourses.length} / ${data.length} khóa học`
              : `${data.length} khóa học`}
          </p>
        </div>

        {/* Search bar for student courses */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            minWidth: '240px',
            maxWidth: '320px',
            width: '100%',
          }}
        >
          <Search
            size={14}
            style={{
              position: 'absolute',
              left: '12px',
              color: '#94a3b8',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            placeholder="Tìm kiếm môn học, mã môn..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%',
              height: '36px',
              padding: '0 30px 0 34px',
              borderRadius: '999px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              background: 'rgba(255, 255, 255, 0.05)',
              color: '#fff',
              fontSize: '13px',
              outline: 'none',
              transition: 'all 0.2s ease',
            }}
            onFocus={e => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
              e.currentTarget.style.borderColor = 'rgba(124, 109, 242, 0.6)';
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(124, 109, 242, 0.15)';
            }}
            onBlur={e => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              style={{
                position: 'absolute',
                right: '10px',
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                fontSize: '13px',
                padding: '2px 4px',
              }}
              title="Xóa tìm kiếm"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {moodle?.message && <div className="integration-note">ⓘ {moodle.message}</div>}

      {data.length === 0 ? (
        <div
          className="empty-state"
          style={{
            padding: '3rem',
            textAlign: 'center',
            background: 'rgba(255, 255, 255, 0.02)',
            borderRadius: '16px',
            border: '1px dashed rgba(255, 255, 255, 0.1)',
            marginTop: '1.5rem',
          }}
        >
          <h3>Không có khóa học nào</h3>
          <p style={{ color: '#94a3b8', margin: '0.5rem 0 1.5rem' }}>
            Dữ liệu khóa học chưa được đồng bộ hoặc tài khoản chưa đăng ký khóa học nào.
          </p>
          {onSync && (
            <button className="primary-action" onClick={onSync}>
              <RotateCcw size={14} style={{ marginRight: '5px' }} /> Đồng bộ LMS ngay
            </button>
          )}
        </div>
      ) : filteredCourses.length === 0 ? (
        <div
          className="empty-state"
          style={{
            padding: '3rem',
            textAlign: 'center',
            background: 'rgba(255, 255, 255, 0.02)',
            borderRadius: '16px',
            border: '1px dashed rgba(255, 255, 255, 0.1)',
            marginTop: '1.5rem',
          }}
        >
          <h3>Không tìm thấy môn học</h3>
          <p style={{ color: '#94a3b8', margin: '0.5rem 0 1.25rem' }}>
            Không có khóa học nào phù hợp với từ khóa &ldquo;{search}&rdquo;.
          </p>
          <button
            type="button"
            className="primary-action"
            onClick={() => setSearch('')}
            style={{ margin: '0 auto' }}
          >
            Xóa bộ lọc tìm kiếm
          </button>
        </div>
      ) : (
        <div className="course-grid">
          {filteredCourses.map(c => {
            const details = getCourseDetails(c);
            return (
              <CourseCard
                key={c.id ?? c.code}
                course={c}
                onOpen={() => openCourse(c)}
                onOpenTeacher={onOpenTeacherCourse}
                showDetails={true}
                resourcesCount={details.resourcesCount}
                latestGrade={details.latestGrade}
                pendingHomeworkCount={details.pendingHomeworkCount}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CoursesView;

