'use client';

import { useMemo } from 'react';
import { Bot } from 'lucide-react';
import type { Course, ExamResult, MoodleActivityItem } from '@/app/types';
import { useStoredTarget } from '@/app/lib/use-stored-target';
import { AcademicAdvisorChat } from '@/app/components/dashboard/AcademicAdvisorChat';

interface HomeAiHelperPanelProps {
  courses: Course[];
  grades: ExamResult[];
  activities?: MoodleActivityItem[];
  userId?: number;
}

const TARGET_STORAGE_KEY = 'homepage-average-target';

const scoreOf = (grade: ExamResult) => (grade.maxScore ? (grade.score / grade.maxScore) * 10 : 0);

function formatScore(value: number | null) {
  return value === null ? '—' : value.toFixed(1);
}

export function HomeAiHelperPanel({
  courses,
  grades,
  activities = [],
  userId,
}: HomeAiHelperPanelProps) {
  const [target] = useStoredTarget(TARGET_STORAGE_KEY);

  const academicContext = useMemo(() => {
    const performances = courses.map(course => {
      const courseGrades = grades
        .filter(
          grade =>
            (course.id && String(grade.courseId) === String(course.id)) ||
            (course.code && grade.courseCode?.toLowerCase() === course.code.toLowerCase()) ||
            (course.name && grade.courseName?.toLowerCase() === course.name.toLowerCase())
        )
        .sort((a, b) => (a.gradedAt || 0) - (b.gradedAt || 0));
      const normalized = courseGrades.map(scoreOf);
      const average = normalized.length
        ? normalized.reduce((sum, score) => sum + score, 0) / normalized.length
        : null;
      return { course, grades: courseGrades, average };
    });

    const scoredCourses = performances.filter(item => item.average !== null);
    const overallAverage = scoredCourses.length
      ? scoredCourses.reduce((sum, item) => sum + (item.average || 0), 0) / scoredCourses.length
      : null;
    const strongest = scoredCourses.reduce<(typeof performances)[number] | null>(
      (best, item) => (!best || (item.average || 0) > (best.average || 0) ? item : best),
      null
    );
    const weakest = scoredCourses.reduce<(typeof performances)[number] | null>(
      (worst, item) => (!worst || (item.average || 0) < (worst.average || 0) ? item : worst),
      null
    );

    const avgStr = overallAverage !== null ? `${overallAverage.toFixed(2)}/10` : 'Chưa có điểm trung bình';
    const courseLines = performances.map(perf => {
      const latestItem = [...perf.grades].sort((a, b) => (b.gradedAt || 0) - (a.gradedAt || 0))[0];
      const allItems = perf.grades.map(g => `${g.name}: ${g.score}/${g.maxScore}`).join(', ');
      return `- ${perf.course.name} (${perf.course.code}): TB=${perf.average !== null ? perf.average.toFixed(1) + '/10' : 'Chưa có điểm'}${latestItem ? `, Mới nhất: ${latestItem.name} (${latestItem.score}/${latestItem.maxScore})` : ''}${allItems ? ` | Chi tiết: ${allItems}` : ''}`;
    });

    const missedHw = activities.filter(a => a.type === 'homework' && a.status === 'missed');
    const missedAtt = activities.filter(a => a.type === 'attendance' && a.status === 'missed');
    const pendingAct = activities.filter(a => a.status === 'pending' || a.status === 'open_now');

    return [
      `Điểm trung bình LMS hiện tại: ${avgStr} | Mục tiêu: ${target.toFixed(1)}/10`,
      `Khóa học nổi bật: ${strongest ? `${strongest.course.name} (${formatScore(strongest.average)}/10)` : 'Chưa có'}`,
      `Khóa học cần ưu tiên cải thiện: ${weakest ? `${weakest.course.name} (${formatScore(weakest.average)}/10)` : 'Chưa có'}`,
      `Danh sách môn học & điểm số:\n${courseLines.join('\n')}`,
      `Hoạt động & Chuyên cần:`,
      `- Bài tập quá hạn chưa nộp (${missedHw.length}): ${missedHw.map(h => `${h.courseCode}: ${h.name}`).join('; ') || 'Không có'}`,
      `- Buổi điểm danh đã qua / có thể bỏ lỡ (${missedAtt.length}): ${missedAtt.map(a => `${a.courseCode}: ${a.name}`).join('; ') || 'Không có'}`,
      `- Hoạt động sắp tới / đang mở (${pendingAct.length}): ${pendingAct.slice(0, 6).map(p => `${p.courseCode}: ${p.name}`).join('; ') || 'Không có'}`,
    ].join('\n');
  }, [courses, grades, activities, target]);

  return (
    <section className="home-learning-dashboard" aria-labelledby="home-ai-helper-title">
      <div className="home-learning-dashboard-head">
        <div className="advisor-chat-title-wrap">
          <span className="advisor-chat-orb">
            <Bot size={18} />
          </span>
          <div>
            <h2 id="home-ai-helper-title">AI Helper</h2>
            <p>Hỏi đáp về điểm số, bài tập và kế hoạch học tập</p>
          </div>
        </div>
      </div>

      <AcademicAdvisorChat
        academicContext={academicContext}
        userId={userId}
        targetGpa={target}
      />
    </section>
  );
}
