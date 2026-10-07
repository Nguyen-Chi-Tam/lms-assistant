'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Sparkles,
  Send,
  MessageSquare,
  ListChecks,
  BookOpen,
  HelpCircle,
  Check,
  RotateCcw,
  Zap,
} from 'lucide-react';
import type { ExamResult, QuizAnalysisData } from '@/app/types';
import {
  resolveGradeRoute,
  buildGradePrompt,
  formatGrade,
  GRADE_RESPONSE_STRATEGIES,
  type GradeResponseStrategy,
  type GradeRouteInfo,
} from '@/app/lib/grade-router';

interface GradePromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  result: ExamResult | null;
  analysis?: QuizAnalysisData | null;
  onOpenInChat: (prompt: string, route: GradeRouteInfo) => void;
  onSendNow: (prompt: string, route: GradeRouteInfo) => void;
}

export function GradePromptModal({
  isOpen,
  onClose,
  result,
  analysis,
  onOpenInChat,
  onSendNow,
}: GradePromptModalProps) {
  const [mounted, setMounted] = useState(false);
  const [strategy, setStrategy] = useState<GradeResponseStrategy>('roadmap');
  const [detailLevel, setDetailLevel] = useState<'concise' | 'detailed'>('detailed');
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [isEdited, setIsEdited] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // When modal opens or result changes, initialize strategy and prompt
  useEffect(() => {
    if (result && isOpen) {
      const initialRoute = resolveGradeRoute(result, false);
      setStrategy(initialRoute.defaultStrategy);
      const generated = buildGradePrompt(result, initialRoute.defaultStrategy, detailLevel, analysis);
      setCustomPrompt(generated);
      setIsEdited(false);
    }
  }, [result, isOpen]);

  // Sync prompt when strategy or detail level changes (if not manually edited)
  useEffect(() => {
    if (result && isOpen && !isEdited) {
      const generated = buildGradePrompt(result, strategy, detailLevel, analysis);
      setCustomPrompt(generated);
    }
  }, [result, isOpen, strategy, detailLevel, analysis, isEdited]);

  const handleStrategyChange = (newStrategy: GradeResponseStrategy) => {
    setStrategy(newStrategy);
    if (result) {
      setCustomPrompt(buildGradePrompt(result, newStrategy, detailLevel, analysis));
      setIsEdited(false);
    }
  };

  const handleDetailChange = (newDetail: 'concise' | 'detailed') => {
    setDetailLevel(newDetail);
    if (result) {
      setCustomPrompt(buildGradePrompt(result, strategy, newDetail, analysis));
      setIsEdited(false);
    }
  };

  const handleResetPrompt = () => {
    if (result) {
      setCustomPrompt(buildGradePrompt(result, strategy, detailLevel, analysis));
      setIsEdited(false);
    }
  };

  const handleCopy = async () => {
    if (!customPrompt) return;
    try {
      await navigator.clipboard.writeText(customPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  React.useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen, onClose]);

  if (!isOpen || !result || !mounted) return null;

  const currentRoute = resolveGradeRoute(result, false, strategy, detailLevel);

  const scoreNum = Number(result.score) || 0;
  const maxScore = Number(result.maxScore) || 10;
  const percentageStr = result.percentage || `${Math.round((scoreNum / maxScore) * 100)}%`;

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
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="grade-history-modal"
        style={{
          background: 'linear-gradient(145deg, #13121f, #0d0c15)',
          border: '1px solid rgba(124, 109, 242, 0.35)',
          borderRadius: '18px',
          width: '100%',
          maxWidth: '700px',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.85), 0 0 35px rgba(124, 109, 242, 0.25)',
          overflow: 'hidden',
          overscrollBehavior: 'contain',
          color: '#f3f2f8',
        }}
      >
        {/* Header */}
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
                background: currentRoute.buttonGradient || 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 14px rgba(139, 92, 246, 0.4)',
                flexShrink: 0,
              }}
            >
              <Sparkles size={18} color="#ffffff" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: '15.5px', fontWeight: 700, letterSpacing: '-0.2px' }}>
                  Tùy Chọn Phản Hồi Gia Sư AI
                </h3>
              </div>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#94a3b8' }}>
                <strong style={{ color: '#e2e8f0' }}>{result.name}</strong> • Môn: {result.courseName} • Điểm:{' '}
                <strong style={{ color: result.passed ? '#22c55e' : '#f43f5e' }}>
                  {formatGrade(result.score)}/{formatGrade(result.maxScore)}
                </strong>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="modal-close-btn"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '10px',
              padding: '6px',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div
          style={{
            padding: '1.25rem 1.5rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
            flex: '1 1 auto',
            minHeight: 0,
            overscrollBehavior: 'contain',
          }}
        >
          {/* Teacher Feedback Banner (if any) */}
          {result.feedback && (
            <div
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '12px',
                background: 'rgba(124, 109, 242, 0.12)',
                border: '1px solid rgba(124, 109, 242, 0.3)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#c4b5fd',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                <MessageSquare size={13} />
                Nhận xét từ Giảng viên:
              </span>
              <p style={{ margin: 0, fontSize: '13px', color: '#f1f5f9', fontStyle: 'italic', lineHeight: 1.4 }}>
                "{result.feedback}"
              </p>
            </div>
          )}

          {/* Section 1: Response Focus Strategy */}
          <div>
            <div
              style={{
                fontSize: '12px',
                fontWeight: 700,
                color: '#cbd5e1',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                marginBottom: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>1. Chọn cách bạn muốn AI phản hồi:</span>
              <span style={{ fontSize: '11px', color: '#64748b', textTransform: 'none', fontWeight: 500 }}>
                Nhấp để thay đổi hướng dẫn AI
              </span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: '8px',
              }}
            >
              {GRADE_RESPONSE_STRATEGIES.map(st => {
                const isSelected = strategy === st.id;
                const IconComp =
                  st.id === 'roadmap'
                    ? ListChecks
                    : st.id === 'deep_dive'
                    ? BookOpen
                    : st.id === 'socratic'
                    ? HelpCircle
                    : Sparkles;

                return (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => handleStrategyChange(st.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: '12px',
                      background: isSelected
                        ? 'linear-gradient(135deg, rgba(124, 109, 242, 0.28), rgba(90, 73, 215, 0.18))'
                        : 'rgba(255, 255, 255, 0.03)',
                      border: isSelected
                        ? '1.5px solid #8b5cf6'
                        : '1px solid rgba(255, 255, 255, 0.08)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: isSelected ? '0 4px 12px rgba(139, 92, 246, 0.25)' : 'none',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        marginBottom: '4px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <IconComp size={15} color={isSelected ? '#c4b5fd' : '#94a3b8'} />
                        <strong
                          style={{
                            fontSize: '13px',
                            color: isSelected ? '#ffffff' : '#e2e8f0',
                            fontWeight: isSelected ? 700 : 600,
                          }}
                        >
                          {st.label}
                        </strong>
                      </div>
                      {isSelected && (
                        <div
                          style={{
                            width: '16px',
                            height: '16px',
                            borderRadius: '50%',
                            background: '#8b5cf6',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Check size={11} color="#ffffff" />
                        </div>
                      )}
                    </div>
                    <small
                      style={{
                        fontSize: '11px',
                        color: isSelected ? '#cbd5e1' : '#64748b',
                        lineHeight: 1.35,
                      }}
                    >
                      {st.description}
                    </small>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Section 2: Detail Level Selector */}
          <div>
            <div
              style={{
                fontSize: '12px',
                fontWeight: 700,
                color: '#cbd5e1',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                marginBottom: '8px',
              }}
            >
              2. Độ chi tiết của câu trả lời:
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => handleDetailChange('concise')}
                style={{
                  flex: 1,
                  minWidth: '150px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  padding: '8px 14px',
                  borderRadius: '10px',
                  fontSize: '12.5px',
                  fontWeight: detailLevel === 'concise' ? 700 : 500,
                  color: detailLevel === 'concise' ? '#ffffff' : '#94a3b8',
                  background:
                    detailLevel === 'concise'
                      ? 'rgba(56, 189, 248, 0.2)'
                      : 'rgba(255, 255, 255, 0.03)',
                  border:
                    detailLevel === 'concise'
                      ? '1px solid #38bdf8'
                      : '1px solid rgba(255, 255, 255, 0.08)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <Zap size={14} color={detailLevel === 'concise' ? '#38bdf8' : '#94a3b8'} />
                <span>Trọng tâm & Súc tích</span>
              </button>

              <button
                type="button"
                onClick={() => handleDetailChange('detailed')}
                style={{
                  flex: 1,
                  minWidth: '150px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  padding: '8px 14px',
                  borderRadius: '10px',
                  fontSize: '12.5px',
                  fontWeight: detailLevel === 'detailed' ? 700 : 500,
                  color: detailLevel === 'detailed' ? '#ffffff' : '#94a3b8',
                  background:
                    detailLevel === 'detailed'
                      ? 'rgba(168, 85, 247, 0.2)'
                      : 'rgba(255, 255, 255, 0.03)',
                  border:
                    detailLevel === 'detailed'
                      ? '1px solid #a855f7'
                      : '1px solid rgba(255, 255, 255, 0.08)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <BookOpen size={14} color={detailLevel === 'detailed' ? '#c084fc' : '#94a3b8'} />
                <span>Chi tiết & Chuyên sâu (Giáo trình)</span>
              </button>
            </div>
          </div>

          {/* Section 3: Editable Prompt Preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  style={{
                    fontSize: '12px',
                    fontWeight: 700,
                    color: '#cbd5e1',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                >
                  3. Câu lệnh gửi tới AI (Bạn có thể xem trước và sửa tùy ý):
                </span>
                {isEdited && (
                  <span
                    style={{
                      fontSize: '10.5px',
                      padding: '1px 6px',
                      borderRadius: '5px',
                      background: 'rgba(245, 158, 11, 0.2)',
                      color: '#fbbf24',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                    }}
                  >
                    Đã chỉnh sửa
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {isEdited && (
                  <button
                    type="button"
                    onClick={handleResetPrompt}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#94a3b8',
                      fontSize: '11.5px',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      textDecoration: 'underline',
                    }}
                    title="Đặt lại câu lệnh theo định hướng đã chọn"
                  >
                    <RotateCcw size={12} />
                    <span>Đặt lại mẫu</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCopy}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: copied ? '#22c55e' : '#38bdf8',
                    fontSize: '11.5px',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  {copied ? <Check size={12} /> : <MessageSquare size={12} />}
                  <span>{copied ? 'Đã sao chép' : 'Sao chép câu lệnh'}</span>
                </button>
              </div>
            </div>

            <textarea
              value={customPrompt}
              onChange={e => {
                setCustomPrompt(e.target.value);
                setIsEdited(true);
              }}
              rows={6}
              placeholder="Nội dung câu lệnh gửi tới Gia sư AI..."
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'rgba(0, 0, 0, 0.35)',
                border: '1.5px solid rgba(124, 109, 242, 0.5)',
                borderRadius: '12px',
                padding: '12px 14px',
                color: '#f8fafc',
                fontSize: '13px',
                lineHeight: 1.5,
                fontFamily: 'inherit',
                resize: 'vertical',
                outline: 'none',
                transition: 'all 0.2s ease',
                boxShadow: '0 0 15px rgba(124, 109, 242, 0.1)',
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = '#8b5cf6';
                e.currentTarget.style.boxShadow = '0 0 20px rgba(139, 92, 246, 0.3)';
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.2)';
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = 'rgba(124, 109, 242, 0.5)';
                e.currentTarget.style.boxShadow = '0 0 15px rgba(124, 109, 242, 0.1)';
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.35)';
              }}
            />
            <small style={{ fontSize: '11.5px', color: '#64748b' }}>
              💡 Mẹo: Bạn có thể thêm yêu cầu cụ thể (ví dụ: "Tôi cần ôn gấp trong 2 ngày" hoặc "Hãy cho ví dụ bằng ngôn ngữ Python") ngay trong ô trên.
            </small>
          </div>
        </div>

        {/* Modal Footer Actions */}
        <div
          style={{
            padding: '1rem 1.5rem',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(0, 0, 0, 0.25)',
            flexShrink: 0,
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '10px',
              fontSize: '13px',
              color: '#94a3b8',
              background: 'transparent',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Hủy
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {/* Action 1: Open in Chat with Draft (No auto-send, prompt left in input box) */}
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenInChat(customPrompt, currentRoute);
              }}
              style={{
                padding: '9px 16px',
                borderRadius: '10px',
                fontSize: '13px',
                fontWeight: 600,
                color: '#c4b5fd',
                background: 'rgba(124, 109, 242, 0.18)',
                border: '1px solid rgba(124, 109, 242, 0.4)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.15s ease',
              }}
              title="Chuyển câu lệnh vào ô chat để bạn tiếp tục gõ thêm trước khi gửi"
            >
              <MessageSquare size={15} />
              <span>Chuyển vào khung Chat (Soạn tiếp)</span>
            </button>

            {/* Action 2: Send Now */}
            <button
              type="button"
              onClick={() => {
                onClose();
                onSendNow(customPrompt, currentRoute);
              }}
              style={{
                padding: '9px 20px',
                borderRadius: '10px',
                fontSize: '13px',
                fontWeight: 600,
                color: '#ffffff',
                background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 4px 14px rgba(139, 92, 246, 0.4)',
                transition: 'all 0.15s ease',
              }}
              title="Gửi câu lệnh này tới Gia sư AI để bắt đầu phiên phân tích ngay"
            >
              <Send size={14} />
              <span>Bắt đầu trao đổi ngay</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
