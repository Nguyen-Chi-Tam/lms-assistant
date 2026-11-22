'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  LoaderCircle,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { Course, CourseAnalyticsItem, DashboardGradesResponse, ExamResult, MoodleActivityItem } from '@/app/types';
import { useStoredTarget } from '@/app/lib/use-stored-target';
import { resolveGradeRoute, formatGrade } from '@/app/lib/grade-router';
import { askPuterJSON } from '@/app/lib/puter-client';
import { appendFeedbackHistory } from '@/app/lib/feedback-history';
import { AcademicAdvisorChat } from '@/app/components/dashboard/AcademicAdvisorChat';

interface HomeLearningDashboardProps {
  courses: Course[];
  grades: ExamResult[];
  activities?: MoodleActivityItem[];
  userId?: number;
  latestResult?: ExamResult | null;
  analyzedAttemptIds?: Set<number>;
  onOpenQuizAnalysis?: (exam: ExamResult) => void;
  onOpenGradeHistory: () => void;
  onOpenCourse: (course: Course) => void;
}

type CoursePerformance = {
  course: Course;
  grades: ExamResult[];
  average: number | null;
  first: number | null;
  latest: number | null;
  trend: number | null;
};

type Roadmap = {
  steps: Array<{ title: string; actions: string[] }>;
};

type UnifiedCourse = {
  key: string;
  course: Course;
  perf: CoursePerformance | null;
  live: CourseAnalyticsItem | null;
};

const scoreOf = (grade: ExamResult) => (grade.maxScore ? (grade.score / grade.maxScore) * 10 : 0);

const TARGET_STORAGE_KEY = 'homepage-average-target';

function formatScore(value: number | null) {
  return value === null ? '—' : value.toFixed(1);
}

function trendLabel(trend: CourseAnalyticsItem['grade_summary']['trend']) {
  if (trend === 'improving') return 'Đang cải thiện';
  if (trend === 'declining') return 'Cần chú ý';
  if (trend === 'stable') return 'Ổn định';
  return 'Chưa đủ dữ liệu';
}

