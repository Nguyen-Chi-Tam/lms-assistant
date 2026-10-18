'use client';

import React, { useState, useRef } from 'react';
import {
  Sparkles,
  RotateCcw,
  Sliders,
  Printer,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Lightbulb,
  CheckSquare,
  Globe,
  Lock,
  BookOpen,
  HelpCircle,
  Award,
  BookX,
  Check,
  X,
  Target,
  Brain,
  Download,
  FileCode,
  GitCompare,
  PenLine,
  Square,
} from 'lucide-react';
import { QuizQuestion } from '@/app/api/quiz/route';
import { MarkdownRenderer } from '@/app/components/MarkdownRenderer';
import { convertQuestionsToMoodleXml, QuizQuestionItem } from '@/app/lib/moodle-xml';
import type { QuizAnalysisData, RagMode } from '@/app/types';
import { QuizAnalysisModal } from '@/app/components/QuizAnalysisModal';
import { dismissLocalNotificationByTag } from '@/app/lib/notification-client';
import {
  getLatestStoredAnalysisForCourse,
  saveStoredAnalysis,
} from '@/app/lib/quiz-client-cache';

interface QuizComponentProps {
  courseTitle: string;
  courseCode?: string;
  courseId?: string | number;
  selectedSources: Array<{ name: string; url?: string; type?: string }>;
  allowExternalSource?: boolean;
  ragMode?: RagMode;
  selectedModel?: string;
  hasLmsGrades?: boolean;
  initialMode?: 'comprehensive' | 'targeted';
  initialWeakTopics?: string[];
  notify: (msg: string) => void;
}

export type SupportedQuizType = 'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer';
export type UserQuizAnswer = number | number[] | string | Record<number, string>;

