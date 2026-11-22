'use client';

import { useRef, useState } from 'react';
import { Bot, LoaderCircle, Send, Sparkles, Trash2 } from 'lucide-react';
import { MarkdownRenderer } from '@/app/components/ui/MarkdownRenderer';

interface AdvisorMessage {
  role: 'user' | 'ai';
  text: string;
}

interface AcademicAdvisorChatProps {
  academicContext: string;
  userId?: number;
  targetGpa: number;
}

const QUICK_PROMPTS = [
  'Phân tích điểm mạnh & điểm yếu',
  'Kế hoạch nâng GPA theo mục tiêu',
  'Môn cần ưu tiên ôn tập trước',
  'Kiểm tra bài tập & điểm danh',
];

export function AcademicAdvisorChat({
  academicContext,
  userId,
  targetGpa,
}: AcademicAdvisorChatProps) {
  const [messages, setMessages] = useState<AdvisorMessage[]>([
    {
      role: 'ai',
      text: `Chào bạn. Tôi đã đồng bộ bảng điểm và lịch học từ Moodle (mục tiêu: **${targetGpa.toFixed(1)}/10**). Bạn cần tư vấn môn nào?`,
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sendMessage = async (promptText?: string) => {
    const question = (promptText ?? input).trim();
    if (!question || loading) return;

    const nextMessages: AdvisorMessage[] = [...messages, { role: 'user', text: question }];
    setMessages(nextMessages);
    if (!promptText) setInput('');
    setLoading(true);
    setError(null);

    window.setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 50);

    try {
      const res = await fetch('/api/dashboard/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          history: messages.slice(-6),
          academicContext,
          userId,
        }),
      });
      const data = (await res.json()) as { answer?: string; error?: string };
      if (!res.ok || !data.answer) {
        throw new Error(data.error || 'Cố vấn AI không thể phản hồi lúc này.');
      }
      setMessages(prev => [...prev, { role: 'ai', text: data.answer! }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi kết nối Cố vấn AI.');
    } finally {
      setLoading(false);
      window.setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }, 60);
    }
  };

  return (
    <section className="advisor-chat-card" aria-labelledby="advisor-chat-title">
      <div className="advisor-chat-head">
        <div className="advisor-chat-title-wrap">
          <span className="advisor-chat-orb">
            <Bot size={18} />
          </span>
          <div>
            <h3 id="advisor-chat-title">Cố vấn học tập</h3>
            <p>Hỏi đáp về điểm số, bài tập và kế hoạch học tập</p>
          </div>
        </div>
        {messages.length > 1 && (
          <button
            type="button"
            className="advisor-chat-clear"
            onClick={() => setMessages(messages.slice(0, 1))}
            title="Làm mới cuộc trò chuyện"
          >
            <Trash2 size={13} />
            <span>Làm mới</span>
          </button>
        )}
      </div>

      <div className="advisor-chat-prompts">
        {QUICK_PROMPTS.map(prompt => (
          <button
            key={prompt}
            type="button"
            className="advisor-prompt-pill"
            disabled={loading}
            onClick={() => void sendMessage(prompt)}
          >
            <Sparkles size={12} />
            <span>{prompt}</span>
          </button>
        ))}
      </div>

      <div className="advisor-chat-messages" ref={scrollRef}>
        {messages.map((msg, idx) => (
          <div key={idx} className={`advisor-msg ${msg.role}`}>
            <div className="advisor-msg-bubble">
              {msg.role === 'ai' ? <MarkdownRenderer content={msg.text} /> : msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="advisor-msg ai">
            <div className="advisor-msg-bubble loading">
              <LoaderCircle size={15} className="quick-test-spin" />
              <span>Cố vấn AI đang phân tích bảng điểm &amp; hoạt động của bạn…</span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="advisor-chat-error" role="alert">
          {error}
        </p>
      )}

      <form
        className="advisor-chat-compose"
        onSubmit={e => {
          e.preventDefault();
          void sendMessage();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Nhập câu hỏi về kết quả học tập..."
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()} aria-label="Gửi câu hỏi">
          <Send size={15} />
          <span>Gửi</span>
        </button>
      </form>
    </section>
  );
}
