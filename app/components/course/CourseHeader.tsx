'use client';

import React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { Course } from '@/app/types';
import { CourseSwitcher } from './CourseSwitcher';

interface CourseHeaderProps {
  activeCourse: Course;
  allCourses: Course[];
  onSelectCourse: (course: Course) => void;
  className?: string;
}

export function CourseHeader({
  activeCourse,
  allCourses,
  onSelectCourse,
  className = '',
}: CourseHeaderProps) {
  return (
    <header className={`course-header-root ${className}`}>
      <div className="course-header-main-row">
        <nav className="course-breadcrumb" aria-label="Breadcrumb">
          <Link href="/home" className="course-breadcrumb-link">Trang chủ</Link>
          <ChevronRight size={13} className="course-breadcrumb-sep" />
          <Link href="/home?tab=courses" className="course-breadcrumb-link">Khóa học</Link>
          <ChevronRight size={13} className="course-breadcrumb-sep" />
        </nav>
        <CourseSwitcher
          activeCourse={activeCourse}
          allCourses={allCourses}
          onSelectCourse={onSelectCourse}
          subtitle={`Mã môn: ${activeCourse.code || 'Moodle'}`}
        />
      </div>
    </header>
  );
}
