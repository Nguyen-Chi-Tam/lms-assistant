'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, BookOpen, LoaderCircle, Sparkles } from 'lucide-react';
import type { CourseAnalyticsItem, DashboardGradesResponse } from '@/app/types';
import { askPuterJSON } from '@/app/lib/puter-client';
import { appendFeedbackHistory } from '@/app/lib/feedback-history';

type Roadmap = {
  steps: Array<{ title: string; actions: string[] }>;
};

function trendLabel(trend: CourseAnalyticsItem['grade_summary']['trend']) {
  if (trend === 'improving') return 'Đang cải thiện';
  if (trend === 'declining') return 'Cần chú ý';
  if (trend === 'stable') return 'Ổn định';
  return 'Chưa đủ dữ liệu';
}

export function DashboardGradesPanel({ userId }: { userId?: number }) {
  const router = useRouter();
  const [data, setData] = useState<DashboardGradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [roadmapFor, setRoadmapFor] = useState<number | null>(null);
  const [roadmaps, setRoadmaps] = useState<Record<number, Roadmap>>({});
  const [error, setError] = useState<string | null>(null);

  const loadGrades = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = window.localStorage.getItem('moodleToken');
      const response = await fetch('/api/dashboard/grades?force=true', {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const payload = (await response.json()) as DashboardGradesResponse;
      if (!response.ok && payload.mode !== 'demo') throw new Error(payload.error || 'Không thể tải bảng điểm.');
      setData(payload);
      if (payload.error && payload.mode !== 'demo') setError(payload.error);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Không thể tải bảng điểm.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGrades();
  }, [loadGrades, userId]);

  const createRoadmap = useCallback(
    async (course: CourseAnalyticsItem) => {
      let storedUserId = 0;
      try {
        const storedUser = JSON.parse(window.localStorage.getItem('moodleUser') || '{}') as { id?: number };
        storedUserId = Number(storedUser.id) || 0;
      } catch {
        storedUserId = 0;
      }
      const resolvedUserId = userId || storedUserId;
      if (!resolvedUserId) {
        setError('Vui lòng đăng nhập Moodle trước khi tạo lộ trình.');
        return;
      }
      setRoadmapFor(course.courseId);
      setError(null);
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
          improvement_plan: roadmap.steps.map((step, index) => `${index + 1}. ${step.actions.join('; ')}`).join('\n'),
        });

        const stepsText = roadmap.steps
          .map((step, index) => `${index + 1}. ${step.title}\n${step.actions.map(action => `• ${action}`).join('\n')}`)
          .join('\n\n');
        const recommendation = `Học tập ưu tiên: ${roadmap.steps[0]?.title || course.courseName}. Tập trung vào các điểm yếu đã xác định, ôn luyện đều đặn và kiểm tra lại điểm sau mỗi bước.`;
        const intent = `Tôi muốn nhận lộ trình học và hướng dẫn cho khóa học "${course.courseName}".\n\nLộ trình đề xuất:\n${stepsText}\n\nHướng dẫn học tập:\n${recommendation}\n\nHãy hỗ trợ tôi chi tiết hơn cho từng bước và đề xuất bài tập tương ứng.`;

        // Bypass quick-test gate so the chat opens without interruption.
        window.localStorage.setItem(`quick-test:${course.courseId}`, String(Date.now()));

        const code = course.courseCode || course.courseName.slice(0, 6).toUpperCase();
        router.push(`/course?code=${encodeURIComponent(code)}&name=${encodeURIComponent(course.courseName)}&id=${course.courseId}&intent=${encodeURIComponent(intent)}`);

        setRoadmaps(current => ({ ...current, [course.courseId]: roadmap }));
      } catch (roadmapError) {
        setError(roadmapError instanceof Error ? roadmapError.message : 'Không thể tạo lộ trình.');
      } finally {
        setRoadmapFor(null);
      }
    },
    [userId, router]
  );

  if (loading) {
    return <section className="home-learning-dashboard"><LoaderCircle className="quick-test-spin" size={20} /> Đang đồng bộ bảng điểm tổng hợp…</section>;
  }

  const courses = data?.courses || [];
  return (
    <section className="home-learning-dashboard" aria-labelledby="grades-dashboard-title">
      <div className="home-learning-dashboard-head">
        <div>
          <p className="eyebrow">LIVE GRADE ANALYTICS</p>
          <h2 id="grades-dashboard-title">Bảng điểm tổng hợp</h2>
          <p>{data?.syncedAt ? `Đồng bộ lúc ${new Date(data.syncedAt).toLocaleString('vi-VN')}` : 'Dữ liệu điểm từ Moodle'}</p>
        </div>
      </div>
      {courses.length === 0 ? (
        <p className="home-learning-empty">Chưa có dữ liệu điểm live. Hãy kiểm tra token Moodle và thử đồng bộ lại.</p>
      ) : (
        <div className="home-learning-courses">
          {courses.map(course => {
            const summary = course.grade_summary;
            const roadmap = roadmaps[course.courseId];
            const trendIcon = summary.trend === 'declining' ? <ArrowDown size={14} /> : <ArrowUp size={14} />;
            return (
              <article className="home-learning-course-row" key={course.courseId}>
                <div className="home-learning-course-main"><BookOpen size={16} /><div><strong>{course.courseName}</strong><small>{summary.strengths.length} điểm mạnh · {summary.weaknesses.length} điểm cần củng cố</small></div></div>
                <div className="home-learning-course-average"><strong>{summary.average_pct ?? '—'}<small>%</small></strong><i><u style={{ width: `${summary.average_pct || 0}%` }} /></i></div>
                <div className={`home-learning-course-signal ${summary.trend === 'improving' ? 'improving' : summary.trend === 'declining' ? 'declining' : ''}`}>{summary.delta !== null && trendIcon}{trendLabel(summary.trend)}{summary.delta !== null ? ` (${summary.delta > 0 ? '+' : ''}${summary.delta}%)` : ''}</div>
                {roadmap && <div style={{ gridColumn: '1 / -1', marginTop: '0.5rem', padding: '0.75rem', borderRadius: '12px', background: 'rgba(185, 43, 71,0.08)' }}>{roadmap.steps.map((step, index) => <div key={`${course.courseId}-${index}`}><strong>{index + 1}. {step.title}</strong><p style={{ margin: '0.25rem 0 0.5rem', color: 'var(--muted)' }}>{step.actions.join(' · ')}</p></div>)}</div>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
