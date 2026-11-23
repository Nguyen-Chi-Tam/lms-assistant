'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Play,
  Send,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { MarkdownRenderer } from '@/app/components/ui/MarkdownRenderer';

interface AdvisorMessage {
  role: 'user' | 'ai';
  text: string;
  model?: string;
  finishReason?: string;
}

interface AcademicAdvisorChatProps {
  academicContext: string;
  userId?: number;
  targetGpa: number;
}

export function AcademicAdvisorChat({
  academicContext,
  userId,
  targetGpa,
}: AcademicAdvisorChatProps) {
  const initialWelcome = `Đã đồng bộ bảng điểm và lịch học từ Moodle (mục tiêu: **${targetGpa.toFixed(1)}/10**). Bạn cần giải quyết vấn đề nào?`;
  const [messages, setMessages] = useState<AdvisorMessage[]>([
    { role: 'ai', text: initialWelcome },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [resolvedUser, setResolvedUser] = useState<{ id?: number; name?: string }>({ id: userId });

  useEffect(() => {
    if (userId) {
      setResolvedUser(prev => ({ ...prev, id: userId }));
    }
    try {
      const stored = JSON.parse(window.localStorage.getItem('moodleUser') || '{}') as {
        id?: number;
        fullname?: string;
        username?: string;
      };
      setResolvedUser(prev => ({
        id: userId || prev.id || (stored.id ? Number(stored.id) : undefined),
        name: stored.fullname || stored.username || prev.name,
      }));
    } catch {
      // ignore storage errors
    }
  }, [userId]);

  const effectiveUserId = userId || resolvedUser.id;

  const persistMessages = useCallback(
    (msgs: AdvisorMessage[], responseModel?: string) => {
      if (!effectiveUserId) return;
      const toSave = msgs.filter((_, idx) => idx > 0);
      if (toSave.length === 0) return;
      void fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: effectiveUserId,
          userName: resolvedUser.name || 'Sinh viên',
          scope: 'ai_helper',
          messages: toSave,
          response_model: responseModel,
        }),
      }).catch(err => console.warn('[AI Helper] Could not persist chat session:', err));
    },
    [effectiveUserId, resolvedUser.name]
  );

  // Load saved AI Helper conversation from Firestore `chat_sessions` (no moodle_course_id)
  useEffect(() => {
    if (!effectiveUserId) return;
    let cancelled = false;
    void fetch(`/api/chat-sessions?userId=${effectiveUserId}&scope=ai_helper`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then((raw) => {
        if (cancelled) return;
        const data = raw as { latest?: { messages?: AdvisorMessage[]; response_model?: string } } | null;
        const saved = data?.latest?.messages;
        if (Array.isArray(saved) && saved.length > 0) {
          const restored: AdvisorMessage[] = saved
            .filter(m => m && typeof m.text === 'string' && m.text.trim())
            .map(m => ({
              role: m.role === 'user' ? 'user' : 'ai',
              text: m.text,
              model: m.model || (m.role !== 'user' ? data?.latest?.response_model : undefined),
              finishReason: m.finishReason,
            }));
          if (restored.length > 0) {
            setMessages([{ role: 'ai', text: initialWelcome }, ...restored]);
          }
        }
      })
      .catch(err => console.warn('[AI Helper] Could not load chat session:', err));
    return () => {
      cancelled = true;
    };
  }, [effectiveUserId, initialWelcome]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    window.setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 40);
  }, []);

  const stopGeneration = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
    notify('Đã dừng phản hồi');
  };

  const handleClearChat = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
    setError(null);
    setMessages([{ role: 'ai', text: initialWelcome }]);
    if (effectiveUserId) {
      void fetch(`/api/chat-sessions?userId=${effectiveUserId}&scope=ai_helper`, {
        method: 'DELETE',
      }).catch(err => console.warn('[AI Helper] Could not delete chat session:', err));
    }
    notify('Đã xóa lịch sử trò chuyện');
  };

  const sendMessage = async (promptText?: string) => {
    const question = (promptText ?? input).trim();
    if (!question || loading) return;

    const historySnapshot = messages.slice(-8);
    const nextMessages: AdvisorMessage[] = [...messages, { role: 'user', text: question }];
    setMessages(nextMessages);
    if (!promptText) setInput('');
    setLoading(true);
    setError(null);
    scrollToBottom();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch('/api/dashboard/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          question,
          history: historySnapshot,
          academicContext,
          userId,
          model: 'auto',
          stream: true,
        }),
      });

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let responseModel: string | undefined;
        let finishReason: string | undefined;
        let appendedAi = false;

        const upsertAiMessage = (text: string, model?: string, reason?: string) => {
          setMessages(prev => {
            if (!appendedAi) {
              appendedAi = true;
              return [...prev, { role: 'ai', text, model, finishReason: reason }];
            }
            const copy = [...prev];
            copy[copy.length - 1] = {
              ...copy[copy.length - 1],
              text,
              model: model ?? copy[copy.length - 1].model,
              finishReason: reason ?? copy[copy.length - 1].finishReason,
            };
            return copy;
          });
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const rawJson = trimmed.slice(5).trim();
            if (!rawJson) continue;
            try {
              const evt = JSON.parse(rawJson) as {
                delta?: string;
                done?: boolean;
                model?: string;
                provider?: string;
                finishReason?: string;
                error?: string;
              };
              if (evt.error) {
                throw new Error(evt.error);
              }
              if (evt.delta) {
                accumulated += evt.delta;
                upsertAiMessage(accumulated, responseModel, finishReason);
                if (scrollRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
              }
              if (evt.done) {
                responseModel = evt.model || responseModel;
                finishReason = evt.finishReason || finishReason;
                if (accumulated) {
                  upsertAiMessage(accumulated.trim(), responseModel, finishReason);
                }
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
                throw parseErr;
              }
            }
          }
        }

        if (!accumulated.trim()) {
          throw new Error('AI Helper chưa thể phản hồi lúc này.');
        }

        const finalMessages: AdvisorMessage[] = [
          ...nextMessages,
          { role: 'ai', text: accumulated.trim(), model: responseModel, finishReason },
        ];
        persistMessages(finalMessages, responseModel);
      } else {
        const data = (await res.json()) as {
          answer?: string;
          model?: string;
          finishReason?: string;
          error?: string;
        };

        if (!res.ok || !data.answer) {
          throw new Error(data.error || 'AI Helper không thể phản hồi lúc này.');
        }

        const finalMessages: AdvisorMessage[] = [
          ...nextMessages,
          {
            role: 'ai',
            text: data.answer!,
            model: data.model,
            finishReason: data.finishReason,
          },
        ];
        setMessages(finalMessages);
        persistMessages(finalMessages, data.model);
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        // user stopped generation
      } else {
        setError(err instanceof Error ? err.message : 'Lỗi kết nối AI Helper.');
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setLoading(false);
      scrollToBottom();
    }
  };

  return (
    <section className="advisor-chat-card" aria-label="AI Helper">
      {toast && (
        <div className="advisor-chat-head" style={{ justifyContent: 'flex-end' }}>
          <span className="advisor-chat-toast">{toast}</span>
        </div>
      )}

      <div className="advisor-chat-messages" ref={scrollRef}>
        {messages.map((msg, idx) => {
          const isAi = msg.role === 'ai';
          const displayModel = msg.model
            ? msg.model.toLowerCase().includes('datacurso')
              ? 'Groq GPT-OSS 120B'
              : msg.model
            : undefined;
          const isCohere = displayModel?.toLowerCase().includes('cohere');
          const isGemini = displayModel?.toLowerCase().includes('gemini');
          const isGroq = displayModel?.toLowerCase().includes('groq');
          const isCache =
            displayModel?.toLowerCase().includes('cache') ||
            displayModel?.toLowerCase().includes('bộ nhớ đệm');

          return (
            <div key={idx} className={`advisor-msg ${msg.role}`}>
              {isAi && (
                <span className="advisor-msg-avatar" aria-hidden="true">
                  <Sparkles size={14} />
                </span>
              )}
              <div className="advisor-msg-bubble">
                <div id={`advisor-msg-${idx}`} style={{ minWidth: 0, width: '100%' }}>
                  {isAi ? <MarkdownRenderer content={msg.text} /> : msg.text}
                </div>

                {isAi && idx > 0 && !(loading && idx === messages.length - 1) && (
                  <div
                    className="message-toolbar"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      width: '100%',
                      marginTop: '8px',
                    }}
                  >
                    {displayModel ? (
                      <div
                        className="ai-model-tag-left"
                        title={`Mô hình phản hồi: ${displayModel}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '3px 8px',
                          borderRadius: '6px',
                          background: isCohere
                            ? 'rgba(244, 63, 94, 0.16)'
                            : isGemini
                              ? 'rgba(255, 122, 217, 0.16)'
                              : isGroq
                                ? 'rgba(249, 115, 22, 0.14)'
                                : isCache
                                  ? 'rgba(16, 185, 129, 0.16)'
                                  : 'rgba(56, 189, 248, 0.16)',
                          color: isCohere
                            ? '#fb7185'
                            : isGemini
                              ? '#f0a3b2'
                              : isGroq
                                ? '#fb923c'
                                : isCache
                                  ? '#34d399'
                                  : '#38bdf8',
                          border: `1px solid ${
                            isCohere
                              ? 'rgba(244, 63, 94, 0.35)'
                              : isGemini
                                ? 'rgba(255, 122, 217, 0.35)'
                                : isGroq
                                  ? 'rgba(249, 115, 22, 0.35)'
                                  : isCache
                                    ? 'rgba(16, 185, 129, 0.35)'
                                    : 'rgba(56, 189, 248, 0.35)'
                          }`,
                          userSelect: 'none',
                        }}
                      >
                        <Sparkles size={11} style={{ opacity: 0.85 }} />
                        <span>{displayModel}</span>
                      </div>
                    ) : (
                      <div />
                    )}

                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {msg.finishReason === 'length' && (
                        <button
                          type="button"
                          className="continue-generate-btn"
                          onClick={() =>
                            void sendMessage(
                              'Hãy viết tiếp tục câu trả lời đang dang dở ở trên, tuyệt đối không lặp lại đoạn đã viết.'
                            )
                          }
                          disabled={loading}
                          title="Câu trả lời đã đạt giới hạn độ dài token. Bấm để AI viết tiếp phần còn lại."
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            padding: '3px 8px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: 600,
                            background:
                              'linear-gradient(135deg, rgba(249, 115, 22, 0.18), rgba(234, 88, 12, 0.22))',
                            color: '#f97316',
                            border: '1px solid rgba(249, 115, 22, 0.4)',
                            cursor: 'pointer',
                          }}
                        >
                          <Play size={11} style={{ fill: '#f97316' }} />
                          <span>Viết tiếp</span>
                        </button>
                      )}

                      <button
                        type="button"
                        className={`copy-message-btn ${copiedIndex === idx ? 'copied' : ''}`}
                        onClick={async () => {
                          const el = document.getElementById(`advisor-msg-${idx}`);
                          if (el) {
                            const { copyRichHtmlForWord } = await import('@/lib/export/export-utils');
                            await copyRichHtmlForWord(el, msg.text);
                          } else {
                            await navigator.clipboard.writeText(msg.text);
                          }
                          setCopiedIndex(idx);
                          notify('Đã sao chép nội dung câu trả lời');
                          window.setTimeout(() => {
                            setCopiedIndex(prev => (prev === idx ? null : prev));
                          }, 2000);
                        }}
                        title="Sao chép câu trả lời (hỗ trợ dán vào Word hoặc Markdown)"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                      >
                        {copiedIndex === idx ? <Check size={13} /> : <Copy size={13} />}
                        <span>{copiedIndex === idx ? 'Đã sao chép' : 'Sao chép'}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {loading && messages[messages.length - 1]?.role !== 'ai' && (
          <div className="advisor-msg ai">
            <span className="advisor-msg-avatar" aria-hidden="true">
              <Sparkles size={14} />
            </span>
            <div className="typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="advisor-chat-error" role="alert">
          {error}
        </p>
      )}

      <div className="chat-compose advisor-chat-compose-box">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendMessage();
            }
          }}
          placeholder="Nhập câu hỏi về điểm số, bài tập hoặc kế hoạch học tập..."
          disabled={loading}
        />
        <div className="chat-compose-footer advisor-chat-compose-footer">
          <div className="chat-compose-actions">
            <button
              type="button"
              className="clear-chat-btn"
              onClick={handleClearChat}
              disabled={messages.length <= 1 || loading}
              title="Xóa toàn bộ lịch sử trò chuyện"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Trash2 size={13} />
              <span>Xóa lịch sử</span>
            </button>
            {loading ? (
              <button
                type="button"
                onClick={stopGeneration}
                style={{
                  background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                  color: '#fff',
                  border: 'none',
                  padding: '0.5rem 1.1rem',
                  borderRadius: '10px',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer',
                  boxShadow: '0 2px 10px rgba(239, 68, 68, 0.4)',
                  transition: 'all 0.2s ease',
                }}
                title="Dừng phản hồi"
              >
                <Square size={12} fill="currentColor" />
                <span>Dừng</span>
              </button>
            ) : (
              <button
                type="button"
                className="chat-send-btn"
                onClick={() => void sendMessage()}
                disabled={!input.trim()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <span>Gửi</span>
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
