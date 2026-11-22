'use client';

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  BookOpen,
  CheckSquare,
  GraduationCap,
  RotateCcw,
  Clock,
  FileText,
  BarChart3,
  Settings,
  ArrowRight,
  ExternalLink,
  Sparkles,
  MessageSquare,
  CalendarDays,
  ShieldCheck,
  LayoutDashboard,
  CalendarClock,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { CourseCard } from '@/app/components/course/CourseCard';

const QuizAnalysisModal = dynamic(
  () => import('@/app/components/learning/QuizAnalysisModal').then((mod) => mod.QuizAnalysisModal),
  {
    ssr: false,
  }
);
import { ErrorBoundary } from '@/app/components/ui/ErrorBoundary';

import { CourseTopBar, type NotificationItem } from '@/app/components/course/CourseTopBar';
import { SiteFooter } from '@/app/components/ui/SiteFooter';
import { HomeSidebar } from '@/app/components/dashboard/HomeSidebar';
import { HomeLearningDashboard } from '@/app/components/dashboard/HomeLearningDashboard';
import { HomeActivitiesPanel } from '@/app/components/dashboard/HomeActivitiesPanel';
import { CoursesView } from '@/app/components/course/CoursesView';
import {
  getStoredAnalysis,
  saveStoredAnalysis,
  getAllStoredAttemptIds,
  removeStoredAnalysis,
} from '@/app/lib/quiz-client-cache';
import { resolveGradeRoute, formatGrade, buildGradePrompt } from '@/app/lib/grade-router';
import type {
  Course,
  ErrorResponse,
  ExamResult,
  LibraryFile,
  LibraryResponse,
  MoodleData,
  MoodleUser,
  QuizAnalysisData,
  UploadResponse,
} from '@/app/types';
import { ensureFcmTokenRegistered, registerFcmToken, unregisterFcmToken } from '@/app/lib/notification-client';
import { isBlockedAccount } from '@/app/lib/blocked-accounts';
import { useGlassSlider } from '@/app/lib/use-glass-slider';

export type { Course, LibraryFile };