export function QuizComponent({
  courseTitle,
  courseCode,
  courseId,
  selectedSources,
  allowExternalSource: initialAllowExternal = false,
  ragMode: initialRagMode,
  selectedModel,
  hasLmsGrades = false,
  initialMode = 'comprehensive',
  initialWeakTopics = [],
  notify,
}: QuizComponentProps) {
  // Config state
  const [generatorMode, setGeneratorMode] = useState<'comprehensive' | 'targeted'>(initialMode);
  const [weakTopics, setWeakTopics] = useState<string[]>(initialWeakTopics);
  const [loadingWeakTopics, setLoadingWeakTopics] = useState<boolean>(false);
  const [recentAnalysis, setRecentAnalysis] = useState<QuizAnalysisData | null>(null);
  const [showAnalysisModal, setShowAnalysisModal] = useState<boolean>(false);

  const [questionCount, setQuestionCount] = useState<number>(10);
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal');
  const [selectedQuestionTypes, setSelectedQuestionTypes] = useState<SupportedQuizType[]>([
    'multiple_choice',
    'true_false',
    'multiple_select',
    'matching',
    'short_answer',
  ]);
  const [customTopic, setCustomTopic] = useState<string>('');
  const [ragMode, setRagMode] = useState<RagMode>(
    initialRagMode || (initialAllowExternal ? 'creative' : 'hybrid')
  );
  const allowExternal = ragMode === 'creative';

  // Execution state
  const [loading, setLoading] = useState<boolean>(false);
  const quizAbortRef = useRef<AbortController | null>(null);
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[] | null>(null);
  const [matchingShuffledRights, setMatchingShuffledRights] = useState<Record<number, string[]>>({});
  const [currentIdx, setCurrentIdx] = useState<number>(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, UserQuizAnswer>>({});
  const [submitted, setSubmitted] = useState<boolean>(false);

  const handleStopQuizGeneration = () => {
    if (quizAbortRef.current) {
      quizAbortRef.current.abort();
      quizAbortRef.current = null;
    }
    setLoading(false);
    notify('Đã dừng tạo đề thi theo yêu cầu.');
  };

  // Sync initialMode / initialWeakTopics if parent updates
  React.useEffect(() => {
    const canUseTargetedMode = hasLmsGrades && initialMode === 'targeted' && initialWeakTopics.length > 0;
    setGeneratorMode(canUseTargetedMode ? 'targeted' : 'comprehensive');
    if (initialWeakTopics && initialWeakTopics.length > 0) setWeakTopics(initialWeakTopics);
  }, [hasLmsGrades, initialMode, initialWeakTopics]);

  // Fetch recent quiz analysis for course to extract weak topics (localStorage first, then server)
  React.useEffect(() => {
    if (courseId) {
      // 1. Instant local cache
      const localRecent = getLatestStoredAnalysisForCourse(courseId);
      if (localRecent) {
        setRecentAnalysis(localRecent);
        if (localRecent.weakTopics?.length && (!weakTopics || weakTopics.length === 0)) {
          setWeakTopics(localRecent.weakTopics);
        }
      }

      setLoadingWeakTopics(!localRecent);
      fetch(`/api/quiz/analysis?courseId=${courseId}`)
        .then(r => r.json() as Promise<{ analyses?: QuizAnalysisData[] }>)
        .then(data => {
          if (data?.analyses && data.analyses.length > 0) {
            const latest = data.analyses[0];
            setRecentAnalysis(latest);
            saveStoredAnalysis(latest.attemptId, latest);
            if (latest.weakTopics?.length && (!weakTopics || weakTopics.length === 0)) {
              setWeakTopics(latest.weakTopics);
            }
          }
        })
        .catch(() => {})
        .finally(() => setLoadingWeakTopics(false));
    }
  }, [courseId]);

  // Clear previous course test questions when course changes or unmounts
  React.useEffect(() => {
    if (quizAbortRef.current) {
      quizAbortRef.current.abort();
      quizAbortRef.current = null;
    }
    setLoading(false);
    setQuizQuestions(null);
    setUserAnswers({});
    setSubmitted(false);
    setCurrentIdx(0);
    setCustomTopic('');
    return () => {
      if (quizAbortRef.current) {
        quizAbortRef.current.abort();
        quizAbortRef.current = null;
      }
    };
  }, [courseTitle, courseCode, courseId]);

  // Export Moodle XML handler
  const handleExportMoodleXml = () => {
    if (!quizQuestions || quizQuestions.length === 0) return;
    try {
      const items: QuizQuestionItem[] = quizQuestions.map(q => {
        if (q.type === 'matching') {
          return {
            questionText: q.q,
            type: 'matching',
            pairs: q.pairs || [],
          };
        }
        if (q.type === 'short_answer') {
          return {
            questionText: q.q,
            type: 'shortanswer',
            acceptedAnswers: q.answers as string[] || [],
          };
        }
        if (q.type === 'true_false') {
          return {
            questionText: q.q,
            type: 'truefalse',
            correctAnswerIndex: typeof q.answer === 'number' ? q.answer : (q.answer === 'Đúng' || q.answer === 'True' || q.answer === '0' ? 0 : 1),
            explanation: q.explanation,
          };
        }
        return {
          questionText: q.q,
          options: q.choices || [],
          correctAnswerIndex: typeof q.answer === 'number' ? q.answer : 0,
          correctAnswerIndices: Array.isArray(q.answers) ? (q.answers as number[]) : undefined,
          explanation: q.explanation,
          type: q.type === 'multiple_select' ? 'multiselect' : 'multichoice',
        };
      });

      const xml = convertQuestionsToMoodleXml(items, courseTitle);
      const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quiz_${courseTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.xml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify('Đã tải xuống file Moodle XML thành công!');
    } catch {
      notify('Có lỗi xảy ra khi tạo file Moodle XML.');
    }
  };

  // Generate Quiz API call
  const handleStartQuiz = async () => {
    if (selectedQuestionTypes.length === 0) {
      notify('Vui lòng chọn ít nhất 1 định dạng câu hỏi!');
      return;
    }

    // Validation
    const validatedCount = Math.min(50, Math.max(10, questionCount));
    if (quizAbortRef.current) {
      quizAbortRef.current.abort();
    }
    const controller = new AbortController();
    quizAbortRef.current = controller;

    setLoading(true);
    setUserAnswers({});
    setSubmitted(false);
    setCurrentIdx(0);

    try {
      const modeLabel =
        generatorMode === 'targeted'
          ? '🎯 Tập trung vào chỗ sai'
          : '🌐 Ôn tổng hợp toàn khóa';
      notify(
        `Đang tạo ${validatedCount} câu hỏi (${modeLabel}) độ khó ${
          difficulty === 'easy' ? 'Dễ' : difficulty === 'hard' ? 'Khó' : 'Trung bình'
        }…`
      );

      const effectiveTopic =
        customTopic.trim() ||
        (generatorMode === 'targeted' && weakTopics.length > 0
          ? `Khắc phục lỗ hổng kiến thức: ${weakTopics.join(', ')}`
          : courseTitle);

      const res = await fetch('/api/quiz', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: validatedCount,
          difficulty: generatorMode === 'targeted' ? 'hard' : difficulty,
          questionType: selectedQuestionTypes.length === 1 ? selectedQuestionTypes[0] : 'mixed',
          questionTypes: selectedQuestionTypes,
          generatorMode,
          weakTopics: generatorMode === 'targeted' ? weakTopics : [],
          topic: effectiveTopic,
          course: `${courseTitle} (${courseCode || ''})`,
          courseId,
          courseCode,
          sources: selectedSources,
          sourceNames: selectedSources.map(s => s.name),
          allowExternalSource: ragMode === 'creative',
          ragMode,
          model: selectedModel,
        }),
      });

      const data = (await res.json()) as { error?: string; questions?: QuizQuestion[] };
      if (!res.ok) throw new Error(data.error || 'Không thể tạo đề trắc nghiệm.');

      if (Array.isArray(data.questions) && data.questions.length > 0) {
        setQuizQuestions(data.questions);

        // Pre-shuffle matching right pairs once so options remain stable during the test
        const newShuffled: Record<number, string[]> = {};
        data.questions.forEach((q, qIdx) => {
          if (q.type === 'matching' && Array.isArray(q.pairs)) {
            newShuffled[qIdx] = [...q.pairs.map(p => p.right)].sort(() => Math.random() - 0.5);
          }
        });
        setMatchingShuffledRights(newShuffled);

        notify(`Đã tạo thành công ${data.questions.length} câu hỏi!`);
      } else {
        throw new Error('Dữ liệu câu hỏi không hợp lệ.');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        return;
      }
      notify(e instanceof Error ? e.message : 'Có lỗi khi tạo câu hỏi trắc nghiệm.');
    } finally {
      if (quizAbortRef.current === controller) {
        quizAbortRef.current = null;
      }
      setLoading(false);
    }
  };

  // Analyze current test session mistakes
  const handleAnalyzeCurrentQuiz = () => {
    if (!quizQuestions || !submitted) return;
    const mistakes = quizQuestions
      .map((q, idx) => ({ q, idx }))
      .filter(({ q, idx }) => !isAnswerCorrect(q, idx));

    let correctCount = 0;
    quizQuestions.forEach((q, idx) => {
      if (isAnswerCorrect(q, idx)) correctCount += 1;
    });
    const totalCount = quizQuestions.length;
    const scorePct = Math.round((correctCount / totalCount) * 100);

    const analysisData: QuizAnalysisData = {
      attemptId: Date.now(),
      quizName: `Đề thi thử: ${courseTitle}`,
      courseId: Number(courseId || 0),
      courseName: courseTitle,
      score: Math.round((correctCount / totalCount) * 100) / 10,
      maxScore: 10,
      percentage: `${scorePct}%`,
      totalQuestions: totalCount,
      wrongCount: mistakes.length,
      partialCount: 0,
      weakTopics: weakTopics.length > 0 ? weakTopics : [courseTitle],
      recommendations: [
        'Rà soát lại các câu hỏi đã trả lời sai bên dưới để tránh lặp lại trên LMS.',
        'Đọc lại các khái niệm tương ứng trong tài liệu bài giảng.',
      ],
      overview: `Bạn đã làm đúng ${correctCount}/${totalCount} câu (${scorePct}%). Hệ thống nhận diện ${mistakes.length} câu làm sai và đưa ra chẩn đoán nguyên nhân bên dưới.`,
      questionsAnalysis: mistakes.map(({ q, idx }) => {
        const ans = userAnswers[idx];
        let studentChoiceStr = 'Chưa chọn';
        let rightChoiceStr = '';

        if (q.type === 'matching') {
          const pairMap = (typeof ans === 'object' && !Array.isArray(ans) ? ans : {}) as Record<number, string>;
          const pairs = q.pairs || [];
          studentChoiceStr = pairs.map((p, pIdx) => `${p.left} → ${pairMap[pIdx] || '(chưa nối)'}`).join('; ');
          rightChoiceStr = pairs.map(p => `${p.left} → ${p.right}`).join('; ');
        } else if (q.type === 'short_answer') {
          studentChoiceStr = typeof ans === 'string' && ans.trim() ? ans.trim() : 'Chưa nhập câu trả lời';
          rightChoiceStr = Array.isArray(q.answers) ? (q.answers as string[]).join(' hoặc ') : String(q.answer || '');
        } else if (q.type === 'multiple_select') {
          studentChoiceStr = Array.isArray(ans)
            ? (ans as number[]).map(i => q.choices?.[i] || '').join(', ')
            : 'Chưa chọn';
          rightChoiceStr = (Array.isArray(q.answers) ? (q.answers as number[]) : typeof q.answer === 'number' ? [q.answer] : [])
            .map(i => q.choices?.[i] || '')
            .join(', ');
        } else {
          studentChoiceStr = typeof ans === 'number'
            ? (q.choices?.[ans] || '')
            : 'Chưa chọn';
          rightChoiceStr = typeof q.answer === 'number'
            ? (q.choices?.[q.answer] || '')
            : '';
        }

        return {
          slot: idx + 1,
          questionText: q.q,
          studentAnswer: studentChoiceStr,
          rightAnswer: rightChoiceStr,
          status: 'Incorrect',
          mark: '0.00',
          maxmark: 1,
          feedback: q.explanation,
          explanation: q.explanation,
          diagnosedReason: q.explanation || 'Sinh viên cần xem lại lý thuyết định nghĩa phần này.',
        };
      }),
      analyzedAt: new Date().toISOString(),
    };

    setRecentAnalysis(analysisData);
    saveStoredAnalysis(analysisData.attemptId, analysisData);
    setShowAnalysisModal(true);
  };

  const handleSelectAnswer = (qIdx: number, choiceIdx: number) => {
    if (submitted) return;
    const q = quizQuestions?.[qIdx];
    const isMulti = q?.type === 'multiple_select';

    if (isMulti) {
      setUserAnswers(prev => {
        const currentList = Array.isArray(prev[qIdx]) ? (prev[qIdx] as number[]) : [];
        const nextList = currentList.includes(choiceIdx)
          ? currentList.filter(i => i !== choiceIdx)
          : [...currentList, choiceIdx].sort((a, b) => a - b);
        return {
          ...prev,
          [qIdx]: nextList,
        };
      });
    } else {
      setUserAnswers(prev => ({
        ...prev,
        [qIdx]: choiceIdx,
      }));
    }
  };

  const handleSelectPair = (qIdx: number, pairIdx: number, value: string) => {
    if (submitted) return;
    setUserAnswers(prev => {
      const currentMap = (typeof prev[qIdx] === 'object' && !Array.isArray(prev[qIdx]) ? { ...prev[qIdx] } : {}) as Record<number, string>;
      currentMap[pairIdx] = value;
      return {
        ...prev,
        [qIdx]: currentMap,
      };
    });
  };

  const handleTypeShortAnswer = (qIdx: number, text: string) => {
    if (submitted) return;
    setUserAnswers(prev => ({
      ...prev,
      [qIdx]: text,
    }));
  };

  const isQuestionAnswered = (qIdx: number): boolean => {
    const q = quizQuestions?.[qIdx];
    const ans = userAnswers[qIdx];
    if (ans === undefined || ans === null) return false;
    if (q?.type === 'matching') {
      if (typeof ans !== 'object' || Array.isArray(ans)) return false;
      const pairMap = ans as Record<number, string>;
      const pairs = q.pairs || [];
      return pairs.length > 0 && pairs.every((_, pIdx) => Boolean(pairMap[pIdx]));
    }
    if (q?.type === 'short_answer') {
      return typeof ans === 'string' && ans.trim().length > 0;
    }
    if (Array.isArray(ans)) return ans.length > 0;
    return typeof ans === 'number';
  };

  const isAnswerCorrect = (q: QuizQuestion, qIdx: number): boolean => {
    const ans = userAnswers[qIdx];
    if (q.type === 'matching') {
      if (!ans || typeof ans !== 'object' || Array.isArray(ans)) return false;
      const pairMap = ans as Record<number, string>;
      const pairs = q.pairs || [];
      if (pairs.length === 0) return false;
      return pairs.every((p, pIdx) => (pairMap[pIdx] || '').trim().toLowerCase() === p.right.trim().toLowerCase());
    }
    if (q.type === 'short_answer') {
      if (typeof ans !== 'string' || !ans.trim()) return false;
      const cleanStudent = ans.trim().toLowerCase();
      const accepted = Array.isArray(q.answers)
        ? (q.answers as string[]).map(s => String(s).trim().toLowerCase())
        : typeof q.answer === 'string'
        ? [q.answer.trim().toLowerCase()]
        : [];
      return accepted.some(a => a === cleanStudent);
    }
    if (q.type === 'multiple_select') {
      const correctIndices = (Array.isArray(q.answers)
        ? q.answers
        : typeof q.answer === 'number'
        ? [q.answer]
        : []) as number[];
      const userSelected = Array.isArray(ans) ? (ans as number[]) : [];
      if (userSelected.length === 0 || userSelected.length !== correctIndices.length) return false;
      return userSelected.every(i => correctIndices.includes(i));
    }
    return ans === q.answer;
  };

  const handleSubmit = () => {
    const answeredCount = quizQuestions ? quizQuestions.filter((_, idx) => isQuestionAnswered(idx)).length : 0;
    const totalCount = quizQuestions?.length || 0;
    if (answeredCount < totalCount) {
      const confirmSubmit = window.confirm(
        `Bạn mới trả lời ${answeredCount}/${totalCount} câu hỏi. Bạn có chắc chắn muốn nộp bài?`
      );
      if (!confirmSubmit) return;
    }
    setSubmitted(true);

    // Pillar 3: Dismiss active notifications across user's devices
    const targetQuizTag = `quiz_${courseId || 'practice'}`;
    void dismissLocalNotificationByTag(targetQuizTag);
    void dismissLocalNotificationByTag(`deadline_${courseId || 'practice'}`);

    notify('Đã nộp bài thi thành công!');
  };

  const handleRetake = () => {
    setUserAnswers({});
    setSubmitted(false);
    setCurrentIdx(0);
    notify('Đã làm mới bài kiểm tra');
  };

  const handleReconfigure = () => {
    setQuizQuestions(null);
    setUserAnswers({});
    setSubmitted(false);
    setCurrentIdx(0);
  };

  // Loading Screen
  if (loading) {
    return (
      <div className="artifact artifact-loading" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.85rem' }}>
        <span className="bot-avatar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Sparkles size={16} />
        </span>
        <h3 style={{ margin: 0, textAlign: 'center' }}>
          Đang biên soạn {questionCount} câu hỏi trắc nghiệm {difficulty === 'easy' ? 'Cơ bản' : difficulty === 'hard' ? 'Nâng cao' : 'Tiêu chuẩn'} từ tài liệu…
        </h3>
        <div className="typing">
          <i />
          <i />
          <i />
        </div>
        <button
          type="button"
          onClick={handleStopQuizGeneration}
          style={{
            marginTop: '0.35rem',
            background: '#ef4444',
            color: '#fff',
            border: 'none',
            padding: '0.5rem 1.25rem',
            borderRadius: '10px',
            fontWeight: 600,
            fontSize: '13px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(239, 68, 68, 0.4)',
            transition: 'all 0.2s ease',
          }}
          title="Dừng tạo đề thi"
        >
          <Square size={13} fill="currentColor" />
          <span>Dừng tạo đề thi</span>
        </button>
      </div>
    );
  }

  // 1. Configuration & Validation Panel (When no quiz is active)
  if (!quizQuestions) {
    return (
      <div className="tool-config-panel">
        <div className="tool-config-head">
          <div className="tool-icon-box">✓</div>
          <div>
            <h3>Tạo Đề Thi Trắc Nghiệm Tự Động</h3>
            <p>Trợ lý AI tổng hợp câu hỏi khảo sát kiến thức từ {selectedSources.length} nguồn tài liệu của môn {courseTitle}.</p>
          </div>
        </div>

        {/* Section 0: Chế độ Lò ấp trắc nghiệm */}
        <div>
          <div className="tool-section-label">
            <span>CHẾ ĐỘ TẠO ĐỀ TRẮC NGHIỆM</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
            <button
              type="button"
              className={`reconfigure-btn ${generatorMode === 'comprehensive' ? 'active' : ''}`}
              onClick={() => setGeneratorMode('comprehensive')}
              style={{
                padding: '12px 14px',
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                textAlign: 'left',
                border: generatorMode === 'comprehensive' ? '1.5px solid #8b5cf6' : '1px solid rgba(255, 255, 255, 0.1)',
                background: generatorMode === 'comprehensive' ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255, 255, 255, 0.03)',
                cursor: 'pointer',
              }}
            >
              <Globe size={20} color="#8b5cf6" style={{ flexShrink: 0 }} />
              <div>
                <strong style={{ display: 'block', fontSize: '13px', color: '#fff' }}>Ôn tổng hợp toàn khóa</strong>
                <small style={{ fontSize: '11.5px', color: '#94a3b8' }}>Bao quát tất cả tài liệu & giáo trình môn học</small>
              </div>
            </button>

            <button
              type="button"
              className={`reconfigure-btn ${generatorMode === 'targeted' ? 'active' : ''}`}
              onClick={() => {
                if (!hasLmsGrades || weakTopics.length === 0) return;
                setGeneratorMode('targeted');
                setDifficulty('hard');
              }}
              disabled={!hasLmsGrades || weakTopics.length === 0}
              style={{
                padding: '12px 14px',
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                textAlign: 'left',
                border: generatorMode === 'targeted' ? '1.5px solid #ec4899' : '1px solid rgba(255, 255, 255, 0.1)',
                background: generatorMode === 'targeted' ? 'rgba(236, 72, 153, 0.2)' : 'rgba(255, 255, 255, 0.03)',
                cursor: !hasLmsGrades || weakTopics.length === 0 ? 'not-allowed' : 'pointer',
                opacity: !hasLmsGrades || weakTopics.length === 0 ? 0.5 : 1,
              }}
            >
              <Target size={20} color="#ec4899" style={{ flexShrink: 0 }} />
              <div>
                <strong style={{ display: 'block', fontSize: '13px', color: '#fff' }}>Tập trung vào chỗ sai</strong>
                <small style={{ fontSize: '11.5px', color: '#94a3b8' }}>
                  {!hasLmsGrades ? 'Chỉ khả dụng khi môn học có điểm trên Moodle' : 'Xoáy sâu vào các điểm mù & câu làm sai trên Moodle'}
                </small>
              </div>
            </button>
          </div>

          {generatorMode === 'targeted' && (
            <div
              style={{
                marginTop: '10px',
                padding: '10px 14px',
                borderRadius: '10px',
                background: 'rgba(236, 72, 153, 0.1)',
                border: '1px solid rgba(236, 72, 153, 0.25)',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: '#f472b6' }}>
                  <Brain size={14} />
                  <span>Các điểm mù kiến thức phát hiện từ bài thi Moodle:</span>
                </div>
                {recentAnalysis && (
                  <button
                    type="button"
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowAnalysisModal(true);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#38bdf8',
                      fontSize: '11.5px',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    Xem chẩn đoán chi tiết →
                  </button>
                )}
              </div>

              {weakTopics.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '2px' }}>
                  {weakTopics.map((t, idx) => (
                    <span
                      key={idx}
                      style={{
                        padding: '3px 10px',
                        borderRadius: '12px',
                        background: 'rgba(236, 72, 153, 0.2)',
                        border: '1px solid rgba(236, 72, 153, 0.35)',
                        fontSize: '11.5px',
                        color: '#fbcfe8',
                        fontWeight: 500,
                      }}
                    >
                      🎯 {t}
                    </span>
                  ))}
                </div>
              ) : (
                <span style={{ fontSize: '12px', color: '#94a3b8', fontStyle: 'italic' }}>
                  {loadingWeakTopics ? 'Đang kiểm tra lịch sử phân tích lỗi sai…' : 'Chưa có dữ liệu bài thi sai. Đề sẽ được tạo theo trọng tâm môn học.'}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Section 1: Number of Questions (10 - 50) */}
        <div>
          <div className="tool-section-label">
            <span>1. SỐ LƯỢNG CÂU HỎI (TỐI THIỂU 10 - TỐI ĐA 50)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <input
              type="range"
              min={10}
              max={50}
              step={5}
              value={questionCount}
              onChange={e => setQuestionCount(Number(e.target.value))}
              style={{ flex: 1, minWidth: '180px', accentColor: '#8b5cf6' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="number"
                min={10}
                max={50}
                value={questionCount}
                onChange={e => {
                  const val = Number(e.target.value);
                  if (!isNaN(val)) setQuestionCount(val);
                }}
                className="tool-topic-input"
                style={{ width: '70px', textAlign: 'center', padding: '6px 8px' }}
              />
              <span style={{ fontSize: '13px', color: '#cbd5e1' }}>câu</span>
            </div>
          </div>
          {/* Quick presets */}
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            {[10, 15, 20, 30, 50].map(cnt => (
              <button
                key={cnt}
                type="button"
                className={`reconfigure-btn ${questionCount === cnt ? 'active' : ''}`}
                style={{
                  padding: '4px 10px',
                  fontSize: '11.5px',
                  background: questionCount === cnt ? 'rgba(124, 58, 237, 0.35)' : undefined,
                  borderColor: questionCount === cnt ? '#8b5cf6' : undefined,
                }}
                onClick={() => setQuestionCount(cnt)}
              >
                {cnt} câu
              </button>
            ))}
          </div>
        </div>

        {/* Section 2: Difficulty Level */}
        <div>
          <div className="tool-section-label">2. ĐỘ KHÓ (DIFFICULTY)</div>
          <div className="level-selector">
            <button
              type="button"
              className={`level-card ${difficulty === 'easy' ? 'active' : ''}`}
              onClick={() => setDifficulty('easy')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <BookOpen size={14} />
                Cơ bản (Easy)
              </strong>
              <small>Nhận biết khái niệm, định nghĩa và nguyên lý trực tiếp</small>
            </button>

            <button
              type="button"
              className={`level-card ${difficulty === 'normal' ? 'active' : ''}`}
              onClick={() => setDifficulty('normal')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <HelpCircle size={14} />
                Trung bình (Normal)
              </strong>
              <small>Thông hiểu bản chất và vận dụng lý thuyết cân đối</small>
            </button>

            <button
              type="button"
              className={`level-card ${difficulty === 'hard' ? 'active' : ''}`}
              onClick={() => setDifficulty('hard')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Sparkles size={14} />
                Nâng cao (Hard)
              </strong>
              <small>Vận dụng cao, giải quyết tình huống thực tế và phân tích sâu</small>
            </button>
          </div>
        </div>

        {/* Section 3: Multi-Select Question Types */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
            <div className="tool-section-label" style={{ margin: 0 }}>
              3. ĐỊNH DẠNG CÂU HỎI (CHỌN 1 HOẶC NHIỀU ĐỊNH DẠNG TÙY Ý)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                Đã chọn: <strong style={{ color: '#c4b5fd' }}>{selectedQuestionTypes.length}/5</strong> dạng
              </span>
              <button
                type="button"
                className="reconfigure-btn"
                onClick={() => {
                  const all: SupportedQuizType[] = ['multiple_choice', 'true_false', 'multiple_select', 'matching', 'short_answer'];
                  setSelectedQuestionTypes(prev => (prev.length === all.length ? ['multiple_choice'] : all));
                }}
                style={{ padding: '3px 10px', fontSize: '11px', height: 'auto' }}
              >
                {selectedQuestionTypes.length === 5 ? 'Chỉ chọn 1 đáp án' : 'Chọn tất cả (5 dạng)'}
              </button>
            </div>
          </div>

          <div className="level-selector" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            {[
              {
                id: 'multiple_choice' as SupportedQuizType,
                title: '4 Lựa chọn (A/B/C/D)',
                desc: 'Trắc nghiệm 1 đáp án đúng tiêu chuẩn',
                icon: HelpCircle,
              },
              {
                id: 'true_false' as SupportedQuizType,
                title: 'Đúng / Sai (True/False)',
                desc: 'Đánh giá tính đúng/sai của nhận định',
                icon: BookX,
              },
              {
                id: 'multiple_select' as SupportedQuizType,
                title: 'Nhiều đáp án đúng',
                desc: 'Câu hỏi có 2 đến 3 đáp án đúng đồng thời',
                icon: CheckSquare,
              },
              {
                id: 'matching' as SupportedQuizType,
                title: 'Nối cặp (Match making)',
                desc: 'Ghép khái niệm với định nghĩa phù hợp',
                icon: GitCompare,
              },
              {
                id: 'short_answer' as SupportedQuizType,
                title: 'Trả lời ngắn (Short answer)',
                desc: 'Tự gõ câu trả lời, thuật ngữ hoặc từ khóa',
                icon: PenLine,
              },
            ].map(item => {
              const isSelected = selectedQuestionTypes.includes(item.id);
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`level-card ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedQuestionTypes(prev => {
                      if (prev.includes(item.id)) {
                        if (prev.length === 1) {
                          notify('Cần chọn ít nhất 1 định dạng câu hỏi.');
                          return prev;
                        }
                        return prev.filter(t => t !== item.id);
                      } else {
                        return [...prev, item.id];
                      }
                    });
                  }}
                  style={{
                    position: 'relative',
                    borderColor: isSelected ? '#8b5cf6' : undefined,
                    background: isSelected ? 'rgba(139, 92, 246, 0.18)' : undefined,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <strong style={{ display: 'flex', alignItems: 'center', gap: '6px', color: isSelected ? '#fff' : '#c4c1d6' }}>
                      <Icon size={14} color={isSelected ? '#a78bfa' : '#94a3b8'} />
                      {item.title}
                    </strong>
                    <span
                      style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: '4px',
                        border: isSelected ? '1.5px solid #a78bfa' : '1px solid rgba(255, 255, 255, 0.2)',
                        background: isSelected ? '#7c3aed' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#fff',
                        fontSize: '11px',
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {isSelected ? '✓' : ''}
                    </span>
                  </div>
                  <small style={{ marginTop: '4px', display: 'block', color: isSelected ? '#cbd5e1' : '#64748b' }}>
                    {item.desc}
                  </small>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section 4: Focus Topic */}
        <div>
          <div className="tool-section-label">4. CHỦ ĐỀ / PHẠM VI TRỌNG TÂM (TÙY CHỌN)</div>
          <input
            className="tool-topic-input"
            value={customTopic}
            onChange={e => setCustomTopic(e.target.value)}
            placeholder={`Để trống để ra đề toàn bộ môn ${courseTitle}, hoặc nhập chuyên đề...`}
          />
        </div>

        {/* Section 5: External Knowledge Option */}
        <div>
          <div className="tool-section-label">5. PHẠM VI NỘI DUNG RA ĐỀ</div>
          <div className="level-selector">
            <button
              type="button"
              className={`level-card ${ragMode === 'strict' ? 'active' : ''}`}
              onClick={() => setRagMode('strict')}
              style={{
                border: ragMode === 'strict' ? '1.5px solid #ef4444' : undefined,
                background: ragMode === 'strict' ? 'rgba(239, 68, 68, 0.12)' : undefined,
                boxShadow: ragMode === 'strict' ? '0 0 16px rgba(239, 68, 68, 0.25)' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Lock size={15} style={{ color: '#ef4444' }} />
                  <span>Bám sát (Strict)</span>
                </strong>
                <span
                  className="level-badge"
                  style={{
                    background: ragMode === 'strict' ? 'rgba(239, 68, 68, 0.25)' : undefined,
                    color: ragMode === 'strict' ? '#fca5a5' : undefined,
                    border: ragMode === 'strict' ? '1px solid rgba(239, 68, 68, 0.35)' : undefined,
                  }}
                >
                  100% Giáo trình
                </span>
              </div>
              <small style={{ color: ragMode === 'strict' ? '#fca5a5' : undefined }}>
                100% bám sát tài liệu bài giảng đã chọn. Không suy diễn kiến thức ngoài giáo trình.
              </small>
            </button>

            <button
              type="button"
              className={`level-card ${ragMode === 'hybrid' ? 'active' : ''}`}
              onClick={() => setRagMode('hybrid')}
              style={{
                border: ragMode === 'hybrid' ? '1.5px solid #f59e0b' : undefined,
                background: ragMode === 'hybrid' ? 'rgba(245, 158, 11, 0.12)' : undefined,
                boxShadow: ragMode === 'hybrid' ? '0 0 16px rgba(245, 158, 11, 0.25)' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Sparkles size={15} style={{ color: '#f59e0b' }} />
                  <span>RAG Lai (Hybrid)</span>
                </strong>
                <span
                  className="level-badge"
                  style={{
                    background: ragMode === 'hybrid' ? 'rgba(245, 158, 11, 0.25)' : undefined,
                    color: ragMode === 'hybrid' ? '#fcd34d' : undefined,
                    border: ragMode === 'hybrid' ? '1px solid rgba(245, 158, 11, 0.35)' : undefined,
                  }}
                >
                  Cân bằng
                </span>
              </div>
              <small style={{ color: ragMode === 'hybrid' ? '#fcd34d' : undefined }}>
                Ưu tiên giáo trình; tự động mở rộng câu hỏi tình huống thực tế và bài tập áp dụng khi thiếu dữ kiện.
              </small>
            </button>

            <button
              type="button"
              className={`level-card ${ragMode === 'creative' ? 'active' : ''}`}
              onClick={() => setRagMode('creative')}
              style={{
                border: ragMode === 'creative' ? '1.5px solid #38bdf8' : undefined,
                background: ragMode === 'creative' ? 'rgba(56, 189, 248, 0.12)' : undefined,
                boxShadow: ragMode === 'creative' ? '0 0 16px rgba(56, 189, 248, 0.25)' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Globe size={15} style={{ color: '#38bdf8' }} />
                  <span>Sáng tạo (Creative)</span>
                </strong>
                <span
                  className="level-badge"
                  style={{
                    background: ragMode === 'creative' ? 'rgba(56, 189, 248, 0.25)' : undefined,
                    color: ragMode === 'creative' ? '#38bdf8' : undefined,
                    border: ragMode === 'creative' ? '1px solid rgba(56, 189, 248, 0.35)' : undefined,
                  }}
                >
                  Mở rộng
                </span>
              </div>
              <small style={{ color: ragMode === 'creative' ? '#7dd3fc' : undefined }}>
                Tự do mở rộng các câu hỏi thực tế ngành nghề, case study thực tế, công nghệ mới và tư duy đa chiều.
              </small>
            </button>
          </div>
        </div>

        <button
          type="button"
          className="generate-tool-btn"
          onClick={() => void handleStartQuiz()}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
        >
          <Sparkles size={16} />
          Bắt đầu làm bài trắc nghiệm ({questionCount} câu)
        </button>

        {/* Quiz Analysis Diagnosis Modal (Accessible from Config Panel) */}
        <QuizAnalysisModal
          isOpen={showAnalysisModal}
          onClose={() => setShowAnalysisModal(false)}
          analysis={recentAnalysis}
          onStartRemediation={topics => {
            setGeneratorMode('targeted');
            setWeakTopics(topics);
            setDifficulty('hard');
            setShowAnalysisModal(false);
          }}
        />
      </div>
    );
  }

  // 2. Quiz In Progress or Review
  const currentQ = quizQuestions[currentIdx];
  const totalQuestions = quizQuestions.length;
  const answeredCount = quizQuestions.filter((_, idx) => isQuestionAnswered(idx)).length;

  // Calculate score if submitted
  let correctCount = 0;
  if (submitted) {
    quizQuestions.forEach((q, idx) => {
      if (isAnswerCorrect(q, idx)) {
        correctCount += 1;
      }
    });
  }
  const scorePercent = Math.round((correctCount / totalQuestions) * 100);

  const isMatching = currentQ.type === 'matching';
  const isShortAnswer = currentQ.type === 'short_answer';
  const isMultiSelect = currentQ.type === 'multiple_select';
  const isTrueFalse = currentQ.type === 'true_false';

  return (
    <div className="artifact quiz-wrapper">
      {/* Quiz Top Header */}
      <div className="artifact-head">
        <div>
          <h2>Đề trắc nghiệm: {courseTitle}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
            <span className="level-badge">
              {difficulty === 'easy' ? 'Cơ bản' : difficulty === 'hard' ? 'Nâng cao' : 'Trung bình'}
            </span>
            <span className="level-badge" style={{ background: 'rgba(56, 189, 248, 0.15)', borderColor: '#38bdf8', color: '#bae6fd' }}>
              {selectedQuestionTypes.length === 5
                ? 'Tổng hợp (5 dạng)'
                : selectedQuestionTypes.length > 1
                ? `Kết hợp (${selectedQuestionTypes.length} dạng)`
                : selectedQuestionTypes[0] === 'matching'
                ? 'Nối cặp'
                : selectedQuestionTypes[0] === 'short_answer'
                ? 'Trả lời ngắn'
                : selectedQuestionTypes[0] === 'true_false'
                ? 'Đúng / Sai'
                : selectedQuestionTypes[0] === 'multiple_select'
                ? 'Nhiều đáp án'
                : '4 Lựa chọn'}
            </span>
            <small style={{ color: '#94a3b8' }}>
              Đã hoàn thành: {answeredCount}/{totalQuestions} câu
            </small>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className="reconfigure-btn"
            onClick={handleReconfigure}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Sliders size={14} />
            Cấu hình đề
          </button>

          {submitted && (
            <button
              className="reconfigure-btn"
              onClick={handleRetake}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <RotateCcw size={14} />
              Làm lại đề này
            </button>
          )}

          <button
            className="reconfigure-btn"
            onClick={handleExportMoodleXml}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              color: '#38bdf8',
              borderColor: 'rgba(56, 189, 248, 0.35)',
              background: 'rgba(56, 189, 248, 0.08)',
            }}
            title="Xuất file Moodle XML để nhập trực tiếp vào ngân hàng đề thi LMS"
          >
            <Download size={14} />
            <span>Xuất file Moodle XML</span>
          </button>
        </div>
      </div>

      {/* Score Summary Box when submitted */}
      {submitted && (
        <div className="quiz-result-banner">
          <div className="score-circle">
            <span className="score-num">{scorePercent}%</span>
            <span className="score-sub">{correctCount}/{totalQuestions} đúng</span>
          </div>
          <div className="score-details">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {scorePercent >= 85 ? (
                <>
                  <Award size={20} style={{ color: '#fbbf24' }} />
                  Kết quả xuất sắc: Nắm vững toàn diện kiến thức
                </>
              ) : scorePercent >= 65 ? (
                <>
                  <CheckCircle2 size={20} style={{ color: '#38bdf8' }} />
                  Kết quả đạt yêu cầu: Cần rà soát thêm các câu sai
                </>
              ) : (
                <>
                  <BookOpen size={20} style={{ color: '#f87171' }} />
                  Cần tiếp tục ôn tập và củng cố tài liệu bài giảng
                </>
              )}
            </h3>
            <p>Bài thi trắc nghiệm đã hoàn thành. Hãy đối chiếu các câu trả lời và xem giải thích chi tiết bên dưới.</p>

            {correctCount < totalQuestions && (
              <div style={{ marginTop: '10px' }}>
                <button
                  type="button"
                  className="generate-tool-btn"
                  style={{
                    margin: 0,
                    padding: '7px 16px',
                    fontSize: '12.5px',
                    background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    boxShadow: '0 4px 12px rgba(139, 92, 246, 0.3)',
                  }}
                  onClick={handleAnalyzeCurrentQuiz}
                >
                  <Brain size={15} />
                  <span>Phân tích điểm mù của đề này với AI</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Question Card */}
      <div className="quiz-card">
        {/* Progress header */}
        <div className="quiz-card-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="quiz-q-counter">
              CÂU HỎI {currentIdx + 1} / {totalQuestions}
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '6px',
                background: isMatching
                  ? 'rgba(14, 165, 233, 0.2)'
                  : isShortAnswer
                  ? 'rgba(234, 179, 8, 0.2)'
                  : isMultiSelect
                  ? 'rgba(168, 85, 247, 0.2)'
                  : isTrueFalse
                  ? 'rgba(56, 189, 248, 0.2)'
                  : 'rgba(124, 109, 242, 0.15)',
                color: isMatching
                  ? '#38bdf8'
                  : isShortAnswer
                  ? '#fde047'
                  : isMultiSelect
                  ? '#d8b4fe'
                  : isTrueFalse
                  ? '#7dd3fc'
                  : '#c4c1d6',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                fontWeight: 600,
              }}
            >
              {isMatching
                ? 'Nối cặp tương ứng'
                : isShortAnswer
                ? 'Trả lời ngắn'
                : isMultiSelect
                ? `Chọn ${currentQ.answers?.length || 2} đáp án đúng (Đã chọn: ${Array.isArray(userAnswers[currentIdx]) ? (userAnswers[currentIdx] as number[]).length : 0}/${currentQ.answers?.length || 2})`
                : isTrueFalse
                ? 'Đúng / Sai'
                : 'Chọn 1 đáp án đúng'}
            </span>
          </div>
          {submitted && (
            <span
              className={`quiz-status-pill ${
                isAnswerCorrect(currentQ, currentIdx) ? 'correct' : 'incorrect'
              }`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              {isAnswerCorrect(currentQ, currentIdx) ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {isAnswerCorrect(currentQ, currentIdx) ? 'Đúng' : 'Sai'}
            </span>
          )}
        </div>

        {/* Question Text */}
        <div className="quiz-question-text">
          <MarkdownRenderer content={currentQ.q} />
        </div>

        {/* 1. MATCHING QUESTION VIEW */}
        {isMatching && currentQ.pairs && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
            <div style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic', marginBottom: '2px' }}>
              Ghép từng mục ở cột bên trái với đáp án tương ứng từ menu thả xuống bên phải:
            </div>
            {currentQ.pairs.map((pair, pIdx) => {
              const pairMap = (typeof userAnswers[currentIdx] === 'object' && !Array.isArray(userAnswers[currentIdx]) ? userAnswers[currentIdx] : {}) as Record<number, string>;
              const studentChosen = pairMap[pIdx] || '';
              const isPairCorrect = submitted && studentChosen.trim().toLowerCase() === pair.right.trim().toLowerCase();
              const isPairWrong = submitted && studentChosen.trim().toLowerCase() !== pair.right.trim().toLowerCase();
              const optionsForRight = matchingShuffledRights[currentIdx] || currentQ.pairs?.map(p => p.right) || [];

              return (
                <div
                  key={pIdx}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    padding: '10px 14px',
                    borderRadius: '10px',
                    background: isPairCorrect
                      ? 'rgba(32, 191, 169, 0.1)'
                      : isPairWrong
                      ? 'rgba(239, 68, 68, 0.1)'
                      : 'rgba(255, 255, 255, 0.03)',
                    border: isPairCorrect
                      ? '1.5px solid #20bfa9'
                      : isPairWrong
                      ? '1.5px solid #ef4444'
                      : '1px solid rgba(255, 255, 255, 0.1)',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '6px',
                        background: 'rgba(124, 109, 242, 0.25)',
                        color: '#cfc8ff',
                        fontSize: '12px',
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {pIdx + 1}
                    </span>
                    <span style={{ fontSize: '14px', color: '#f1f5f9', fontWeight: 500 }}>{pair.left}</span>
                  </div>

                  <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <select
                      value={studentChosen}
                      onChange={e => handleSelectPair(currentIdx, pIdx, e.target.value)}
                      disabled={submitted}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        background: '#141220',
                        color: studentChosen ? '#f3f2f8' : '#94a3b8',
                        border: isPairCorrect
                          ? '1.5px solid #20bfa9'
                          : isPairWrong
                          ? '1.5px solid #ef4444'
                          : '1px solid rgba(124, 109, 242, 0.4)',
                        fontSize: '13.5px',
                        outline: 'none',
                        cursor: submitted ? 'default' : 'pointer',
                      }}
                    >
                      <option value="">-- Chọn mục tương ứng --</option>
                      {optionsForRight.map((rText, rIdx) => (
                        <option key={rIdx} value={rText}>
                          {rText}
                        </option>
                      ))}
                    </select>

                    {submitted && isPairWrong && (
                      <span style={{ fontSize: '12px', color: '#20bfa9', fontWeight: 600 }}>
                        ✓ Đáp án đúng: {pair.right}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 2. SHORT ANSWER QUESTION VIEW */}
        {isShortAnswer && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
            <div style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic' }}>
              Nhập câu trả lời ngắn (từ khóa, thuật ngữ hoặc con số) vào ô bên dưới:
            </div>

            <input
              type="text"
              className="tool-topic-input"
              value={(userAnswers[currentIdx] as string) || ''}
              onChange={e => handleTypeShortAnswer(currentIdx, e.target.value)}
              disabled={submitted}
              placeholder="Gõ câu trả lời của bạn vào đây..."
              style={{
                padding: '12px 16px',
                fontSize: '15px',
                borderRadius: '10px',
                borderColor: submitted
                  ? isAnswerCorrect(currentQ, currentIdx)
                    ? '#20bfa9'
                    : '#ef4444'
                  : undefined,
              }}
            />

            {submitted && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: isAnswerCorrect(currentQ, currentIdx)
                    ? 'rgba(32, 191, 169, 0.12)'
                    : 'rgba(239, 68, 68, 0.12)',
                  border: `1px solid ${
                    isAnswerCorrect(currentQ, currentIdx) ? '#20bfa9' : '#ef4444'
                  }`,
                }}
              >
                {isAnswerCorrect(currentQ, currentIdx) ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#20bfa9', fontSize: '13.5px', fontWeight: 600 }}>
                    <CheckCircle2 size={16} />
                    <span>Chính xác! Câu trả lời của bạn hoàn toàn trùng khớp.</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ef4444', fontSize: '13.5px', fontWeight: 600 }}>
                      <XCircle size={16} />
                      <span>Chưa chính xác.</span>
                    </div>
                    <div style={{ fontSize: '13px', color: '#e2e8f0' }}>
                      Đáp án được chấp nhận:{' '}
                      <strong style={{ color: '#20bfa9' }}>
                        {Array.isArray(currentQ.answers)
                          ? (currentQ.answers as string[]).join(' hoặc ')
                          : String(currentQ.answer || '')}
                      </strong>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 3. MULTIPLE CHOICE / TRUE-FALSE / MULTI-SELECT CHOICES LIST */}
        {!isMatching && !isShortAnswer && currentQ.choices && (
          <div className="quiz-choices-list">
            {currentQ.choices.map((choice, cIdx) => {
              const isSelected = isMultiSelect
                ? Array.isArray(userAnswers[currentIdx]) && (userAnswers[currentIdx] as number[]).includes(cIdx)
                : userAnswers[currentIdx] === cIdx;

              const isCorrect = isMultiSelect
                ? (((currentQ.answers || (typeof currentQ.answer === 'number' ? [currentQ.answer] : [])) as unknown[]) as (number | string)[]).includes(cIdx)
                : currentQ.answer === cIdx;

              const isMissed = submitted && isMultiSelect && isCorrect && !isSelected;

              let choiceClass = 'quiz-choice-btn';
              if (isMultiSelect) choiceClass += ' multi-choice';
              if (isSelected) choiceClass += ' selected';
              if (submitted) {
                if (isCorrect) choiceClass += ' correct-answer';
                else if (isSelected && !isCorrect) choiceClass += ' wrong-answer';
                else if (isMissed) choiceClass += ' missed-answer';
              }

              const letter = String.fromCharCode(65 + cIdx);

              return (
                <button
                  key={cIdx}
                  type="button"
                  className={choiceClass}
                  onClick={() => handleSelectAnswer(currentIdx, cIdx)}
                  disabled={submitted}
                >
                  <div className={`choice-prefix ${isMultiSelect ? 'checkbox-style' : 'radio-style'}`}>
                    {isMultiSelect ? (
                      isSelected ? (
                        <Check size={14} strokeWidth={3.5} className="choice-check-icon" />
                      ) : (
                        <span className="choice-letter">{letter}</span>
                      )
                    ) : (
                      <span className="choice-letter">{letter}</span>
                    )}
                  </div>
                  <span className="choice-text">{choice}</span>

                  {submitted && isCorrect && isSelected && (
                    <span className="choice-badge-status correct">
                      <Check size={12} strokeWidth={3} />
                      <span>Đúng</span>
                    </span>
                  )}
                  {submitted && isMissed && (
                    <span className="choice-badge-status missed">
                      <Check size={12} strokeWidth={3} />
                      <span>Đáp án đúng</span>
                    </span>
                  )}
                  {submitted && isSelected && !isCorrect && (
                    <span className="choice-badge-status wrong">
                      <X size={12} strokeWidth={3} />
                      <span>Sai</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Explanation Box (Visible after submission) */}
        {submitted && currentQ.explanation && (
          <div className="quiz-explanation-box">
            <div className="explanation-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Lightbulb size={15} style={{ color: '#fbbf24' }} />
              <span>Giải thích chi tiết:</span>
            </div>
            <div className="explanation-text">
              <MarkdownRenderer content={currentQ.explanation} />
            </div>
          </div>
        )}

        {/* Navigation & Submit footer */}
        <div className="quiz-card-footer">
          <button
            type="button"
            className="reconfigure-btn"
            disabled={currentIdx === 0}
            onClick={() => setCurrentIdx(prev => Math.max(0, prev - 1))}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <ChevronLeft size={14} />
            Câu trước
          </button>

          <div className="quiz-nav-dots">
            {quizQuestions.map((q, dotIdx) => {
              const isAnswered = isQuestionAnswered(dotIdx);
              const isCurr = dotIdx === currentIdx;
              let dotClass = 'quiz-dot';
              if (isCurr) dotClass += ' active';
              if (isAnswered) dotClass += ' answered';
              if (submitted) {
                dotClass += isAnswerCorrect(q, dotIdx) ? ' pass' : ' fail';
              }

              return (
                <button
                  key={dotIdx}
                  type="button"
                  className={dotClass}
                  onClick={() => setCurrentIdx(dotIdx)}
                  title={`Đến câu ${dotIdx + 1}`}
                >
                  {dotIdx + 1}
                </button>
              );
            })}
          </div>

          {currentIdx < totalQuestions - 1 ? (
            <button
              type="button"
              className="generate-tool-btn"
              style={{ margin: 0, padding: '8px 16px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              onClick={() => setCurrentIdx(prev => Math.min(totalQuestions - 1, prev + 1))}
            >
              <span>Câu tiếp theo</span>
              <ChevronRight size={14} />
            </button>
          ) : !submitted ? (
            <button
              type="button"
              className="generate-tool-btn"
              style={{
                margin: 0,
                padding: '8px 20px',
                fontSize: '13px',
                background: 'linear-gradient(135deg, #10b981, #059669)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
              onClick={handleSubmit}
            >
              <CheckCircle2 size={15} />
              <span>Nộp bài thi</span>
            </button>
          ) : (
            <button
              type="button"
              className="reconfigure-btn"
              onClick={handleReconfigure}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <CheckCircle2 size={14} />
              <span>Hoàn thành</span>
            </button>
          )}
        </div>
      </div>

      {/* Quiz Analysis Diagnosis Modal */}
      <QuizAnalysisModal
        isOpen={showAnalysisModal}
        onClose={() => setShowAnalysisModal(false)}
        analysis={recentAnalysis}
        onStartRemediation={topics => {
          setGeneratorMode('targeted');
          setWeakTopics(topics);
          setDifficulty('hard');
          handleReconfigure();
        }}
      />
    </div>
  );
}