export function HomeLearningDashboard({
  courses,
  grades,
  activities = [],
  userId,
  latestResult,
  analyzedAttemptIds,
  onOpenQuizAnalysis,
  onOpenGradeHistory,
  onOpenCourse,
}: HomeLearningDashboardProps) {
  const router = useRouter();
  const [target, saveTarget] = useStoredTarget(TARGET_STORAGE_KEY);
  const [liveData, setLiveData] = useState<DashboardGradesResponse | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [roadmapFor, setRoadmapFor] = useState<number | null>(null);
  const [roadmaps, setRoadmaps] = useState<Record<number, Roadmap>>({});
  const [subTab, setSubTab] = useState<'overview' | 'advisor'>('overview');

  const loadLiveGrades = useCallback(async () => {
    setLiveLoading(true);
    setLiveError(null);
    try {
      const token = window.localStorage.getItem('moodleToken');
      const response = await fetch('/api/dashboard/grades?force=true', {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const payload = (await response.json()) as DashboardGradesResponse;
      if (!response.ok && payload.mode !== 'demo') throw new Error(payload.error || 'Không thể tải bảng điểm.');
      setLiveData(payload);
      if (payload.error && payload.mode !== 'demo') setLiveError(payload.error);
    } catch (loadError) {
      setLiveError(loadError instanceof Error ? loadError.message : 'Không thể tải bảng điểm.');
    } finally {
      setLiveLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLiveGrades();
  }, [loadLiveGrades, userId]);

  const performances = useMemo<CoursePerformance[]>(
    () =>
      courses.map(course => {
        const courseGrades = grades
          .filter(grade =>
            (course.id && String(grade.courseId) === String(course.id)) ||
            (course.code && grade.courseCode?.toLowerCase() === course.code.toLowerCase()) ||
            (course.name && grade.courseName?.toLowerCase() === course.name.toLowerCase())
          )
          .sort((a, b) => (a.gradedAt || 0) - (b.gradedAt || 0));
        const normalized = courseGrades.map(scoreOf);
        const average = normalized.length ? normalized.reduce((sum, score) => sum + score, 0) / normalized.length : null;
        const first = normalized[0] ?? null;
        const latest = normalized.at(-1) ?? null;
        return { course, grades: courseGrades, average, first, latest, trend: first !== null && latest !== null ? latest - first : null };
      }),
    [courses, grades]
  );

  const liveCourses = useMemo<CourseAnalyticsItem[]>(() => liveData?.courses ?? [], [liveData]);

  // One row per course: home-grade history (0-10) merged with the live LMS analytics.
  const rows = useMemo<UnifiedCourse[]>(() => {
    const index = new Map<string, CourseAnalyticsItem>();
    for (const item of liveCourses) {
      if (item.courseId) index.set(`id:${item.courseId}`, item);
      if (item.courseCode) index.set(`code:${item.courseCode.toLowerCase().trim()}`, item);
      if (item.courseName) index.set(`name:${item.courseName.toLowerCase().trim()}`, item);
    }
    const lookup = (course: Course) =>
      (course.id ? index.get(`id:${course.id}`) : undefined) ||
      (course.code ? index.get(`code:${course.code.toLowerCase().trim()}`) : undefined) ||
      (course.name ? index.get(`name:${course.name.toLowerCase().trim()}`) : undefined) ||
      null;

    const matchedLive = new Set<CourseAnalyticsItem>();
    const merged: UnifiedCourse[] = performances.map(perf => {
      const live = lookup(perf.course);
      if (live) matchedLive.add(live);
      return { key: `course-${perf.course.id ?? perf.course.code}`, course: perf.course, perf, live };
    });

    for (const live of liveCourses) {
      if (matchedLive.has(live)) continue;
      const code = live.courseCode || live.courseName.slice(0, 6).toUpperCase();
      merged.push({
        key: `live-${live.courseId}`,
        course: {
          id: live.courseId,
          code,
          name: live.courseName,
          progress: 0,
          color: '#9f1d35',
          icon: code.slice(0, 2).toUpperCase(),
          next: 'Khóa học Moodle',
        },
        perf: null,
        live,
      });
    }

    return merged;
  }, [performances, liveCourses]);

  const scoredCourses = performances.filter(item => item.average !== null);
  const scoredRows = rows.filter(
    row => (row.perf?.average ?? null) !== null || row.live?.grade_summary.average_pct != null
  ).length;
  const overallAverage = scoredCourses.length
    ? scoredCourses.reduce((sum, item) => sum + (item.average || 0), 0) / scoredCourses.length
    : null;
  const strongest = scoredCourses.reduce<CoursePerformance | null>(
    (best, item) => (!best || (item.average || 0) > (best.average || 0) ? item : best),
    null
  );
  const weakest = scoredCourses.reduce<CoursePerformance | null>(
    (worst, item) => (!worst || (item.average || 0) < (worst.average || 0) ? item : worst),
    null
  );
  const improving = scoredCourses.filter(item => (item.trend || 0) > 0.2).length;
  const declining = scoredCourses.filter(item => (item.trend || 0) < -0.2).length;
  const targetGap = overallAverage === null ? 0 : overallAverage - target;
  const averageStatus = overallAverage === null ? null : overallAverage >= target ? 'pass' : overallAverage >= target - 2 ? 'close' : 'fail';

  const strengthsAndWeaknesses = useMemo(() => {
    const strengthsList: Array<{ course: string; detail: string; score: number }> = [];
    const weaknessesList: Array<{ course: string; detail: string; score: number | null }> = [];

    for (const row of rows) {
      const avg10 = row.perf?.average ?? (row.live?.grade_summary.average_pct != null ? row.live.grade_summary.average_pct / 10 : null);
      const latestItem = [...(row.perf?.grades ?? [])].sort((a, b) => (b.gradedAt || 0) - (a.gradedAt || 0))[0];
      if (avg10 !== null && avg10 >= 8.0) {
        strengthsList.push({
          course: row.course.name,
          detail: latestItem ? `${latestItem.name} (${formatGrade(latestItem.score)}/${formatGrade(latestItem.maxScore)})` : `Trung bình ${avg10.toFixed(1)}/10`,
          score: avg10,
        });
      } else if (avg10 !== null && avg10 < Math.max(6.5, target)) {
        weaknessesList.push({
          course: row.course.name,
          detail: latestItem ? `${latestItem.name} (${formatGrade(latestItem.score)}/${formatGrade(latestItem.maxScore)})` : `Trung bình ${avg10.toFixed(1)}/10`,
          score: avg10,
        });
      }
      for (const g of row.perf?.grades ?? []) {
        const s10 = scoreOf(g);
        if (s10 < 6.5 && !weaknessesList.some(w => w.course === row.course.name)) {
          weaknessesList.push({
            course: row.course.name,
            detail: `${g.name} (${formatGrade(g.score)}/${formatGrade(g.maxScore)})`,
            score: s10,
          });
        }
      }
    }

    return { strengthsList, weaknessesList };
  }, [rows, target]);

  const academicContext = useMemo(() => {
    const gpaStr = overallAverage !== null ? `${overallAverage.toFixed(2)}/10` : 'Chưa có GPA';
    const courseLines = rows.map(row => {
      const avg10 = row.perf?.average ?? (row.live?.grade_summary.average_pct != null ? row.live.grade_summary.average_pct / 10 : null);
      const latestItem = [...(row.perf?.grades ?? [])].sort((a, b) => (b.gradedAt || 0) - (a.gradedAt || 0))[0];
      const allItems = (row.perf?.grades ?? []).map(g => `${g.name}: ${g.score}/${g.maxScore}`).join(', ');
      return `- ${row.course.name} (${row.course.code}): TB=${avg10 !== null ? avg10.toFixed(1) + '/10' : 'Chưa có điểm'}${latestItem ? `, Mới nhất: ${latestItem.name} (${latestItem.score}/${latestItem.maxScore})` : ''}${allItems ? ` | Chi tiết: ${allItems}` : ''}`;
    });

    const missedHw = activities.filter(a => a.type === 'homework' && a.status === 'missed');
    const missedAtt = activities.filter(a => a.type === 'attendance' && a.status === 'missed');
    const pendingAct = activities.filter(a => a.status === 'pending' || a.status === 'open_now');

    return [
      `GPA tổng hiện tại: ${gpaStr} | Mục tiêu: ${target.toFixed(1)}/10`,
      `Khóa học nổi bật: ${strongest ? `${strongest.course.name} (${formatScore(strongest.average)}/10)` : 'Chưa có'}`,
      `Khóa học cần ưu tiên cải thiện: ${weakest ? `${weakest.course.name} (${formatScore(weakest.average)}/10)` : 'Chưa có'}`,
      `Danh sách môn học & điểm số:\n${courseLines.join('\n')}`,
      `Hoạt động & Chuyên cần:`,
      `- Bài tập quá hạn chưa nộp (${missedHw.length}): ${missedHw.map(h => `${h.courseCode}: ${h.name}`).join('; ') || 'Không có'}`,
      `- Buổi điểm danh đã qua / có thể bỏ lỡ (${missedAtt.length}): ${missedAtt.map(a => `${a.courseCode}: ${a.name}`).join('; ') || 'Không có'}`,
      `- Hoạt động sắp tới / đang mở (${pendingAct.length}): ${pendingAct.slice(0, 6).map(p => `${p.courseCode}: ${p.name}`).join('; ') || 'Không có'}`,
    ].join('\n');
  }, [overallAverage, target, strongest, weakest, rows, activities]);

  const createRoadmap = useCallback(
    async (course: CourseAnalyticsItem, navCourse?: Course) => {
      let storedUserId = 0;
      try {
        const storedUser = JSON.parse(window.localStorage.getItem('moodleUser') || '{}') as { id?: number };
        storedUserId = Number(storedUser.id) || 0;
      } catch {
        storedUserId = 0;
      }
      const resolvedUserId = userId || storedUserId;
      if (!resolvedUserId) {
        setLiveError('Vui lòng đăng nhập Moodle trước khi tạo lộ trình.');
        return;
      }
      setRoadmapFor(course.courseId);
      setLiveError(null);
      try {
        const roadmap = await askPuterJSON<Roadmap>(
          `Tạo lộ trình học 3 bước bằng tiếng Việt cho khóa học "${course.courseName}".
Điểm yếu: ${course.grade_summary.weaknesses.join(', ') || 'chưa xác định'}.
Xu hướng: ${trendLabel(course.grade_summary.trend)}.
Điểm mạnh: ${course.grade_summary.strengths.join(', ') || 'chưa xác định'}.
Trả về JSON dạng {"steps":[{"title":"...","actions":["..."]}]} với đúng 3 steps.`
        );
        if (!Array.isArray(roadmap.steps) || roadmap.steps.length !== 3) {
          throw new Error('Lộ trình phải có đúng 3 bước.');
        }
        // Lưu lộ trình vào lịch sử phản hồi trên localStorage (theo ngày).
        appendFeedbackHistory(resolvedUserId, course.courseId, {
          activity_type: 'roadmap',
          score_label: `${course.grade_summary.average_pct ?? 0}%`,
          ai_feedback: roadmap.steps.map(step => step.title).join(' → '),
          improvement_plan: roadmap.steps
            .map((step, index) => `${index + 1}. ${step.actions.join('; ')}`)
            .join('\n'),
        });

        const stepsText = roadmap.steps
          .map((step, index) => `${index + 1}. ${step.title}\n${step.actions.map(action => `• ${action}`).join('\n')}`)
          .join('\n\n');
        const recommendation = `Học tập ưu tiên: ${roadmap.steps[0]?.title || course.courseName}. Tập trung vào các điểm yếu đã xác định, ôn luyện đều đặn và kiểm tra lại điểm sau mỗi bước.`;
        const intent = `Tôi muốn nhận lộ trình học và hướng dẫn cho khóa học "${course.courseName}".\n\nLộ trình đề xuất:\n${stepsText}\n\nHướng dẫn học tập:\n${recommendation}\n\nHãy hỗ trợ tôi chi tiết hơn cho từng bước và đề xuất bài tập tương ứng.`;

        // Bypass quick-test gate so the chat opens without interruption.
        window.localStorage.setItem(`quick-test:${course.courseId}`, String(Date.now()));

        const code = navCourse?.code || course.courseCode || course.courseName.slice(0, 6).toUpperCase();
        const name = navCourse?.name || course.courseName;
        const id = navCourse?.id ?? course.courseId;
        router.push(`/course?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}&id=${id}&intent=${encodeURIComponent(intent)}`);

        setRoadmaps(current => ({ ...current, [course.courseId]: roadmap }));
      } catch (roadmapError) {
        setLiveError(roadmapError instanceof Error ? roadmapError.message : 'Không thể tạo lộ trình.');
      } finally {
        setRoadmapFor(null);
      }
    },
    [userId, router]
  );

  return (
    <section className="home-learning-dashboard" aria-labelledby="home-learning-dashboard-title">
      <div className="home-learning-dashboard-head">
        <div>
          <h2 id="home-learning-dashboard-title">Bảng điểm</h2>
          <p>
            Tổng hợp kết quả học tập theo khóa học
            {liveData?.syncedAt ? ` · Cập nhật ${new Date(liveData.syncedAt).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
          </p>
        </div>
        <div className="home-learning-dashboard-head-actions">
          <div className="dashboard-subtabs" role="tablist" aria-label="Chế độ xem bảng điểm">
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'overview'}
              className={subTab === 'overview' ? 'active' : ''}
              onClick={() => setSubTab('overview')}
            >
              <BarChart3 size={14} />
              <span>Tổng quan điểm</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'advisor'}
              className={subTab === 'advisor' ? 'active' : ''}
              onClick={() => setSubTab('advisor')}
            >
              <MessageSquare size={14} />
              <span>Cố vấn AI</span>
            </button>
          </div>
          <button type="button" className="home-learning-dashboard-history" onClick={onOpenGradeHistory}>
            <BarChart3 size={14} /> Chi tiết điểm
          </button>
        </div>
      </div>

      {subTab === 'advisor' ? (
        <AcademicAdvisorChat
          academicContext={academicContext}
          userId={userId}
          targetGpa={target}
        />
      ) : (
      <>
      <div className="home-learning-dashboard-summary">
        <div className="home-learning-score-card primary">
          <span>Điểm trung bình</span>
          <strong className={averageStatus ? `home-learning-avg-${averageStatus}` : ''}>{formatScore(overallAverage)}<small>/10</small></strong>
          <div className={`home-learning-progress ${averageStatus || ''}`}><i style={{ width: `${Math.min(100, Math.max(0, (overallAverage || 0) * 10))}%` }} /></div>
          <em>{targetGap >= 0 ? `Đạt mục tiêu (+${targetGap.toFixed(1)})` : `Thiếu ${Math.abs(targetGap).toFixed(1)} điểm`}</em>
        </div>
        <div className="home-learning-score-card">
          <span>Môn cao nhất</span>
          <strong className="home-learning-course-value">{strongest ? strongest.course.code || strongest.course.name : '—'}</strong>
          <em>{strongest ? `${formatScore(strongest.average)}/10` : 'Chưa có dữ liệu'}</em>
        </div>
        <div className="home-learning-score-card">
          <span>Xu hướng</span>
          <strong className="home-learning-trend-value"><TrendingUp size={18} /> {improving} cải thiện</strong>
          <em>{declining} môn cần chú ý</em>
        </div>
      </div>

      {latestResult && (
        <div className="home-learning-latest-card">
          <div className="home-learning-latest-left">
            <div className="home-learning-latest-badge-row">
              <span className="home-learning-latest-tag">
                <Sparkles size={12} /> Kết quả bài thi mới nhất
              </span>
              <span className={`result-status-tag ${latestResult.passed ? 'pass' : 'fail'}`}>
                {latestResult.passed ? '✓ Đạt' : '✕ Cần cải thiện'}
              </span>
              <span className="result-course-code">{(latestResult.courseCode || 'MOODLE').toUpperCase()}</span>
              <span className="result-course-title" title={latestResult.courseName}>
                {latestResult.courseName}
              </span>
            </div>
            <h3 className="home-learning-latest-name" title={latestResult.name}>
              {latestResult.name}
            </h3>
            {latestResult.feedback && latestResult.feedback !== '-' && (
              <div className="home-learning-latest-feedback">
                <MessageSquare size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>"{latestResult.feedback}"</span>
              </div>
            )}
          </div>

          <div className="home-learning-latest-right">
            <div className="home-learning-latest-score-group">
              <div className="home-learning-score-num-wrap">
                <span className={`home-learning-score-val ${latestResult.passed ? 'pass' : 'fail'}`}>
                  {formatGrade(latestResult.score)}
                </span>
                <span className="home-learning-score-denom">/{formatGrade(latestResult.maxScore)}</span>
              </div>
              <div className="home-learning-mini-track">
                <div
                  className={`result-progress-bar ${latestResult.passed ? 'pass' : 'fail'}`}
                  style={{
                    width: `${Math.min(100, Math.max(0, (latestResult.score / (latestResult.maxScore || 10)) * 100))}%`,
                  }}
                />
              </div>
            </div>

            {latestResult.gradedAt && (
              <div className="home-learning-latest-date-tag">
                <CalendarDays size={12} />
                <span>
                  {new Date(latestResult.gradedAt).toLocaleDateString('vi-VN', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  })}
                </span>
              </div>
            )}

            {onOpenQuizAnalysis && (() => {
              const isAnalyzed = !!latestResult?.attemptId && analyzedAttemptIds?.has(Number(latestResult.attemptId));
              const route = resolveGradeRoute(latestResult, !!isAnalyzed);
              return (
                <button
                  type="button"
                  className="result-ai-btn home-learning-latest-ai-btn"
                  onClick={() => onOpenQuizAnalysis(latestResult)}
                  title={route.buttonTooltip}
                  style={{
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
      )}

      <div className="home-learning-target">
        <div>
          <div className="home-learning-panel-title">
            <Target size={16} /> Mục tiêu GPA
            <span style={{ marginLeft: '6px', color: target <= 6.0 ? '#34d399' : '#e06c82', fontWeight: 600 }}>
              ({target <= 6.0 ? '> 5.0' : '> 8.0'})
            </span>
          </div>
          <p>
            {target <= 6.0 ? 'Mức qua môn (> 5.0)' : 'Mức giỏi / xuất sắc (> 8.0)'}
          </p>
        </div>
        <div className="home-learning-target-presets">
          <button
            type="button"
            className={`home-learning-target-btn ${target <= 6.0 ? 'active pass-mode' : ''}`}
            onClick={() => saveTarget(5.0)}
            title="Mục tiêu qua môn (> 5.0)"
          >
            <ShieldCheck size={14} />
            <span>Qua môn (&gt; 5.0)</span>
          </button>
          <button
            type="button"
            className={`home-learning-target-btn ${target > 6.0 ? 'active excel-mode' : ''}`}
            onClick={() => saveTarget(8.0)}
            title="Mục tiêu xuất sắc (> 8.0)"
          >
            <Sparkles size={14} />
            <span>Xuất sắc (&gt; 8.0)</span>
          </button>
        </div>
      </div>

      <div className="home-learning-courses">
        <div className="home-learning-panel-title">
          <BookOpen size={16} /> Phân tích theo khóa học
          <span className="home-learning-panel-meta">
            {liveLoading && <LoaderCircle className="quick-test-spin" size={12} />}
            {liveLoading ? 'Đang đồng bộ điểm LMS…' : `${scoredRows}/${rows.length} có điểm`}
          </span>
        </div>
        {liveError && <p role="alert" className="home-learning-empty">{liveError}</p>}
        {rows.length === 0 ? (
          <p className="home-learning-empty">Chưa có khóa học để phân tích. Hãy đồng bộ Moodle.</p>
        ) : (
          rows.map(item => {
            const courseGrades = item.perf?.grades ?? [];
            const liveSummary = item.live?.grade_summary;
            const liveAverage10 =
              liveSummary?.average_pct != null ? liveSummary.average_pct / 10 : null;
            const displayAverage = item.perf?.average ?? liveAverage10;
            const score = displayAverage ?? 0;
            const trendValue = item.perf?.trend ?? null;
            const isImproving = trendValue !== null ? trendValue > 0.2 : liveSummary?.trend === 'improving';
            const isDeclining = trendValue !== null ? trendValue < -0.2 : liveSummary?.trend === 'declining';
            const signalText =
              trendValue !== null
                ? isImproving
                  ? `+${trendValue.toFixed(1)} điểm`
                  : isDeclining
                    ? `${trendValue.toFixed(1)} điểm`
                    : 'Ổn định'
                : liveSummary
                  ? `${trendLabel(liveSummary.trend)}${liveSummary.delta != null ? ` (${liveSummary.delta > 0 ? '+' : ''}${liveSummary.delta}%)` : ''}`
                  : 'Chưa đủ dữ liệu';
            const roadmap = item.live ? roadmaps[item.live.courseId] : undefined;
            const creatingRoadmap = Boolean(item.live && roadmapFor === item.live.courseId);

            return (
              <div className="home-learning-course-item" key={item.key}>
                <div className="home-learning-course-row">
                  <div className="home-learning-course-main">
                    <span className="home-learning-course-dot" style={{ background: item.course.color }} />
                    <div>
                      <strong>{item.course.name}</strong>
                      <small>
                        {item.course.code || 'Moodle'} · {courseGrades.length} đầu điểm
                        {courseGrades.length > 0
                          ? ` · Mới nhất: ${courseGrades[courseGrades.length - 1].name} (${formatGrade(courseGrades[courseGrades.length - 1].score)}/${formatGrade(courseGrades[courseGrades.length - 1].maxScore)})`
                          : ''}
                        {liveSummary ? ` · ${liveSummary.strengths.length} điểm mạnh · ${liveSummary.weaknesses.length} cần củng cố` : ''}
                      </small>
                    </div>
                  </div>
                  <div className="home-learning-course-average">
                    <strong>{formatScore(displayAverage)}<small>/10</small></strong>
                    <i><u style={{ width: `${Math.min(100, Math.max(0, score * 10))}%`, background: item.course.color }} /></i>
                  </div>
                  <div className={`home-learning-course-signal ${isImproving ? 'improving' : isDeclining ? 'declining' : ''}`}>
                    {isImproving ? <TrendingUp size={13} /> : isDeclining ? <TrendingDown size={13} /> : <CheckCircle2 size={13} />}
                    {signalText}
                  </div>
                  <div className="home-learning-course-actions">
                    {item.live && (
                      <button
                        type="button"
                        className="home-learning-course-action"
                        onClick={() => void createRoadmap(item.live!, item.course)}
                        disabled={creatingRoadmap}
                        title="Tạo lộ trình 3 bước bằng AI từ điểm mạnh / điểm yếu của khóa học"
                      >
                        <Sparkles size={14} /> {creatingRoadmap ? 'Đang tạo…' : 'Tạo lộ trình'}
                      </button>
                    )}
                  </div>
                </div>
                {roadmap && (
                  <div className="home-learning-roadmap">
                    {roadmap.steps.map((step, index) => (
                      <div key={`${item.key}-step-${index}`}>
                        <strong>{index + 1}. {step.title}</strong>
                        <p>{step.actions.join(' · ')}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="home-learning-sw-grid">
        <article className="home-learning-sw-card strength">
          <div className="home-learning-panel-title">
            <TrendingUp size={15} /> Điểm mạnh ({strengthsAndWeaknesses.strengthsList.length})
          </div>
          {strengthsAndWeaknesses.strengthsList.length === 0 ? (
            <p className="home-learning-empty">Chưa có môn đạt từ 8.0 trở lên.</p>
          ) : (
            <ul className="home-learning-sw-list">
              {strengthsAndWeaknesses.strengthsList.map((s, i) => (
                <li key={i}>
                  <strong>{s.course}</strong>
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="home-learning-sw-card weakness">
          <div className="home-learning-panel-title">
            <TrendingDown size={15} /> Cần cải thiện ({strengthsAndWeaknesses.weaknessesList.length})
          </div>
          {strengthsAndWeaknesses.weaknessesList.length === 0 ? (
            <p className="home-learning-empty">Không có môn dưới mục tiêu.</p>
          ) : (
            <ul className="home-learning-sw-list">
              {strengthsAndWeaknesses.weaknessesList.map((w, i) => (
                <li key={i}>
                  <strong>{w.course}</strong>
                  <span>{w.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      <div className="home-learning-recommendation">
        <div className="home-learning-recommendation-icon"><Target size={18} /></div>
        <div>
          <strong>Đề xuất ưu tiên</strong>
          <p>
            {weakest
              ? `Tập trung ôn ${weakest.course.name} để nâng điểm trên ${target.toFixed(1)}.`
              : 'Chưa đủ dữ liệu điểm để đề xuất.'}
          </p>
        </div>
        {weakest && <button type="button" onClick={() => onOpenCourse(weakest.course)}>Ôn tập <ArrowRight size={14} /></button>}
      </div>
      </>
      )}
    </section>
  );
}