const defaultColors = ['#e11d48', '#f97316', '#eab308', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
const MOODLE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/* ── Helpers ─────────────────────────────────────────────── */

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCurrentDateTime(date: Date) {
  const days = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const dayName = days[date.getDay()];
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');

  return `${dayName}, ${day}/${month}/${year} · ${hours}:${minutes}:${seconds}`;
}

function getGreeting(hour: number) {
  if (hour < 12) return 'Chào buổi sáng';
  if (hour < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

export type DeadlineItem = {
  id: number | string;
  name: string;
  courseName: string;
  courseId?: number | string;
  timestamp: number;
  openTimestamp?: number;
  closeTimestamp?: number;
  url?: string;
  type?: 'homework' | 'exam' | 'quiz' | 'task' | 'manual' | 'attendance';
  modulename?: string;
  eventtype?: string;
  description?: string;
};

export function mergeMoodleDeadlines(
  rawDeadlines: Array<{
    id: number;
    name: string;
    courseName: string;
    timestamp: number;
    url?: string;
    description?: string;
    modulename?: string;
    eventtype?: string;
    type?: string;
  }>
): DeadlineItem[] {
  const groupedMap = new Map<string, DeadlineItem>();

  for (const d of rawDeadlines) {
    const rawName = (d.name || '').trim();
    let baseName = rawName;
    let eventKind: 'open' | 'close' | 'general' = 'general';

    // Detect "opens" or "mở" / "bắt đầu"
    const opensMatch = /(?:\s+opens|\s+mở|\s+bắt đầu)$/i.exec(rawName);
    if (opensMatch) {
      baseName = rawName.slice(0, opensMatch.index).trim();
      eventKind = 'open';
    } else {
      // Detect "closes", "is due", "due", "đóng", "hết hạn", "kết thúc", "hạn chót"
      const closesMatch = /(?:\s+closes|\s+is due|\s+due|\s+đóng|\s+hết hạn|\s+kết thúc|\s+hạn chót)$/i.exec(rawName);
      if (closesMatch) {
        baseName = rawName.slice(0, closesMatch.index).trim();
        eventKind = 'close';
      }
    }

    const lowerBase = baseName.toLowerCase();
    const urlStr = (d.url || '').toLowerCase();
    const modulename = ((d.modulename || '') as string).toLowerCase();

    let type: 'homework' | 'exam' | 'quiz' | 'task' | 'manual' | 'attendance' = 'homework';

    if (d.type === 'manual' || d.eventtype === 'manual') {
      type = 'manual';
    } else if (
      modulename === 'attendance' ||
      urlStr.includes('/mod/attendance/') ||
      lowerBase.includes('attendance') ||
      lowerBase.includes('điểm danh')
    ) {
      type = 'attendance';
    } else if (
      modulename === 'quiz' ||
      urlStr.includes('/mod/quiz/') ||
      lowerBase.includes('quiz') ||
      lowerBase.includes('trắc nghiệm') ||
      lowerBase.includes('kiểm tra') ||
      lowerBase.includes('thi') ||
      lowerBase.includes('exam')
    ) {
      type = lowerBase.includes('trắc nghiệm') || lowerBase.includes('quiz') || modulename === 'quiz' ? 'quiz' : 'exam';
    } else if (
      modulename === 'assign' ||
      urlStr.includes('/mod/assign/') ||
      lowerBase.includes('bài tập') ||
      lowerBase.includes('assignment') ||
      lowerBase.includes('homework') ||
      lowerBase.includes('tiểu luận') ||
      lowerBase.includes('project') ||
      lowerBase.includes('đồ án') ||
      lowerBase.includes('lab')
    ) {
      type = 'homework';
    }

    const key = `${(d.courseName || '').toLowerCase()}::${lowerBase}`;
    const existing = groupedMap.get(key);

    if (existing) {
      if (eventKind === 'open') {
        existing.openTimestamp = d.timestamp;
      } else if (eventKind === 'close') {
        existing.closeTimestamp = d.timestamp;
      }
      if (d.url && !existing.url) {
        existing.url = d.url;
      }
      if (d.description && !existing.description) {
        existing.description = d.description;
      }
      if (type !== 'homework') {
        existing.type = type;
      }
      existing.timestamp = existing.closeTimestamp || existing.openTimestamp || d.timestamp;
    } else {
      groupedMap.set(key, {
        id: d.id,
        name: baseName,
        courseName: d.courseName,
        openTimestamp: eventKind === 'open' ? d.timestamp : undefined,
        closeTimestamp: eventKind === 'close' ? d.timestamp : undefined,
        timestamp: d.timestamp,
        url: d.url,
        type,
        modulename: d.modulename,
        eventtype: d.eventtype,
        description: d.description,
      });
    }
  }

  const list = Array.from(groupedMap.values());
  list.forEach(item => {
    if (item.closeTimestamp && item.openTimestamp) {
      item.timestamp = item.closeTimestamp;
    }
  });

  return list;
}

/* ── Dashboard ───────────────────────────────────────────── */

function Dashboard({
  view = 'overview',
  navigate,
  openCalendar,
  openHomework,
  moodle,
  user,
  onSync,
}: {
  navigate: (tab: string, intent?: string) => void;
  openCalendar: () => void;
  openHomework: (item: DeadlineItem) => void;
  view?: 'overview' | 'grades';
  moodle: MoodleData | null;
  user?: MoodleUser | null;
  onSync: () => void;
}) {
  const router = useRouter();
  const [profileUser, setProfileUser] = useState<MoodleUser | null>(user ?? null);
  const [currentDateTime, setCurrentDateTime] = useState<string>('');

  useEffect(() => {
    // Làm mới danh sách khóa học đã check-in nhanh mỗi khi mở web hoặc F5 ở Trang chủ
    try {
      sessionStorage.setItem('lms_quick_tested_courses', JSON.stringify([]));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('moodleUser');
    if (stored) {
      try {
        setProfileUser(JSON.parse(stored) as MoodleUser);
      } catch {
        localStorage.removeItem('moodleUser');
      }
    }
  }, []);

  useEffect(() => {
    const update = () => setCurrentDateTime(formatCurrentDateTime(new Date()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  const deadlines = useMemo(() => {
    const now = Date.now();
    return mergeMoodleDeadlines(moodle?.deadlines ?? [])
      .filter(d => (d.closeTimestamp ? d.closeTimestamp > now : d.timestamp > now))
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [moodle?.deadlines]);

  const courses: Course[] =
    moodle?.courses?.length
      ? moodle.courses.map((course, index) => {
          return {
            id: course.id,
            code: course.shortname,
            name: course.fullname,
            progress: course.progress ?? 0,
            color: defaultColors[index % defaultColors.length],
            icon: course.shortname.slice(0, 2).toUpperCase(),
            next: 'Xem nội dung khóa học',
            startdate: course.startdate,
            lastaccess: course.lastaccess,
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
        .map((c, idx) => ({ ...c, color: defaultColors[idx % defaultColors.length] }))
      : [];

  const lmsHomeUrl = useMemo(() => {
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
    return (baseUrl || 'https://moodletvk.duckdns.org').replace(/\/$/, '');
  }, [moodle?.moodleUrl, moodle?.resources]);

  const lmsProfileUrl = useMemo(() => {
    const cleanBase = lmsHomeUrl || 'https://moodletvk.duckdns.org';
    if (user?.id) {
      return `${cleanBase}/user/profile.php?id=${user.id}`;
    }
    return `${cleanBase}/user/profile.php`;
  }, [lmsHomeUrl, user?.id]);

  const allExamResults = useMemo(() => {
    return (moodle?.examResults || []).filter(r => {
      const mod = (r.itemModule || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      return (
        mod !== 'attendance' &&
        !mod.includes('attendance') &&
        !name.includes('attendance') &&
        !name.includes('điểm danh')
      );
    });
  }, [moodle?.examResults]);

  const latestResult = useMemo(() => {
    if (moodle?.latestResult) {
      const mod = (moodle.latestResult.itemModule || '').toLowerCase();
      const name = (moodle.latestResult.name || '').toLowerCase();
      if (
        mod !== 'attendance' &&
        !mod.includes('attendance') &&
        !name.includes('attendance') &&
        !name.includes('điểm danh')
      ) {
        return moodle.latestResult;
      }
    }
    return allExamResults[0] ?? null;
  }, [moodle?.latestResult, allExamResults]);

  const [showGradeHistoryModal, setShowGradeHistoryModal] = useState(false);
  const [gradeModalFilter, setGradeModalFilter] = useState<string>('all');
  const displayedGrades = useMemo(() => {
    if (gradeModalFilter === 'all') return allExamResults;
    return allExamResults.filter(
      r => String(r.courseId) === gradeModalFilter || r.courseCode?.toLowerCase() === gradeModalFilter.toLowerCase()
    );
  }, [allExamResults, gradeModalFilter]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock body scroll and handle Escape key for Grade History Modal
  useEffect(() => {
    if (!showGradeHistoryModal) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowGradeHistoryModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showGradeHistoryModal]);

  // Quiz Analysis state & handler
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [currentAnalysis, setCurrentAnalysis] = useState<QuizAnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisLoadingStage, setAnalysisLoadingStage] = useState<'fetching_saved' | 'ai_diagnosing'>('fetching_saved');
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [selectedExamResult, setSelectedExamResult] = useState<ExamResult | null>(null);
  const [analyzedAttemptIds, setAnalyzedAttemptIds] = useState<Set<number>>(new Set());
  const analysisAbortRef = useRef<AbortController | null>(null);
  const analysisLoadingAttemptRef = useRef<number | null>(null);

  const handleStopQuizAnalysis = () => {
    if (analysisAbortRef.current) {
      analysisAbortRef.current.abort();
      analysisAbortRef.current = null;
    }
    analysisLoadingAttemptRef.current = null;
    setAnalysisLoading(false);
    if (!currentAnalysis) {
      setAnalysisError('Đã dừng quá trình chẩn đoán bài thi.');
    }
  };

  const latestAnalyzedResult = useMemo(() => {
    return allExamResults.find(
      r => !!r.attemptId && analyzedAttemptIds.has(Number(r.attemptId))
    ) || null;
  }, [allExamResults, analyzedAttemptIds]);

  const latestAnalysis = useMemo(() => {
    if (!latestAnalyzedResult?.attemptId) return null;
    return getStoredAnalysis(latestAnalyzedResult.attemptId);
  }, [latestAnalyzedResult]);

  // Check saved analyses (localStorage first, then sync with database as source of truth)
  useEffect(() => {
    // 1. Instant local check (strictly validated existing cached items)
    const localIds = getAllStoredAttemptIds();
    setAnalyzedAttemptIds(new Set(localIds));

    // 2. Sync with database: Database is the authoritative source of truth
    fetch('/api/quiz/analysis')
      .then(r => r.json() as Promise<{ analyses?: QuizAnalysisData[] }>)
      .then(data => {
        const serverAnalyses = data?.analyses || [];
        const serverAttemptIds = new Set<number>();

        for (const item of serverAnalyses) {
          if (item?.attemptId) {
            serverAttemptIds.add(Number(item.attemptId));
            // Warm localStorage cache silently so future opens are instant
            saveStoredAnalysis(item.attemptId, item);
          }
        }

        // Direct overwrite: ONLY verified database analyses are marked as analyzed!
        setAnalyzedAttemptIds(serverAttemptIds);
      })
      .catch(() => {});
  }, []);

  const handleOpenQuizAnalysis = async (res: ExamResult | null, forceReanalyze = false) => {
    if (!res) return;
    setSelectedExamResult(res);

    const isAnalyzed = !!res.attemptId && analyzedAttemptIds.has(Number(res.attemptId));
    const route = resolveGradeRoute(res, isAnalyzed);

    // 1. Chat Action: Ôn tập theo nhận xét hoặc Gia sư AI
    // Directly place prompt into input of course chat (draft=1)
    if (route.actionType === 'chat') {
      setShowGradeHistoryModal(false);
      const prompt = route.prompt || buildGradePrompt(res, route.defaultStrategy, 'detailed', res.attemptId ? getStoredAnalysis(res.attemptId) : null);
      router.push(
        `/course?code=${encodeURIComponent(res.courseCode || '')}&name=${encodeURIComponent(
          res.courseName
        )}&id=${res.courseId}&draft=1&intent=${encodeURIComponent(prompt)}`
      );
      return;
    }

    // 2. Modal Action: Chẩn đoán chi tiết bài thi
    const attemptIdToUse = res.attemptId;
    if (attemptIdToUse) {
      // Instant re-open: if already loaded in component state for THIS exact exam
      if (currentAnalysis && Number(currentAnalysis.attemptId) === Number(attemptIdToUse) && !forceReanalyze) {
        setAnalysisError(null);
        setAnalysisModalOpen(true);
        return;
      }

      // Client-side localStorage cache-first: 0 network calls, 0 token consumption, instant modal open
      if (!forceReanalyze) {
        const localCached = getStoredAnalysis(attemptIdToUse);
        if (localCached) {
          setCurrentAnalysis(localCached);
          setAnalysisError(null);
          setAnalysisModalOpen(true);
          return;
        }
      }

      // The same diagnosis is already running in the background (e.g. the user
      // hid the modal and reopened it): just show the loading modal again.
      if (analysisLoadingAttemptRef.current === Number(attemptIdToUse)) {
        setAnalysisModalOpen(true);
        return;
      }

      // Abort any ongoing diagnosis request
      if (analysisAbortRef.current) {
        analysisAbortRef.current.abort();
      }
      const controller = new AbortController();
      analysisAbortRef.current = controller;
      analysisLoadingAttemptRef.current = Number(attemptIdToUse);

      // Clear previous analysis to prevent showing old exam title or data while loading
      setCurrentAnalysis(null);
      setAnalysisModalOpen(true);
      setAnalysisLoading(true);
      setAnalysisLoadingStage('fetching_saved');
      setAnalysisError(null);

      try {
        // Database cache-first: try fetching saved analysis from database before spending AI credits
        if (!forceReanalyze) {
          const checkRes = await fetch(`/api/quiz/analysis?attemptId=${attemptIdToUse}`, {
            signal: controller.signal,
          });
          const checkData = (await checkRes.json()) as any;
          if (checkData?.analysis) {
            setCurrentAnalysis({ ...checkData.analysis, cached: true });
            saveStoredAnalysis(attemptIdToUse, checkData.analysis);
            setAnalyzedAttemptIds(prev => new Set(prev).add(Number(attemptIdToUse)));
            setAnalysisLoading(false);
            return;
          }
        }

        // Need new AI diagnosis: indicate to user that AI generation is starting
        setAnalysisLoadingStage('ai_diagnosing');

        // Trigger analysis with 2x2 matrix context flags
        const apiRes = await fetch('/api/quiz/analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            attemptId: attemptIdToUse,
            courseId: res.courseId,
            courseCode: res.courseCode,
            courseName: res.courseName,
            quizName: res.name,
            userId: moodle?.user?.id,
            feedback: res.feedback,
            has_details: route.hasDetails,
            has_feedback: route.hasFeedback,
            forceReanalyze,
          }),
        });
        const data = (await apiRes.json()) as any;
        if (!apiRes.ok || data.error) {
          throw new Error(data.error || 'Không thể chẩn đoán bài thi lúc này.');
        }
        setCurrentAnalysis(data.analysis);
        saveStoredAnalysis(attemptIdToUse, data.analysis);
        setAnalyzedAttemptIds(prev => new Set(prev).add(Number(attemptIdToUse)));
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          setAnalysisError('Đã dừng quá trình chẩn đoán bài thi.');
        } else {
          setAnalysisError(err instanceof Error ? err.message : 'Có lỗi khi phân tích bài thi.');
        }
      } finally {
        if (analysisAbortRef.current === controller) {
          analysisAbortRef.current = null;
          analysisLoadingAttemptRef.current = null;
        }
        setAnalysisLoading(false);
      }
      return;
    }
  };

  return (
    <div className="page fade-in">
      {view === 'grades' ? (
        <HomeLearningDashboard
          courses={courses}
          grades={allExamResults}
          activities={moodle?.activities ?? []}
          userId={moodle?.user?.id}
          latestResult={latestResult}
          analyzedAttemptIds={analyzedAttemptIds}
          onOpenQuizAnalysis={exam => void handleOpenQuizAnalysis(exam)}
          onOpenGradeHistory={() => setShowGradeHistoryModal(true)}
          onOpenCourse={c =>
            router.push(`/course?code=${encodeURIComponent(c.code)}&name=${encodeURIComponent(c.name)}&id=${c.id ?? ''}`)
          }
        />
      ) : (<>
      {/* Hero */}
      <section className="hero-row">
        <div>
          <p className="eyebrow" suppressHydrationWarning>
            {currentDateTime || 'Hôm nay'}
          </p>
          <h1 suppressHydrationWarning>
            {getGreeting(new Date().getHours())}, {profileUser?.fullname || 'Học viên'}
          </h1>
          <p className="subtitle">
            {courses.length} khóa học · {deadlines.length} hạn nộp sắp tới
          </p>
        </div>
        <div className="hero-quick-actions">
          <a
            href={lmsHomeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary-clean"
            title="Mở Moodle LMS"
          >
            <GraduationCap size={14} />
            <span>Mở Moodle</span>
            <ExternalLink size={12} />
          </a>
        </div>
      </section>

      {/* Continue learning */}
      <section className="section-block">
        <div className="section-head" style={{ flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <div>
            <h2>Khóa học</h2>
            <p>Truy cập gần đây</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => navigate('Khóa học')}
              className="btn-secondary-clean"
              title="Xem tất cả khóa học"
            >
              <span>Xem tất cả ({courses.length})</span>
              <ArrowRight size={13} />
            </button>
          </div>
        </div>

        {courses.length === 0 ? (
          <div
            className="empty-state"
            style={{
              padding: '2.5rem',
              textAlign: 'center',
              background: 'rgba(255, 255, 255, 0.02)',
              borderRadius: '16px',
              border: '1px dashed rgba(255, 255, 255, 0.1)',
            }}
          >
            <p style={{ margin: '0 0 1rem', color: '#94a3b8', fontSize: '14px' }}>
              Không có khóa học nào trong danh mục này.
            </p>
            <button className="primary-action" onClick={onSync} style={{ margin: '0 auto' }}>
              ↻ Đồng bộ Moodle ngay
            </button>
          </div>
        ) : (
          <div className="course-grid">
            {courses.map(c => (
              <CourseCard
                course={c}
                key={c.id ?? c.code}
                onOpen={() =>
                  router.push(
                    `/course?code=${encodeURIComponent(c.code)}&name=${encodeURIComponent(c.name)}&id=${c.id ?? ''}`
                  )
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Deadlines + Activity */}
      <section className="lower-grid">
        <article className="deadline-card">
          <div className="section-head compact">
            <div>
              <h2>Sắp đến hạn</h2>
              <p>Lịch nộp bài từ Moodle</p>
            </div>
            <button onClick={openCalendar}>Xem lịch</button>
          </div>
          <div className="deadline-list">
            {deadlines.length === 0 ? (
              <div className="empty-state" style={{ padding: '1.5rem 0', color: '#94a3b8', fontSize: '13px' }}>
                Không có hạn nộp nào sắp tới.
              </div>
            ) : (
              deadlines.slice(0, 3).map((d, i) => (
                <Deadline key={d.id} item={d} urgent={i === 0} onOpen={openHomework} />
              ))
            )}
          </div>
        </article>

        <article className="activity-card latest-result-card">
          <div className="section-head compact">
            <div>
              <h2>Kết quả mới nhất</h2>
              <p>Cập nhật từ Moodle</p>
            </div>
            {latestResult ? (
              <span className={`result-status-tag ${latestResult.passed ? 'pass' : 'fail'}`}>
                {latestResult.passed ? '✓ Đạt' : '✕ Cần cải thiện'}
              </span>
            ) : (
              <button onClick={onSync} title="Đồng bộ lại từ Moodle">
                Đồng bộ
              </button>
            )}
          </div>

          {latestResult ? (
            <>
              <div className="latest-result-body">
                <div className="result-course-info">
                  <span className="result-course-code">{(latestResult.courseCode || 'MOODLE').toUpperCase()}</span>
                  <span className="result-course-title" title={latestResult.courseName}>
                    {latestResult.courseName}
                  </span>
                </div>
                <h3 className="result-exam-title" title={latestResult.name}>
                  {latestResult.name}
                </h3>

                <div className="result-score-container">
                  <div className="result-score-row">
                    <div className="result-score-group">
                      <span className={`result-score-val ${latestResult.passed ? 'pass' : 'fail'}`}>
                        {formatGrade(latestResult.score)}
                      </span>
                      <span className="result-score-max">/{formatGrade(latestResult.maxScore)}</span>
                    </div>
                  </div>

                  <div className="result-progress-track">
                    <div
                      className={`result-progress-bar ${latestResult.passed ? 'pass' : 'fail'}`}
                      style={{
                        width: `${Math.min(100, Math.max(0, (latestResult.score / (latestResult.maxScore || 10)) * 100))}%`,
                      }}
                    />
                  </div>

                  {latestResult.feedback ? (
                    <div
                      style={{
                        marginTop: '0.85rem',
                        padding: '0.75rem 0.9rem',
                        borderRadius: '10px',
                        background: 'linear-gradient(135deg, rgba(185, 43, 71, 0.15), rgba(219, 63, 138, 0.1))',
                        border: '1px solid rgba(185, 43, 71, 0.35)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          fontSize: '11px',
                          fontWeight: 700,
                          color: '#e2e8f0',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}
                      >
                        <MessageSquare size={13} style={{ flexShrink: 0 }} />
                        <span>Nhận xét:</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '13px', color: '#f3f2f8', fontStyle: 'italic', lineHeight: '1.45' }}>
                        "{latestResult.feedback}"
                      </p>
                    </div>
                  ) : (
                    <div
                      style={{
                        marginTop: '0.85rem',
                        padding: '0.55rem 0.85rem',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.03)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '12px',
                        color: '#94a3b8',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: '#f7cbd4', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                        <MessageSquare size={13} style={{ flexShrink: 0 }} />
                        <span>Nhận xét:</span>
                      </span>
                      <span style={{ color: '#cbd5e1', fontWeight: 600 }}>-</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="result-footer">
                <div className="result-footer-stat">
                  <CalendarDays size={14} style={{ color: '#94a3b8', flexShrink: 0 }} />
                  <section>
                    <strong>
                      {latestResult.gradedAt
                        ? new Date(latestResult.gradedAt).toLocaleDateString('vi-VN', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                          })
                        : 'Vừa xong'}
                    </strong>
                    <small>Thời gian chấm</small>
                  </section>
                </div>

                <div className="result-actions">
                  <button
                    type="button"
                    className="result-action-link"
                    onClick={() => setShowGradeHistoryModal(true)}
                    style={{
                      cursor: 'pointer',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      background: 'rgba(255, 255, 255, 0.06)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      color: '#cbd5e1',
                    }}
                    title="Xem lịch sử điểm và nhận xét tất cả các môn"
                  >
                    <BarChart3 size={14} />
                    <span>Lịch sử điểm</span>
                  </button>
                  {(() => {
                    const isAnalyzed = !!latestResult?.attemptId && analyzedAttemptIds.has(Number(latestResult.attemptId));
                    const route = resolveGradeRoute(latestResult, isAnalyzed);
                    return (
                      <button
                        className="result-ai-btn"
                        onClick={() => handleOpenQuizAnalysis(latestResult)}
                        title={route.buttonTooltip}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          background: route.buttonGradient,
                          borderColor: route.borderColor,
                        }}
                      >
                        <Sparkles size={14} />
                        <span>{route.buttonLabel}</span>
                      </button>
                    );
                  })()}
                </div>
              </div>
            </>
          ) : (
            <div className="result-empty">
              <FileText size={26} style={{ color: '#64748b' }} />
              <p>Chưa có kết quả thi</p>
              <small>Làm bài kiểm tra trên LMS để hiển thị điểm tại đây</small>
            </div>
          )}
        </article>
      </section>

      </>)}

      {/* Grade History Modal */}
      {showGradeHistoryModal && mounted && createPortal(
        <div
          className="grade-history-modal-overlay"
          onClick={() => setShowGradeHistoryModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(8, 4, 6, 0.82)',
            backdropFilter: 'blur(10px)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.25rem',
            animation: 'fadeIn 0.2s ease',
            overscrollBehavior: 'contain',
          }}
        >
          <div
            className="grade-history-modal-content"
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '820px',
              maxHeight: '88vh',
              background: 'linear-gradient(180deg, #18151b 0%, #0d1017 100%)',
              border: '1px solid rgba(185, 43, 71, 0.35)',
              borderRadius: '22px',
              boxShadow: '0 25px 80px rgba(0, 0, 0, 0.65), 0 0 40px rgba(185, 43, 71, 0.18)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              overscrollBehavior: 'contain',
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: '1.25rem 1.6rem',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(255, 255, 255, 0.02)',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                <div
                  style={{
                    width: '42px',
                    height: '42px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, #b92b47, #88162c)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 14px rgba(185, 43, 71, 0.4)',
                    flexShrink: 0,
                  }}
                >
                  <BarChart3 size={20} style={{ color: '#fff' }} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#fff' }}>
                    Lịch sử điểm
                  </h3>
                  <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#94a3b8' }}>
                    Tổng hợp {allExamResults.length} đầu điểm từ LMS
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGradeHistoryModal(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '10px',
                  width: '36px',
                  height: '36px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#cbd5e1',
                  cursor: 'pointer',
                  fontSize: '16px',
                  transition: 'all 0.2s',
                  flexShrink: 0,
                }}
                title="Đóng cửa sổ"
              >
                ✕
              </button>
            </div>

            {/* Filter Tabs by Course */}
            {courses.length > 0 && (
              <div
                style={{
                  padding: '0.75rem 1.6rem',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                  display: 'flex',
                  gap: '8px',
                  overflowX: 'auto',
                  background: 'rgba(0, 0, 0, 0.18)',
                  flexShrink: 0,
                }}
              >
                <button
                  type="button"
                  onClick={() => setGradeModalFilter('all')}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '9px',
                    border: 'none',
                    background:
                      gradeModalFilter === 'all' ? 'rgba(185, 43, 71, 0.35)' : 'rgba(255, 255, 255, 0.04)',
                    color: gradeModalFilter === 'all' ? '#fff' : '#94a3b8',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.2s',
                  }}
                >
                  Tất cả ({allExamResults.length})
                </button>
                {courses.map(c => {
                  const countForCourse = allExamResults.filter(
                    r => r.courseId === c.id || r.courseCode?.toLowerCase() === c.code?.toLowerCase()
                  ).length;
                  const displayCode = (c.code || '').toUpperCase();
                  return (
                    <button
                      key={c.id ?? c.code}
                      type="button"
                      onClick={() => setGradeModalFilter(String(c.id ?? c.code))}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '9px',
                        border: 'none',
                        background:
                          gradeModalFilter === String(c.id ?? c.code)
                            ? 'rgba(185, 43, 71, 0.35)'
                            : 'rgba(255, 255, 255, 0.04)',
                        color: gradeModalFilter === String(c.id ?? c.code) ? '#f7cbd4' : '#94a3b8',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        transition: 'all 0.2s',
                        textTransform: 'uppercase',
                      }}
                    >
                      {displayCode} ({countForCourse})
                    </button>
                  );
                })}
              </div>
            )}

            {/* Grade Items List */}
            <div
              style={{
                padding: '1.25rem 1.6rem',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                flex: '1 1 auto',
                minHeight: 0,
                overscrollBehavior: 'contain',
              }}
            >
              {displayedGrades.length === 0 ? (
                <div
                  style={{
                    padding: '3rem 1.5rem',
                    textAlign: 'center',
                    color: '#94a3b8',
                    fontSize: '14px',
                  }}
                >
                  <FileText size={36} style={{ display: 'block', margin: '0 auto 0.6rem', color: '#64748b' }} />
                  <p style={{ margin: 0, fontWeight: 650, color: '#f1f5f9' }}>Chưa có đầu điểm nào cho môn học này</p>
                  <small style={{ color: '#64748b' }}>Các bài thi và bài kiểm tra trên LMS sẽ tự động hiển thị tại đây</small>
                </div>
              ) : (
                displayedGrades.map((res, idx) => (
                  <div
                    key={`${res.id}-${res.courseId}-${idx}`}
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '16px',
                      padding: '1.1rem 1.25rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.85rem',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    {/* Row 1: Course Info + Date */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span className="result-course-code">{(res.courseCode || 'MOODLE').toUpperCase()}</span>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1' }}>
                          {res.courseName}
                        </span>
                      </div>
                      <span style={{ fontSize: '12px', color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <CalendarDays size={13} style={{ flexShrink: 0 }} />
                        {res.gradedAt
                          ? new Date(res.gradedAt).toLocaleDateString('vi-VN', {
                              day: '2-digit',
                              month: '2-digit',
                              year: 'numeric',
                            })
                          : 'Moodle'}
                      </span>
                    </div>

                    {/* Row 2: Exam Name + Score */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '0.75rem',
                      }}
                    >
                      <div>
                        <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>
                          {res.name}
                        </h4>
                        <small className="grade-item-type" style={{ fontSize: '12px', color: '#64748b' }}>
                          Loại bài: {res.itemModule || 'Kiểm tra'}
                        </small>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{ textAlign: 'right' }}>
                          <span
                            style={{
                              fontSize: '20px',
                              fontWeight: 800,
                              color: res.passed ? '#22c55e' : '#ef4444',
                            }}
                          >
                            {formatGrade(res.score)}
                          </span>
                          <span style={{ fontSize: '13px', color: '#94a3b8' }}>/{formatGrade(res.maxScore)}</span>
                        </div>
                        <span className={`result-status-tag ${res.passed ? 'pass' : 'fail'}`}>
                          {res.passed ? '✓ Đạt' : '✕ Cần cải thiện'}
                        </span>
                      </div>
                    </div>

                    {/* Progress track */}
                    <div className="result-progress-track" style={{ height: '5px' }}>
                      <div
                        className={`result-progress-bar ${res.passed ? 'pass' : 'fail'}`}
                        style={{
                          width: `${Math.min(100, Math.max(0, (res.score / (res.maxScore || 10)) * 100))}%`,
                        }}
                      />
                    </div>

                    {/* Feedback box */}
                    {res.feedback ? (
                      <div
                        style={{
                          padding: '0.65rem 0.85rem',
                          borderRadius: '10px',
                          background:
                            'linear-gradient(135deg, rgba(185, 43, 71, 0.12), rgba(219, 63, 138, 0.08))',
                          border: '1px solid rgba(185, 43, 71, 0.28)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.25rem',
                        }}
                      >
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            color: '#f7cbd4',
                            textTransform: 'uppercase',
                            letterSpacing: '0.4px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                          }}
                        >
                          <MessageSquare size={13} style={{ flexShrink: 0 }} />
                          <span>Nhận xét:</span>
                        </span>
                        <p
                          style={{
                            margin: 0,
                            fontSize: '13px',
                            color: '#f1f5f9',
                            fontStyle: 'italic',
                            lineHeight: '1.45',
                          }}
                        >
                          "{res.feedback}"
                        </p>
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: '0.45rem 0.75rem',
                          borderRadius: '8px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontSize: '12px',
                          color: '#94a3b8',
                        }}
                      >
                        <span style={{ fontWeight: 600, color: '#f7cbd4', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          <MessageSquare size={13} style={{ flexShrink: 0 }} />
                          <span>Nhận xét:</span>
                        </span>
                        <span style={{ color: '#cbd5e1', fontWeight: 600 }}>-</span>
                      </div>
                    )}

                    {/* Actions */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '8px',
                        marginTop: '2px',
                      }}
                    >
                      {res.url && (
                        <a
                          href={res.url}
                          target="_blank"
                          rel="noreferrer"
                          className="result-action-link"
                          style={{ fontSize: '12px', padding: '0.45rem 0.85rem' }}
                          title="Mở trực tiếp trên Moodle"
                        >
                          Moodle ↗
                        </a>
                      )}
                      {(() => {
                        const isAnalyzed = !!res.attemptId && analyzedAttemptIds.has(Number(res.attemptId));
                        const route = resolveGradeRoute(res, isAnalyzed);
                        return (
                          <button
                            type="button"
                            className="result-ai-btn"
                            style={{
                              fontSize: '12px',
                              padding: '0.45rem 0.95rem',
                              background: route.buttonGradient,
                              borderColor: route.borderColor,
                            }}
                            onClick={() => {
                              setShowGradeHistoryModal(false);
                              handleOpenQuizAnalysis(res);
                            }}
                            title={route.buttonTooltip}
                          >
                            {route.buttonLabel}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Quiz Analysis Diagnosis Modal */}
      {analysisModalOpen && (
        <QuizAnalysisModal
          isOpen={analysisModalOpen}
          onClose={() => {
            // Hide the modal without aborting the AI diagnosis. The request
            // keeps running and the artifact-ready push will notify the student.
            if (!analysisLoading) setAnalysisError(null);
            setAnalysisModalOpen(false);
          }}
          onStop={handleStopQuizAnalysis}
          analysis={currentAnalysis}
          loading={analysisLoading}
          loadingStage={analysisLoadingStage}
          examName={selectedExamResult?.name || currentAnalysis?.quizName}
          courseName={selectedExamResult?.courseName || currentAnalysis?.courseName}
          error={analysisError}
          onRetry={() => selectedExamResult && handleOpenQuizAnalysis(selectedExamResult, false)}
          onReanalyze={() => selectedExamResult && handleOpenQuizAnalysis(selectedExamResult, true)}
          onDelete={async () => {
            if (!currentAnalysis?.id && !currentAnalysis?.attemptId) return;
            const userId = moodle?.user?.id || 4;
            const attemptIdToDelete = currentAnalysis.attemptId ? Number(currentAnalysis.attemptId) : null;
            const queryParams = new URLSearchParams({
              userId: String(userId),
              artifactType: 'quiz_analysis',
            });
            if (currentAnalysis.id) queryParams.set('id', currentAnalysis.id);
            if (attemptIdToDelete) queryParams.set('attemptId', String(attemptIdToDelete));

            const response = await fetch(`/api/learning-artifacts?${queryParams.toString()}`, {
              method: 'DELETE',
            });
            const data = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(data.error || 'Không thể xóa bản phân tích.');

            if (attemptIdToDelete) {
              removeStoredAnalysis(attemptIdToDelete);
              setAnalyzedAttemptIds(prev => {
                const next = new Set(prev);
                next.delete(attemptIdToDelete);
                return next;
              });
            }
            setCurrentAnalysis(null);
            setSelectedExamResult(null);
            setAnalysisModalOpen(false);
          }}
          onStartRemediation={topics => {
            setAnalysisModalOpen(false);
            const cId = currentAnalysis?.courseId || selectedExamResult?.courseId || '';
            const cCode = selectedExamResult?.courseCode || currentAnalysis?.courseName || '';
            router.push(
              `/course?code=${encodeURIComponent(cCode)}&id=${cId}&tool=Quiz&mode=targeted&topics=${encodeURIComponent(
                topics.join(',')
              )}`
            );
          }}
          onAskTutor={analysisData => {
            setAnalysisModalOpen(false);
            if (selectedExamResult) {
              const prompt = buildGradePrompt(
                selectedExamResult,
                'roadmap',
                'detailed',
                analysisData || currentAnalysis
              );
              router.push(
                `/course?code=${encodeURIComponent(selectedExamResult.courseCode || '')}&name=${encodeURIComponent(
                  selectedExamResult.courseName
                )}&id=${selectedExamResult.courseId}&draft=1&intent=${encodeURIComponent(prompt)}`
              );
            }
          }}
        />
      )}
    </div>
  );
}


/* ── Deadline ────────────────────────────────────────────── */

function Deadline({
  item,
  urgent,
  onOpen,
}: {
  item: DeadlineItem;
  urgent?: boolean;
  onOpen?: (item: DeadlineItem) => void;
}) {
  const displayDate = new Date(item.closeTimestamp || item.timestamp);
  const hasInterval = Boolean(item.openTimestamp && item.closeTimestamp);

  let timeString = displayDate.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  if (hasInterval && item.openTimestamp && item.closeTimestamp) {
    const openD = new Date(item.openTimestamp);
    const closeD = new Date(item.closeTimestamp);
    const sameDay = openD.toDateString() === closeD.toDateString();

    const openTimeStr = openD.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const closeTimeStr = closeD.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const dateStr = closeD.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });

    if (sameDay) {
      timeString = `${openTimeStr} - ${closeTimeStr} ${dateStr}`;
    } else {
      timeString = `${openTimeStr} ${openD.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} - ${closeTimeStr} ${dateStr}`;
    }
  }

  const isAttendance =
    item.type === 'attendance' ||
    item.url?.toLowerCase().includes('/mod/attendance/') ||
    item.name.toLowerCase().includes('attendance') ||
    item.name.toLowerCase().includes('điểm danh');

  const isExam =
    !isAttendance &&
    (item.type === 'exam' ||
      item.type === 'quiz' ||
      item.url?.toLowerCase().includes('/mod/quiz/') ||
      item.name.toLowerCase().includes('thi') ||
      item.name.toLowerCase().includes('kiểm tra') ||
      item.name.toLowerCase().includes('quiz') ||
      item.name.toLowerCase().includes('trắc nghiệm'));

  let deadlineIcon = '▤';
  let badgeStyle: React.CSSProperties | undefined = undefined;

  if (isAttendance) {
    deadlineIcon = '⏱';
    badgeStyle = { backgroundColor: 'rgba(185, 43, 71, 0.18)', color: '#e06c82' };
  } else if (isExam) {
    deadlineIcon = '✎';
    badgeStyle = { backgroundColor: 'rgba(245, 158, 11, 0.18)', color: '#fbbf24' };
  } else if (item.type === 'manual') {
    deadlineIcon = '📢';
    badgeStyle = { backgroundColor: 'rgba(236, 72, 153, 0.18)', color: '#ec4899' };
  }

  return (
    <div
      className={onOpen ? 'deadline-item clickable' : 'deadline-item'}
      suppressHydrationWarning
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={() => onOpen?.(item)}
      onKeyDown={event => {
        if (onOpen && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen(item);
        }
      }}
    >
      <time suppressHydrationWarning>
        <b>{displayDate.getDate().toString().padStart(2, '0')}</b>
        <small>THG {displayDate.getMonth() + 1}</small>
      </time>
      <span
        className={`deadline-icon ${urgent ? 'purple' : 'green'}`}
        style={badgeStyle}
      >
        {urgent ? (isAttendance ? '⏱' : isExam ? '✎' : '▤') : deadlineIcon}
      </span>
      <section>
        <strong>{item.name}</strong>
        <p suppressHydrationWarning>
          {item.courseName} · {timeString}
        </p>
      </section>
      {urgent && <em>Gấp</em>}
    </div>
  );
}

function HomeworkModal({
  item,
  onClose,
  onOpenCourse,
}: {
  item: DeadlineItem;
  onClose: () => void;
  onOpenCourse: () => void;
}) {
  const date = new Date(item.closeTimestamp || item.timestamp);

  let timeDisplay = date.toLocaleString('vi-VN', { dateStyle: 'full', timeStyle: 'short' });
  if (item.openTimestamp && item.closeTimestamp) {
    const openD = new Date(item.openTimestamp);
    const closeD = new Date(item.closeTimestamp);
    const sameDay = openD.toDateString() === closeD.toDateString();

    if (sameDay) {
      timeDisplay = `${openD.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} - ${closeD.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}, ${closeD.toLocaleDateString('vi-VN', { dateStyle: 'full' })}`;
    } else {
      timeDisplay = `${openD.toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })} — ${closeD.toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })}`;
    }
  }

  const isManual = item.type === 'manual';
  const isAttendance =
    !isManual &&
    (item.type === 'attendance' ||
      item.url?.toLowerCase().includes('/mod/attendance/') ||
      item.name.toLowerCase().includes('attendance') ||
      item.name.toLowerCase().includes('điểm danh'));
  const isExam =
    !isManual &&
    !isAttendance &&
    (item.type === 'exam' ||
      item.type === 'quiz' ||
      item.url?.toLowerCase().includes('/mod/quiz/') ||
      item.name.toLowerCase().includes('thi') ||
      item.name.toLowerCase().includes('kiểm tra') ||
      item.name.toLowerCase().includes('quiz') ||
      item.name.toLowerCase().includes('trắc nghiệm'));

  const modalTitle = 'Chi tiết';
  let eyebrowText = 'BÀI TẬP MOODLE';
  let timeLabel = 'Hạn nộp bài';
  let iconBadge = '▤';
  let iconStyle: React.CSSProperties = { backgroundColor: 'rgba(185, 43, 71, 0.2)', color: '#f7cbd4' };
  let statusDotColor = '#e06c82';

  if (isManual) {
    eyebrowText = 'THÔNG BÁO TỪ GIẢNG VIÊN';
    timeLabel = 'Thời gian sự kiện';
    iconBadge = '📢';
    iconStyle = { backgroundColor: 'rgba(236, 72, 153, 0.2)', color: '#ec4899' };
    statusDotColor = '#ec4899';
  } else if (isAttendance) {
    eyebrowText = 'PHIÊN ĐIỂM DANH';
    timeLabel = 'Thời gian điểm danh';
    iconBadge = '⏱';
    iconStyle = { backgroundColor: 'rgba(185, 43, 71, 0.2)', color: '#e06c82' };
    statusDotColor = '#e06c82';
  } else if (isExam) {
    eyebrowText = 'BÀI KIỂM TRA';
    timeLabel = item.openTimestamp && item.closeTimestamp ? 'Thời gian làm bài' : 'Hạn làm bài';
    iconBadge = '✎';
    iconStyle = { backgroundColor: 'rgba(245, 158, 11, 0.2)', color: '#fbbf24' };
    statusDotColor = '#fbbf24';
  } else {
    eyebrowText = 'BÀI TẬP';
    timeLabel = 'Hạn nộp bài';
    iconBadge = '▤';
    iconStyle = { backgroundColor: 'rgba(185, 43, 71, 0.2)', color: '#f7cbd4' };
    statusDotColor = '#e06c82';
  }

  return (
    <Modal title={modalTitle} onClose={onClose}>
      <div className="homework-modal">
        <div className="homework-heading">
          <span className="deadline-icon" style={iconStyle}>
            {iconBadge}
          </span>
          <div>
            <p className="eyebrow">{eyebrowText}</p>
            {item.url ? (
              <a className="homework-title-link" href={item.url} target="_blank" rel="noreferrer">
                {item.name} <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <h3>{item.name}</h3>
            )}
          </div>
        </div>
        <div className="homework-details">
          <div><span>Khóa học</span><strong>{item.courseName}</strong></div>
          <div><span>{timeLabel}</span><strong>{timeDisplay}</strong></div>
        </div>
        <div className="homework-status">
          <i style={{ backgroundColor: statusDotColor }} />
          {isManual
            ? 'Thông báo gửi trực tiếp từ Giảng viên'
            : isAttendance
            ? 'Phiên điểm danh đồng bộ từ Moodle LMS'
            : isExam
            ? 'Bài kiểm tra đồng bộ từ Moodle LMS'
            : 'Hoạt động đồng bộ từ Moodle LMS'}
        </div>
        {item.description && (
          <div className="homework-description">
            <span>{isManual ? 'Nội dung thông báo' : 'Mô tả chi tiết'}</span>
            <p style={{ whiteSpace: 'pre-line' }}>{item.description}</p>
          </div>
        )}
        <div className="homework-actions">
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: '8px 14px',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#fff',
                textDecoration: 'none',
                fontSize: '13px',
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              Mở LMS <span aria-hidden="true">↗</span>
            </a>
          )}
          <button className="primary-action" onClick={onOpenCourse}>Vào khóa học <span>→</span></button>
        </div>
      </div>
    </Modal>
  );
}



/* ── Library ─────────────────────────────────────────────── */

function Library({ notify }: { notify: (s: string) => void }) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('Tất cả');
  const [storageUsed, setStorageUsed] = useState(0);
  const [menu, setMenu] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/library');
      const data = (await res.json()) as LibraryResponse;
      if (res.ok && data.documents?.length) {
        const remote: LibraryFile[] = data.documents.map(d => ({
          id: d.id,
          name: d.name,
          size: formatBytes(d.size),
          sizeBytes: d.size,
          type: d.name.split('.').pop()?.toUpperCase() || d.contentType,
          source: d.source === 'personal' ? 'Tải lên cá nhân' : 'Moodle',
          status: d.status === 'indexed' ? 'Đã lập chỉ mục' : d.status,
        }));
        setFiles(remote);
        setStorageUsed(data.storageUsed ?? 0);
      }
    } catch {
      // empty
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    for (const file of Array.from(list)) {
      const temp = `temp-${crypto.randomUUID()}`;
      const row: LibraryFile = {
        id: temp,
        name: file.name,
        size: formatBytes(file.size),
        sizeBytes: file.size,
        type: file.name.split('.').pop()?.toUpperCase() || 'FILE',
        source: 'Tải lên cá nhân',
        status: 'Đang tải lên',
      };
      setFiles(v => [row, ...v]);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/library', { method: 'POST', body: form });
        const data = (await res.json()) as UploadResponse;
        if (!res.ok) throw new Error(data.error);
        setFiles(v => v.map(x => (x.id === temp ? { ...x, id: data.id, status: 'Đã lập chỉ mục' } : x)));
        setStorageUsed(v => v + file.size);
        notify(`Đã thêm ${file.name}`);
      } catch (e) {
        setFiles(v => v.filter(x => x.id !== temp));
        notify(e instanceof Error ? e.message : `Không thể tải ${file.name}`);
      }
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const remove = async (file: LibraryFile) => {
    if (!file.id || file.id.startsWith('temp-')) return;
    if (!window.confirm(`Xóa "${file.name}" khỏi thư viện?`)) return;
    const res = await fetch(`/api/library?id=${encodeURIComponent(file.id)}`, { method: 'DELETE' });
    const data = (await res.json()) as ErrorResponse;
    if (!res.ok) {
      notify(data.error ?? 'Không thể xóa tài liệu');
      return;
    }
    setFiles(v => v.filter(x => x.id !== file.id));
    setStorageUsed(v => Math.max(0, v - (file.sizeBytes ?? 0)));
    setMenu(null);
    notify('Đã xóa tài liệu');
  };

  const shown = files.filter(
    f =>
      f.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'Tất cả' || (filter === 'Moodle' ? f.source.includes('Moodle') : f.source.includes('cá nhân'))),
  );

  const percent = Math.min(100, (storageUsed / (10 * 1024 * 1024 * 1024)) * 100);

  return (
    <div className="workspace-page fade-in">
      <div className="workspace-title">
        <div>
          <p className="eyebrow">KHO TRI THỨC CÁ NHÂN</p>
          <h1>Thư viện tài liệu</h1>
          <p>Tất cả tài liệu Moodle và nguồn riêng của bạn tại một nơi.</p>
        </div>
        <button className="primary-action" onClick={() => inputRef.current?.click()}>
          ＋ Tải tài liệu
        </button>
        <input
          ref={inputRef}
          hidden
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.ppt,.pptx,.txt"
          onChange={e => void upload(e.target.files)}
        />
      </div>

      <button
        className={`dropzone ${uploading ? 'busy' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
      >
        <span>⇧</span>
        <strong>{uploading ? 'Đang mã hóa và tải lên…' : 'Kéo thả tài liệu vào đây'}</strong>
        <small>PDF, DOCX, PPTX hoặc TXT · tối đa 50 MB · lưu trữ riêng tư</small>
      </button>

      <div className="library-toolbar">
        <label>
          ⌕ <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm trong thư viện..." />
        </label>
        <div>
          {['Tất cả', 'Moodle', 'Cá nhân'].map(x => (
            <button key={x} className={filter === x ? 'selected' : ''} onClick={() => setFilter(x)}>
              {x}
            </button>
          ))}
        </div>
      </div>

      <div className="file-table">
        <div className="table-head">
          <span>TÊN TÀI LIỆU</span>
          <span>NGUỒN</span>
          <span>TRẠNG THÁI</span>
          <span />
        </div>

        {loading ? (
          <div className="empty-state">Đang tải thư viện…</div>
        ) : shown.length === 0 ? (
          <div className="empty-state">Chưa có tài liệu nào trong thư viện. Nhấn &ldquo;＋ Tải tài liệu&rdquo; để thêm.</div>
        ) : (
          shown.map((f, i) => (
            <div className="file-row" key={`${f.id ?? f.name}-${i}`}>
              <span className={`doc-icon ${f.type.toLowerCase()}`}>{f.type.slice(0, 1)}</span>
              <section>
                <strong>{f.name}</strong>
                <small>
                  {f.type} · {f.size}
                </small>
              </section>
              <span>{f.source}</span>
              <span className={f.status.includes('Đã') ? 'ready' : 'processing'}>
                <i /> {f.status}
              </span>
              <div className="row-menu">
                <button onClick={() => setMenu(menu === (f.id ?? f.name) ? null : (f.id ?? f.name))}>•••</button>
                {menu === (f.id ?? f.name) && (
                  <div>
                    <button
                      disabled={!f.id}
                      onClick={() => f.id && window.open(`/api/library?id=${encodeURIComponent(f.id)}`, '_blank')}
                    >
                      ↓ Tải xuống
                    </button>
                    <button disabled={!f.id} className="danger" onClick={() => void remove(f)}>
                      × Xóa
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="storage-card">
        <div>
          <span>☁</span>
          <section>
            <strong>{formatBytes(storageUsed)} / 10 GB</strong>
            <small>Dung lượng kho cá nhân</small>
          </section>
        </div>
        <div className="storage-progress">
          <i style={{ width: `${Math.max(1, percent)}%` }} />
        </div>
        <button onClick={() => notify('Gói nâng cấp sẽ được mở trong phiên bản thương mại.')}>Nâng cấp</button>
      </div>
    </div>
  );
}

/* ── Modal / Toast ───────────────────────────────────────── */

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <section className="modal">
        <header>
          <h2>{title}</h2>
          <button onClick={onClose}>×</button>
        </header>
        <div className="modal-body-scrollable">
          {children}
        </div>
      </section>
    </div>,
    document.body
  );
}

function Toast({ text }: { text: string }) {
  return <div className="toast">✓ {text}</div>;
}

/* ── Home (Root Content) ─────────────────────────────────── */

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [active, setActive] = useState('Tổng quan');

  useEffect(() => {
    if (tabParam) {
      const map: Record<string, string> = {
        courses: 'Khóa học',
        course: 'Khóa học',
        library: 'Thư viện',
        overview: 'Tổng quan',
        activities: 'Hoạt động',
        grades: 'Bảng điểm',
      };
      const resolved = map[tabParam.toLowerCase()] || tabParam;
      if (resolved === 'Luyện tập' || tabParam.toLowerCase() === 'practice') {
        router.push('/quiz');
        return;
      }
      setActive(resolved);
    } else if (typeof window !== 'undefined' && window.location.hash) {
      const hash = window.location.hash.toLowerCase();
      if (hash.includes('courses') || hash.includes('course')) {
        setActive('Khóa học');
      } else if (hash.includes('library')) setActive('Thư viện');
      else if (hash.includes('practice')) router.push('/quiz');
    }
  }, [tabParam, router]);

  const [moodle, setMoodle] = useState<MoodleData | null>(null);
  const [user, setUser] = useState<MoodleUser | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [notifications, setNotifications] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [profile, setProfile] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    if ('Notification' in window) setNotificationPermission(Notification.permission);
  }, []);

  const [selectedHomework, setSelectedHomework] = useState<DeadlineItem | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2600);
  };

  const navigate = (tab: string) => {
    if (tab === 'courses') {
      setActive('Khóa học');
      setSearch('');
      window.scrollTo({ top: 0 });
      return;
    }
    setActive(tab);
    setSearch('');
    window.scrollTo({ top: 0 });
  };

  const openHomework = (item: DeadlineItem) => {
    setCalendar(false);
    setSelectedHomework(item);
  };

  const handleOpenNotification = (notif: NotificationItem) => {
    setNotifications(false);
    const rawTitle = (notif.title || notif.name || '').toLowerCase().trim();
    const match = mergedDeadlines.find(d =>
      (notif.moodleEventId && d.id === notif.moodleEventId) ||
      d.name.toLowerCase().trim() === rawTitle ||
      rawTitle.includes(d.name.toLowerCase().trim()) ||
      d.name.toLowerCase().trim().includes(rawTitle)
    );

    if (match) {
      openHomework(match);
    } else {
      const isManual = notif.eventType === 'manual';
      const matchedCourse = notif.moodleCourseId
        ? moodleCourses.find(c => Number(c.id) === Number(notif.moodleCourseId))
        : (notif.courseName ? moodleCourses.find(c => c.name.toLowerCase() === notif.courseName?.toLowerCase()) : null);

      const resolvedCourseName = matchedCourse?.name || notif.courseName || 'Khóa học';

      const fallbackItem: DeadlineItem = {
        id: notif.moodleEventId || notif.id,
        name: notif.title || notif.name || (isManual ? 'Thông báo từ Giảng viên' : 'Bài tập'),
        courseName: resolvedCourseName,
        courseId: matchedCourse?.id ?? notif.moodleCourseId ?? undefined,
        timestamp: notif.timestamp,
        closeTimestamp: notif.timestamp,
        url: notif.url,
        type: isManual ? 'manual' : (notif.eventType === 'quiz' ? 'quiz' : 'homework'),
        description: notif.eventDetails || undefined,
      };
      openHomework(fallbackItem);
    }
  };

  const sync = async (force = false, announce = true) => {
    if (syncing) return;
    const cachedAt = Number(localStorage.getItem('moodleDataSyncedAt') || 0);
    if (!force && localStorage.getItem('moodleData') && Date.now() - cachedAt < MOODLE_CACHE_MAX_AGE_MS) return;
    setSyncing(true);
    try {
      const token = localStorage.getItem('moodleToken');
      const res = await fetch('/api/moodle', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      const data = (await res.json()) as MoodleData & ErrorResponse & { clientTokenExpired?: boolean };
      if (res.status === 401 || data.clientTokenExpired) {
        localStorage.removeItem('moodleToken');
        localStorage.removeItem('moodleUser');
      }
      if (!res.ok) throw new Error(data.error);
      setMoodle(data);
      localStorage.setItem('moodleData', JSON.stringify(data));
      localStorage.setItem('moodleDataSyncedAt', String(Date.now()));
      if (data.user) {
        setUser(prev => {
          const avatarUrl =
            data.user!.avatarUrl ||
            (token ? `/api/moodle/avatar?token=${encodeURIComponent(token)}&id=${data.user!.id}` : prev?.avatarUrl);
          const updated: MoodleUser = {
            id: data.user!.id,
            fullname: data.user!.name || prev?.fullname || '',
            username: data.user!.username || prev?.username || '',
            avatarUrl,
            role: data.user!.role || prev?.role || 'student',
          };
          localStorage.setItem('moodleUser', JSON.stringify(updated));
          return updated;
        });
      }
      if (announce) notify(data.mode === 'live' ? 'Đồng bộ Moodle thành công' : 'Đã tải dữ liệu Moodle');
    } catch (e) {
      if (announce) notify(e instanceof Error ? `Đồng bộ Moodle thất bại: ${e.message}` : 'Đồng bộ Moodle thất bại');
    } finally {
      setSyncing(false);
    }
  };

  const handleManualSync = () => {
    // Clicking a sync button is an explicit gesture: re-check/register this
    // device's FCM token even when the 12-hour registration throttle is active.
    if (user?.id) {
      void ensureFcmTokenRegistered(user.id);
    }
    void sync(true);
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

  useEffect(() => {
    // Teachers also need a device token so they receive artifact-ready pushes
    // for the AI materials they generate themselves.
    if (user?.id) {
      void registerFcmToken(user.id, false);
    }
  }, [user?.id, user?.role]);

  useEffect(() => {
    const storedUser = localStorage.getItem('moodleUser');
    const token = localStorage.getItem('moodleToken');
    if (storedUser) {
      try {
        const parsed = JSON.parse(storedUser) as MoodleUser;

        // Tài khoản bị cấm không được khôi phục phiên (phòng tự động đăng nhập lại sau đăng xuất).
        if (isBlockedAccount(parsed.username)) {
          localStorage.removeItem('moodleToken');
          localStorage.removeItem('moodleUser');
          localStorage.removeItem('moodleData');
          localStorage.removeItem('moodleDataSyncedAt');
          router.push('/login');
          return;
        }

        if (
          token &&
          (!parsed.avatarUrl ||
            parsed.avatarUrl.includes('/u/f1') ||
            parsed.avatarUrl.includes('/u/f2') ||
            !parsed.avatarUrl.startsWith('/api/moodle/avatar'))
        ) {
          parsed.avatarUrl = `/api/moodle/avatar?token=${encodeURIComponent(token)}&id=${parsed.id}`;
        }
        setUser(parsed);
      } catch {
        localStorage.removeItem('moodleUser');
      }
    }

    let needsActivityBackfill = false;
    const storedMoodle = localStorage.getItem('moodleData');
    if (storedMoodle) {
      try {
        const parsed = JSON.parse(storedMoodle) as MoodleData;
        setMoodle(parsed);
        if (!Array.isArray(parsed.activities)) {
          needsActivityBackfill = true;
        }
      } catch {
        localStorage.removeItem('moodleData');
      }
    }

    void sync(needsActivityBackfill, false);

    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // Đồng bộ Moodle định kỳ để lịch và thông tin deadline luôn theo thời gian thực
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (!user?.id) return;
    const timer = setInterval(() => void syncRef.current(false, false), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [user?.id]);

  const moodleCourses: Course[] = useMemo(() => {
    if (!moodle?.courses?.length) return [];
    return moodle.courses.map((course, index) => {
      return {
        id: course.id,
        code: course.shortname,
        name: course.fullname,
        progress: course.progress ?? 0,
        color: defaultColors[index % defaultColors.length],
        icon: course.shortname.slice(0, 2).toUpperCase(),
        next: 'Xem nội dung khóa học',
      };
    });
  }, [moodle]);

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    const items = [
      ...moodleCourses.map(c => ({
        title: c.name,
        meta: `Khóa học Moodle · ${c.code}`,
        action: () =>
          router.push(
            `/course?code=${encodeURIComponent(c.code)}&name=${encodeURIComponent(c.name)}&id=${c.id ?? ''}`
          ),
      })),
      {
        title: 'Tạo quiz luyện tập',
        meta: 'Công cụ AI',
        action: () => router.push('/quiz'),
      },
      {
        title: 'Hỏi gia sư AI',
        meta: 'Gia sư bám nguồn',
        action: () => {
          if (moodleCourses.length > 0) {
            const first = moodleCourses[0];
            router.push(
              `/course?code=${encodeURIComponent(first.code)}&name=${encodeURIComponent(first.name)}&id=${first.id ?? ''}`
            );
          } else {
            router.push('/home');
          }
        },
      },
    ];
    return items.filter(x => (x.title + x.meta).toLowerCase().includes(q)).slice(0, 6);
  }, [search, moodleCourses, router]);

  const mergedDeadlines = useMemo(() => {
    return mergeMoodleDeadlines(moodle?.deadlines ?? []);
  }, [moodle?.deadlines]);

  const activeDeadlines = useMemo(() => {
    const now = Date.now();
    return mergedDeadlines
      .filter(d => (d.closeTimestamp ? d.closeTimestamp > now : d.timestamp > now))
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [mergedDeadlines]);

  const mobileNavTabs = useMemo(
    () => [
      { key: 'Tổng quan', label: 'Tổng quan', icon: LayoutDashboard },
      { key: 'Khóa học', label: 'Khóa học', icon: BookOpen },
      { key: 'Hoạt động', label: 'Hoạt động', icon: CalendarClock },
      { key: 'Bảng điểm', label: 'Bảng điểm', icon: BarChart3 },
    ],
    []
  );
  const mobileActiveIndex = mobileNavTabs.findIndex(t => t.key === active);
  const mobileSlider = useGlassSlider({
    count: mobileNavTabs.length,
    activeIndex: mobileActiveIndex,
    axis: 'x',
    onSelectIndex: idx => {
      const target = mobileNavTabs[idx];
      if (target) {
        setActive(target.key);
        setSearch('');
        window.scrollTo({ top: 0 });
      }
    },
  });

  return (
    <main className="app-shell home-shell">
      <HomeSidebar
        active={active}
        onSelect={tab => {
          setActive(tab);
          setSearch('');
          window.scrollTo({ top: 0 });
        }}
        user={user}
        displayName={user?.fullname || 'Student'}
        syncing={syncing}
        onSync={handleManualSync}
        onOpenProfile={() => setProfile(true)}
        onOpenNotification={handleOpenNotification}
        courses={moodleCourses}
      />
      <div className="home-topbar-mobile">
        <CourseTopBar
          search={search}
          onSearchChange={setSearch}
          searchRef={searchRef}
          syncing={syncing}
          onSync={handleManualSync}
          notifications={notifications}
          onToggleNotifications={() => setNotifications(!notifications)}
          onCloseNotifications={() => setNotifications(false)}
          notificationPermission={notificationPermission}
          onRequestNotificationPermission={undefined}
          courses={moodleCourses}
          user={user}
          displayName={user?.fullname || 'Student'}
          onOpenProfile={() => setProfile(true)}
          onOpenNotification={handleOpenNotification}
          lmsUrl={moodle?.moodleUrl || 'http://moodle.test'}
        />
        <nav className="home-mobile-tabs" aria-label="Điều hướng">
          <div
            className="home-mobile-tabs-track"
            ref={mobileSlider.containerRef}
            {...mobileSlider.handlers}
          >
            {mobileActiveIndex >= 0 && (
              <span
                className={`home-mobile-tabs-slider ${mobileSlider.isDragging ? 'dragging' : ''}`}
                style={{ transform: `translateX(${mobileSlider.sliderX})` }}
                aria-hidden="true"
              />
            )}
            {mobileNavTabs.map(({ key, label, icon: Icon }, idx) => (
              <button
                key={key}
                type="button"
                className={mobileSlider.effectiveIndex === idx ? 'active' : ''}
                onClick={() => {
                  if (mobileSlider.justDraggedRef.current) return;
                  setActive(key);
                  setSearch('');
                  window.scrollTo({ top: 0 });
                }}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </nav>
      </div>

      <section className="content">
        <ErrorBoundary fallbackTitle="Lỗi hiển thị nội dung phân hệ">
        {/* Page content */}
        {active === 'Tổng quan' && (
          <Dashboard
            navigate={navigate}
            openCalendar={() => setCalendar(true)}
            openHomework={openHomework}
            moodle={moodle}
            onSync={handleManualSync}
          />
        )}
        {active === 'Bảng điểm' && (
          <Dashboard
            view="grades"
            navigate={navigate}
            openCalendar={() => setCalendar(true)}
            openHomework={openHomework}
            moodle={moodle}
            onSync={handleManualSync}
          />
        )}
        {active === 'Khóa học' && (
          <CoursesView
            moodle={moodle}
            onSync={handleManualSync}
            syncing={syncing}
            openCourse={(c: Course) =>
              router.push(`/course?code=${encodeURIComponent(c.code)}&name=${encodeURIComponent(c.name)}&id=${c.id ?? ''}`)
            }
          />
        )}
        {active === 'Hoạt động' && (
          <HomeActivitiesPanel
            courses={moodleCourses}
            activities={moodle?.activities ?? []}
            syncing={syncing}
            onSync={handleManualSync}
            onOpenCourse={c =>
              router.push(`/course?code=${encodeURIComponent(c.code || '')}&name=${encodeURIComponent(c.name)}&id=${c.id ?? ''}`)
            }
          />
        )}
        {active === 'Thư viện' && <Library notify={notify} />}
        </ErrorBoundary>
        <SiteFooter />
      </section>


      {/* Overlays */}
      {toast && <Toast text={toast} />}

      {profile && (
        <Modal title="Tài khoản học viên" onClose={() => setProfile(false)}>
          <div className="profile-modal">
            <span className="profile-avatar large">
              {user?.avatarUrl && !avatarError ? (
                <img
                  src={user.avatarUrl}
                  alt={user?.fullname || 'Avatar'}
                  onError={() => setAvatarError(true)}
                />
              ) : (
                (user?.fullname || 'Minh Nguyễn').slice(0, 2).toUpperCase()
              )}
            </span>
            <h3>{user?.fullname || 'Minh Nguyễn'}</h3>
            <p>{user?.username || 'Sinh viên'}</p>
            <div>
              <a
                href={lmsProfileUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setProfile(false)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
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
                  transition: 'background 0.2s',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                onClick={handleLogout}
              >
                <ExternalLink size={14} />
                Đăng xuất
              </button>
            </div>
          </div>
        </Modal>
      )}

      {calendar && (
        <Modal title="Lịch học & Deadline sắp tới" onClose={() => setCalendar(false)}>
          <div className="calendar-list">
            {mergedDeadlines.length ? (
              mergedDeadlines
                .sort((a, b) => a.timestamp - b.timestamp)
                .map(d => <Deadline key={d.id} item={d} onOpen={openHomework} />)
            ) : (
              <div className="empty-state" style={{ padding: '2rem 0' }}>
                Không có lịch học hoặc deadline nào từ Moodle.
              </div>
            )}
          </div>
        </Modal>
      )}

      {selectedHomework && (
        <HomeworkModal
          item={selectedHomework}
          onClose={() => setSelectedHomework(null)}
          onOpenCourse={() => {
            const course = moodleCourses.find(c =>
              (selectedHomework.courseId && Number(c.id) === Number(selectedHomework.courseId)) ||
              c.name.toLowerCase() === selectedHomework.courseName.toLowerCase()
            );
            setSelectedHomework(null);
            router.push(
              `/course?code=${encodeURIComponent(course?.code ?? selectedHomework.courseName)}&name=${encodeURIComponent(selectedHomework.courseName)}&id=${course?.id ?? selectedHomework.courseId ?? ''}`
            );
          }}
        />
      )}
    </main>
  );
}

/* ── Export Root with Suspense ───────────────────────────── */

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="page fade-in" style={{ padding: '2rem' }}>
          <div className="artifact artifact-loading">
            <span className="bot-avatar">✦</span>
            <h3>Đang tải không gian học tập…</h3>
          </div>
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
