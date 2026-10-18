'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Sparkles,
  Target,
  Brain,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Lightbulb,
  ArrowRight,
  BookOpen,
  Award,
  RotateCcw,
  ChevronDown,
  MessageSquare,
  Square,
} from 'lucide-react';
import type { QuizAnalysisData } from '@/app/types';
import { MarkdownRenderer } from '@/app/components/MarkdownRenderer';
import { formatGrade, cleanAnswerText } from '@/app/lib/grade-router';

interface QuizAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  analysis: QuizAnalysisData | null;
  loading?: boolean;
  loadingStage?: 'fetching_saved' | 'ai_diagnosing';
  examName?: string;
  courseName?: string;
  error?: string | null;
  onStop?: () => void;
  onRetry?: () => void;
  onReanalyze?: () => void;
  onDelete?: () => Promise<void>;
  onStartRemediation?: (weakTopics: string[]) => void;
  onAskTutor?: (analysis?: QuizAnalysisData | null) => void;
}

export function QuizAnalysisModal({
  isOpen,
  onClose,
  analysis,
  loading = false,
  loadingStage = 'fetching_saved',
  examName,
  courseName,
  error = null,
  onStop,
  onRetry,
  onReanalyze,
  onDelete,
  onStartRemediation,
  onAskTutor,
}: QuizAnalysisModalProps) {
  const [showImproveMenu, setShowImproveMenu] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!isOpen) {
      setShowImproveMenu(false);
      return;
    }
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (loading && onStop) {
          onStop();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, loading, onClose, onStop]);

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="grade-history-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(10px)',
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3.75rem 1.25rem 1.5rem 1.25rem',
        animation: 'fadeIn 0.2s ease',
        overscrollBehavior: 'contain',
      }}
      onClick={e => {
        if (e.target === e.currentTarget) {
          if (loading && onStop) {
            onStop();
          } else {
            onClose();
          }
        }
      }}
    >
      <div
        className="grade-history-modal"
        style={{
          background: 'linear-gradient(145deg, #13121f, #0d0c15)',
          border: '1px solid rgba(124, 109, 242, 0.35)',
          borderRadius: '18px',
          width: '100%',
          maxWidth: '860px',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.85), 0 0 35px rgba(124, 109, 242, 0.2)',
          overflow: 'hidden',
          overscrollBehavior: 'contain',
          color: '#f3f2f8',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '0.9rem 1.4rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(124, 109, 242, 0.08)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 14px rgba(139, 92, 246, 0.4)',
                flexShrink: 0,
              }}
            >
              <Brain size={18} color="#ffffff" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: '15.5px', fontWeight: 700, letterSpacing: '-0.3px' }}>
                  Bản Phân Tích Lỗ Hổng Kiến Thức (AI Quiz Diagnosis)
                </h3>
                {analysis?.cached && (
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      background: 'rgba(34, 197, 94, 0.18)',
                      color: '#4ade80',
                      border: '1px solid rgba(34, 197, 94, 0.3)',
                      fontWeight: 600,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                    title="Bản chẩn đoán được tải từ bộ nhớ đã lưu, không tiêu tốn thêm AI credits"
                  >
                    <span>✓</span> Đã lưu
                  </span>
                )}
              </div>
              <p style={{ margin: '2px 0 0', fontSize: '12.5px', color: '#94a3b8' }}>
                {examName || analysis?.quizName || 'Kiểm tra trắc nghiệm'} • {courseName || analysis?.courseName || 'Moodle LMS'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              if (loading && onStop) {
                onStop();
              } else {
                onClose();
              }
            }}
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '50%',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#cbd5e1',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            title={loading ? 'Dừng và đóng' : 'Đóng'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div
          style={{
            padding: '1.1rem 1.35rem',
            overflowY: 'auto',
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '1.1rem',
            overscrollBehavior: 'contain',
          }}
        >
          {loading && (
            <div
              style={{
                padding: '3rem 1.5rem',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.85rem',
              }}
            >
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(236, 72, 153, 0.2))',
                  border: '2px solid #8b5cf6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  animation: 'pulse 1.5s infinite',
                }}
              >
                <Sparkles size={22} color="#c084fc" />
              </div>
              <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
                {loadingStage === 'fetching_saved'
                  ? 'Đang nạp dữ liệu phân tích đã lưu…'
                  : 'Đang chẩn đoán kết quả bài thi cùng AI…'}
              </h4>
              <p style={{ margin: 0, fontSize: '12.5px', color: '#94a3b8', maxWidth: '400px', lineHeight: 1.45 }}>
                {loadingStage === 'fetching_saved'
                  ? 'Hệ thống đang kiểm tra bộ nhớ đệm và nạp dữ liệu phân tích đã lưu trước đó.'
                  : 'AI đang bóc tách từng câu hỏi, đối chiếu giáo trình và nhận diện các điểm mù tư duy của bạn.'}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (onStop) {
                    onStop();
                  } else {
                    onClose();
                  }
                }}
                style={{
                  marginTop: '0.65rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '7px',
                  padding: '0.5rem 1.15rem',
                  borderRadius: '20px',
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  color: '#fca5a5',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                title="Dừng khẩn cấp quá trình chẩn đoán AI"
              >
                <Square size={11} fill="currentColor" />
                <span>Dừng chẩn đoán</span>
              </button>
            </div>
          )}

          {!loading && error && !analysis && (
            <div
              style={{
                padding: '2rem 1.5rem',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.85rem',
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: '14px',
              }}
            >
              <AlertTriangle size={32} color="#f87171" />
              <h4 style={{ margin: 0, fontSize: '15px', color: '#fca5a5' }}>
                {error}
              </h4>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="reconfigure-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '0.4rem' }}
                >
                  <RotateCcw size={13} />
                  <span>Thử phân tích lại</span>
                </button>
              )}
            </div>
          )}

          {!loading && analysis && (
            <>
              {error && (
                <div
                  style={{
                    padding: '0.65rem 1rem',
                    borderRadius: '10px',
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#fca5a5',
                    fontSize: '12.5px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <AlertTriangle size={15} color="#f87171" />
                  <span>{error}</span>
                </div>
              )}
              {/* Score & Key Stats Row */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: '10px',
                }}
              >
                <div
                  style={{
                    padding: '0.75rem 0.95rem',
                    borderRadius: '12px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    minHeight: '66px',
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '9px',
                      background: analysis.score >= 5 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      color: analysis.score >= 5 ? '#34d399' : '#f87171',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '15px',
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {formatGrade(analysis.score)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Điểm Moodle
                    </div>
                    <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#f3f2f8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {formatGrade(analysis.score)} / {formatGrade(analysis.maxScore)}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    padding: '0.75rem 0.95rem',
                    borderRadius: '12px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    minHeight: '66px',
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '9px',
                      background: 'rgba(239, 68, 68, 0.15)',
                      color: '#f87171',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <XCircle size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Sai hoàn toàn
                    </div>
                    <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#f87171', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {analysis.wrongCount} / {analysis.totalQuestions} câu
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    padding: '0.75rem 0.95rem',
                    borderRadius: '12px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    minHeight: '66px',
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '9px',
                      background: 'rgba(245, 158, 11, 0.15)',
                      color: '#fbbf24',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <AlertTriangle size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Đúng một phần
                    </div>
                    <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#fbbf24', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {analysis.partialCount} câu
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    padding: '0.75rem 0.95rem',
                    borderRadius: '12px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    minHeight: '66px',
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '9px',
                      background: 'rgba(168, 85, 247, 0.18)',
                      color: '#c084fc',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Target size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Lỗ hổng phát hiện
                    </div>
                    <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#c084fc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {(analysis.weakTopics || []).length} chủ đề cốt lõi
                    </div>
                  </div>
                </div>
              </div>

              {/* Detected Weak Topics Section */}
              {analysis.weakTopics && analysis.weakTopics.length > 0 && (
                <div
                  style={{
                    padding: '0.85rem 1.1rem',
                    borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.12), rgba(236, 72, 153, 0.08))',
                    border: '1px solid rgba(139, 92, 246, 0.3)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.65rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Target size={15} color="#c084fc" />
                    <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#d8b4fe', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Các chủ đề ngộ nhận & cần củng cố ngay (Detected Weak Concepts)
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {analysis.weakTopics.map((topic, tIdx) => (
                      <span
                        key={tIdx}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 10px',
                          borderRadius: '16px',
                          background: 'rgba(139, 92, 246, 0.22)',
                          border: '1px solid rgba(168, 85, 247, 0.45)',
                          color: '#f3e8ff',
                          fontSize: '11.5px',
                          fontWeight: 600,
                        }}
                      >
                        <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#ec4899' }} />
                        {topic}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* AI Pedagogical Overview */}
              <div
                style={{
                  padding: '0.95rem 1.15rem',
                  borderRadius: '14px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.65rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Lightbulb size={15} color="#fbbf24" />
                  <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#fde68a', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Đánh giá sư phạm từ AI Tutor
                  </span>
                </div>
                <div style={{ fontSize: '12.5px', lineHeight: 1.55, color: '#cbd5e1' }}>
                  <MarkdownRenderer content={analysis.overview || ''} />
                </div>

                {analysis.recommendations && analysis.recommendations.length > 0 && (
                  <div style={{ marginTop: '0.35rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '0.65rem' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                      Lộ trình khắc phục gợi ý:
                    </span>
                    <ul style={{ margin: '4px 0 0', paddingLeft: '1.15rem', fontSize: '12px', color: '#e2e8f0' }}>
                      {analysis.recommendations.map((rec, rIdx) => (
                        <li key={rIdx} style={{ marginBottom: '3px' }}>
                          {rec}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Mistake Questions Detailed Breakdown */}
              {analysis.questionsAnalysis && analysis.questionsAnalysis.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h4 style={{ margin: 0, fontSize: '13.5px', fontWeight: 700, color: '#f3f2f8' }}>
                      Chi tiết {analysis.questionsAnalysis.length} câu hỏi bị trừ điểm:
                    </h4>
                    <span style={{ fontSize: '11.5px', color: '#94a3b8' }}>
                      Đối chiếu bài làm và giải thích bản chất
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {analysis.questionsAnalysis.map((q, qIdx) => {
                      const isWrong = (q.status || '').toLowerCase().includes('incorrect') || q.mark === '0.00';
                      return (
                        <div
                          key={qIdx}
                          style={{
                            padding: '0.85rem 1.05rem',
                            borderRadius: '12px',
                            background: 'rgba(255, 255, 255, 0.025)',
                            border: isWrong
                              ? '1px solid rgba(239, 68, 68, 0.25)'
                              : '1px solid rgba(245, 158, 11, 0.25)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.55rem',
                          }}
                        >
                          {/* Question header */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span
                                style={{
                                  fontSize: '11px',
                                  fontWeight: 700,
                                  padding: '2px 7px',
                                  borderRadius: '5px',
                                  background: isWrong ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                                  color: isWrong ? '#fca5a5' : '#fde68a',
                                }}
                              >
                                Câu {q.slot}
                              </span>
                              <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                                Điểm: {formatGrade(q.mark)} / {formatGrade(q.maxmark)}
                              </span>
                            </div>

                            <span
                              style={{
                                fontSize: '10.5px',
                                padding: '2px 7px',
                                borderRadius: '5px',
                                background: isWrong ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                                color: isWrong ? '#f87171' : '#fbbf24',
                                fontWeight: 600,
                              }}
                            >
                              {isWrong ? 'Sai' : 'Đúng một phần'}
                            </span>
                          </div>

                          {/* Question Text */}
                          <div style={{ fontSize: '13px', fontWeight: 600, color: '#f8fafc' }}>
                            <MarkdownRenderer content={q.questionText} />
                          </div>

                          {/* Answers comparison */}
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                              gap: '6px',
                              marginTop: '2px',
                            }}
                          >
                            <div
                              style={{
                                padding: '6px 10px',
                                borderRadius: '7px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                                fontSize: '12px',
                              }}
                            >
                              <span style={{ fontWeight: 700, color: '#f87171' }}>Bạn đã chọn: </span>
                              <span style={{ color: '#fca5a5' }}>{cleanAnswerText(q.studentAnswer)}</span>
                            </div>

                            <div
                              style={{
                                padding: '6px 10px',
                                borderRadius: '7px',
                                background: 'rgba(16, 185, 129, 0.1)',
                                border: '1px solid rgba(16, 185, 129, 0.2)',
                                fontSize: '12px',
                              }}
                            >
                              <span style={{ fontWeight: 700, color: '#34d399' }}>Đáp án đúng: </span>
                              <span style={{ color: '#6ee7b7' }}>{cleanAnswerText(q.rightAnswer)}</span>
                            </div>
                          </div>

                          {/* Official Explanation from Quiz / Moodle */}
                          {(q.explanation || q.feedback) && (
                            <div
                              style={{
                                padding: '7px 11px',
                                borderRadius: '8px',
                                background: 'rgba(56, 189, 248, 0.08)',
                                border: '1px solid rgba(56, 189, 248, 0.22)',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '7px',
                                fontSize: '12px',
                                color: '#e0f2fe',
                                lineHeight: 1.45,
                              }}
                            >
                              <BookOpen size={14} color="#38bdf8" style={{ flexShrink: 0, marginTop: '2px' }} />
                              <div>
                                <strong style={{ color: '#38bdf8' }}>Lời giải từ đề thi: </strong>
                                <span>{q.explanation || q.feedback}</span>
                              </div>
                            </div>
                          )}

                          {/* Diagnosed reason */}
                          {q.diagnosedReason && q.diagnosedReason !== (q.explanation || q.feedback) && (
                            <div
                              style={{
                                padding: '7px 11px',
                                borderRadius: '8px',
                                background: 'rgba(139, 92, 246, 0.1)',
                                border: '1px solid rgba(139, 92, 246, 0.25)',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '7px',
                                fontSize: '12px',
                                color: '#e9d5ff',
                                lineHeight: 1.45,
                              }}
                            >
                              <Brain size={14} color="#c084fc" style={{ flexShrink: 0, marginTop: '2px' }} />
                              <div>
                                <strong style={{ color: '#d8b4fe' }}>Chẩn đoán tư duy: </strong>
                                <span>{q.diagnosedReason}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '0.75rem 1.4rem',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(0, 0, 0, 0.35)',
            flexShrink: 0,
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>

            {analysis && onReanalyze && (
              <button
                type="button"
                onClick={() => {
                  if (
                    typeof window !== 'undefined' &&
                    window.confirm(
                      'Bạn có muốn chẩn đoán lại bài thi này bằng AI? Lần chẩn đoán mới sẽ tốn AI credits và cập nhật lại lộ trình ôn tập.'
                    )
                  ) {
                    onReanalyze();
                  }
                }}
                style={{
                  padding: '7px 12px',
                  borderRadius: '9px',
                  fontSize: '12px',
                  color: '#cbd5e1',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.15s',
                }}
                title="Tạo lại bản phân tích mới bằng AI (tốn AI token)"
              >
                <RotateCcw size={13} />
                <span>Chẩn đoán lại</span>
              </button>
            )}
            {analysis && analysis.id && onDelete && (
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  if (!window.confirm('Bạn có chắc muốn xóa bản phân tích bài thi này không?')) return;
                  setDeleting(true);
                  try {
                    await onDelete();
                  } finally {
                    setDeleting(false);
                  }
                }}
                style={{
                  padding: '7px 12px',
                  borderRadius: '9px',
                  fontSize: '12px',
                  color: '#fca5a5',
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  cursor: deleting ? 'wait' : 'pointer',
                  opacity: deleting ? 0.6 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <XCircle size={13} />
                <span>{deleting ? 'Đang xóa...' : 'Xóa phân tích'}</span>
              </button>
            )}
          </div>

          {/* Merged Single Action Button for Improvement */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="generate-tool-btn"
              onClick={() => setShowImproveMenu(prev => !prev)}
              style={{
                margin: 0,
                padding: '9px 18px',
                fontSize: '13px',
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px',
                background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                boxShadow: '0 4px 16px rgba(139, 92, 246, 0.4)',
                cursor: 'pointer',
              }}
              title="Chọn phương pháp cải thiện điểm số và khắc phục lỗ hổng kiến thức"
            >
              <Sparkles size={15} />
              <span>Cải thiện điểm số</span>
              <ChevronDown
                size={15}
                style={{
                  transform: showImproveMenu ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s ease',
                }}
              />
            </button>

            {/* Dropdown Menu when clicked */}
            {showImproveMenu && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 10px)',
                  right: 0,
                  width: '320px',
                  background: 'linear-gradient(145deg, #181628, #100f1c)',
                  border: '1px solid rgba(124, 109, 242, 0.4)',
                  borderRadius: '14px',
                  padding: '8px',
                  boxShadow: '0 15px 35px -5px rgba(0, 0, 0, 0.9), 0 0 25px rgba(124, 109, 242, 0.3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  zIndex: 100,
                  animation: 'fadeIn 0.15s ease',
                }}
              >
                <div
                  style={{
                    padding: '6px 8px 4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: '#94a3b8',
                    textTransform: 'uppercase',
                    letterSpacing: '0.4px',
                  }}
                >
                  Chọn cách thức cải thiện:
                </div>

                {/* Option 1: Chat Tutor */}
                {onAskTutor && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowImproveMenu(false);
                      onClose();
                      onAskTutor(analysis);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(124, 109, 242, 0.2)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124, 109, 242, 0.2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)')}
                  >
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        background: 'rgba(124, 109, 242, 0.25)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <MessageSquare size={16} color="#c4b5fd" />
                    </div>
                    <div>
                      <strong style={{ display: 'block', fontSize: '12.5px', color: '#f8fafc', fontWeight: 700 }}>
                        Trao đổi với AI
                      </strong>
                      <small style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.35, display: 'block', marginTop: '2px' }}>
                        Phân tích sâu từng câu sai, bóc tách bản chất lý thuyết & vạch lộ trình
                      </small>
                    </div>
                  </button>
                )}

                {/* Option 2: Targeted Practice Quiz */}
                {analysis && analysis.weakTopics && analysis.weakTopics.length > 0 && onStartRemediation && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowImproveMenu(false);
                      onClose();
                      onStartRemediation(analysis.weakTopics);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(236, 72, 153, 0.25)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(236, 72, 153, 0.2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)')}
                  >
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        background: 'rgba(236, 72, 153, 0.25)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Target size={16} color="#f472b6" />
                    </div>
                    <div>
                      <strong style={{ display: 'block', fontSize: '12.5px', color: '#f8fafc', fontWeight: 700 }}>
                        Luyện đề trắc nghiệm mục tiêu
                      </strong>
                      <small style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.35, display: 'block', marginTop: '2px' }}>
                        Lò ấp đề thi xoáy sâu vào {analysis.weakTopics.length} điểm mù kiến thức
                      </small>
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

