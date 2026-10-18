'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ChevronDown, Check, Search, X, BookOpen, GraduationCap, Home, LayoutGrid } from 'lucide-react';
import type { Course } from '@/app/types';

interface CourseSwitcherProps {
  activeCourse: Course;
  allCourses: Course[];
  onSelectCourse: (course: Course) => void;
  subtitle?: React.ReactNode;
  className?: string;
}

export function CourseSwitcher({
  activeCourse,
  allCourses,
  onSelectCourse,
  subtitle,
  className = '',
}: CourseSwitcherProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Mount detection & mobile viewport detection
  useEffect(() => {
    setMounted(true);
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 680);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Calculate desktop popover position
  const updatePosition = () => {
    if (!triggerRef.current || isMobile) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const dropdownWidth = 380;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - dropdownWidth - 16));
    setPopoverPos({
      top: rect.bottom + 6,
      left,
    });
  };

  const toggleDropdown = () => {
    if (!isOpen) {
      updatePosition();
      setSearchQuery('');
    }
    setIsOpen(prev => !prev);
  };

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside, { passive: true });
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Lock body scroll when mobile sheet is open
  useEffect(() => {
    if (isOpen && isMobile) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen, isMobile]);

  // Auto focus search input on desktop only (prevents virtual keyboard popping open on mobile)
  useEffect(() => {
    if (isOpen && !isMobile && allCourses.length > 3) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen, isMobile, allCourses.length]);

  const filteredCourses = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allCourses;
    return allCourses.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q)
    );
  }, [allCourses, searchQuery]);

  const handleSelect = (course: Course) => {
    setIsOpen(false);
    if (course.code !== activeCourse.code) {
      onSelectCourse(course);
    }
  };

  return (
    <div className={`course-switcher-wrapper ${className}`}>
      {/* Interactive Trigger (Title + Chevron Button) */}
      <div
        ref={triggerRef}
        className={`course-switcher-trigger ${isOpen ? 'active' : ''}`}
        onClick={toggleDropdown}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDropdown();
          }
        }}
        title="Nhấn để chuyển đổi môn học"
      >
        <h1 className="course-switcher-title">{activeCourse.name}</h1>
        <button
          type="button"
          className="course-switcher-chevron-btn"
          aria-label="Danh sách môn học"
          tabIndex={-1}
        >
          <ChevronDown
            size={14}
            className={`course-switcher-chevron-icon ${isOpen ? 'rotated' : ''}`}
          />
        </button>
      </div>

      {/* Popover / Mobile Bottom Sheet Portal */}
      {mounted && isOpen && createPortal(
        <div className={`course-switcher-portal-root ${isMobile ? 'mobile-mode' : 'desktop-mode'}`}>
          {/* Backdrop */}
          <div
            className="course-switcher-backdrop"
            onClick={() => setIsOpen(false)}
          />

          {/* Dialog Container */}
          <div
            ref={panelRef}
            className={`course-switcher-panel ${isMobile ? 'mobile-sheet' : 'desktop-popover'}`}
            style={
              !isMobile
                ? {
                    top: `${popoverPos.top}px`,
                    left: `${popoverPos.left}px`,
                  }
                : undefined
            }
            role="dialog"
            aria-modal="true"
            aria-label="Chuyển khóa học"
          >
            {isMobile && <div className="course-sheet-handle-bar" />}

            {/* Panel Header */}
            <div className="course-switcher-panel-header">
              <div className="course-switcher-header-title">
                <BookOpen size={16} className="course-switcher-header-icon" />
                <strong>Chuyển khóa học</strong>
                <span className="course-switcher-count-badge">
                  {allCourses.length} môn
                </span>
              </div>
              <button
                type="button"
                className="course-switcher-close-btn"
                onClick={() => setIsOpen(false)}
                aria-label="Đóng bảng chọn môn học"
              >
                <X size={16} />
              </button>
            </div>

            {/* Search Input (if more than 3 courses) */}
            {allCourses.length > 3 && (
              <div className="course-switcher-search-box">
                <Search size={14} className="course-switcher-search-icon" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Tìm theo tên hoặc mã môn..."
                  className="course-switcher-search-input"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="course-switcher-search-clear"
                    onClick={() => setSearchQuery('')}
                    aria-label="Xóa tìm kiếm"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}

            {/* Course List */}
            <div className="course-switcher-list">
              {filteredCourses.length === 0 ? (
                <div className="course-switcher-empty">
                  Không tìm thấy môn học nào phù hợp.
                </div>
              ) : (
                filteredCourses.map(course => {
                  const isActive = course.code.toLowerCase() === activeCourse.code.toLowerCase();
                  return (
                    <button
                      key={course.code}
                      type="button"
                      className={`course-switcher-item ${isActive ? 'is-active' : ''}`}
                      onClick={() => handleSelect(course)}
                    >
                      <div className="course-switcher-item-content">
                        <div className="course-switcher-item-name">
                          {course.name}
                        </div>
                        <div className="course-switcher-item-meta">
                          <span className="course-switcher-item-code">
                            Mã môn: {course.code}
                          </span>
                          {course.isTeacher && (
                            <span className="course-switcher-item-role">
                              <GraduationCap size={10} />
                              Giảng viên
                            </span>
                          )}
                        </div>
                      </div>

                      {isActive && (
                        <div className="course-switcher-item-check" title="Đang học">
                          <Check size={16} />
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Switcher Footer */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                background: 'rgba(255, 255, 255, 0.02)',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  router.push('/home');
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  transition: 'color 0.2s',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = '#94a3b8')}
              >
                <Home size={13} />
                <span>Về trang chủ</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  router.push('/courses');
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#818cf8',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  transition: 'color 0.2s',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#a5b4fc')}
                onMouseLeave={e => (e.currentTarget.style.color = '#818cf8')}
              >
                <LayoutGrid size={13} />
                <span>Tất cả khóa học</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
