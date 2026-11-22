'use client';

import { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { askPuterJSONSafe, submitPlayableFeedback } from '@/app/lib/playable';
import { parseAIJson } from '@/app/lib/playable-generator';
import {
  getTodayPlayableFeedback,
  saveTodayPlayableFeedback,
  type PlayableType,
} from '@/app/lib/playable-limit';
import { getTodayFeedbackHistory } from '@/app/lib/feedback-history';

export interface PlayableAIFeedbackProps {
  courseId?: number | string;
  courseName: string;
  userId?: number | string;
  /** Matches ActivityFeedbackItem.activity_type, e.g. spot_the_bug. */
  activityType: PlayableType;
  activityLabel: string;
  score: number;
  total: number;
  /** Concrete per-question / per-pair detail used to ground the AI analysis. */
  sessionSummary: string;
}

interface AIFeedbackResult {
  strengths: string;
  weaknesses: string;
  improved: string;
  not_improved: string;
  action_plan: string[];
}

function normalizeResult(raw: Partial<AIFeedbackResult> | null | undefined): AIFeedbackResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const actionPlan = Array.isArray(raw.action_plan)
    ? raw.action_plan.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  const result: AIFeedbackResult = {
    strengths: typeof raw.strengths === 'string' ? raw.strengths.trim() : '',
    weaknesses: typeof raw.weaknesses === 'string' ? raw.weaknesses.trim() : '',
    improved: typeof raw.improved === 'string' ? raw.improved.trim() : '',
    not_improved: typeof raw.not_improved === 'string' ? raw.not_improved.trim() : '',
    action_plan: actionPlan.map((item) => item.trim()).slice(0, 5),
  };

  return result.strengths || result.weaknesses ? result : null;
}

function buildLocalFallback(score: number, total: number, hasHistory: boolean): AIFeedbackResult {
  const ratio = total > 0 ? score / total : 0;
  return {
    strengths:
      ratio >= 0.7
        ? `Bạn đạt ${score}/${total}, cho thấy phần lớn kiến thức trong lượt chơi này đã nắm khá chắc.`
        : `Bạn vẫn hoàn thành lượt chơi và có ${score}/${total} điểm; đây là dữ liệu tốt để biết phần nào cần ôn lại.`,
    weaknesses:
      ratio >= 0.7
        ? 'Một số chi tiết nhỏ vẫn có thể bị bỏ sót khi gặp câu hỏi biến thể hoặc tình huống áp dụng.'
        : 'Các nội dung bị sai cho thấy bạn còn nhầm lẫn ở một số khái niệm nền hoặc chưa đọc kỹ chi tiết trong tài liệu.',
    improved: hasHistory
      ? 'AI chưa thể so sánh chi tiết do phản hồi trước đó chưa đủ dữ liệu.'
      : 'Đây là lượt chơi đầu tiên nên chưa có mốc so sánh. Hãy chơi lại để theo dõi tiến bộ.',
    not_improved: hasHistory
      ? 'Hãy xem lại các câu sai bên dưới để xác định chủ đề còn yếu.'
      : 'Chưa có dữ liệu lần trước để xác định phần chưa tiến bộ.',
    action_plan: [
      'Đọc lại phần giải thích của từng câu/cặp làm sai trong màn tổng kết.',
      'Ghi lại 2–3 thuật ngữ hoặc quy tắc dễ nhầm nhất và tự giải thích bằng lời của mình.',
      'Chơi lại trò này vào ngày mai và so sánh điểm với lượt hiện tại.',
    ],
  };
}

export function PlayableAIFeedback({
  courseId,
  courseName,
  userId,
  activityType,
  activityLabel,
  score,
  total,
  sessionSummary,
}: PlayableAIFeedbackProps) {
  const signature = `${activityType}|${score}|${total}|${sessionSummary}`;
  // Khôi phục nhận xét đã lưu cùng ván chơi hôm nay để F5 không phải gọi AI lại.
  const [initialFeedback] = useState<AIFeedbackResult | null>(() => {
    const stored = getTodayPlayableFeedback(userId, courseId, activityType);
    if (!stored || stored.score !== score || stored.total !== total) return null;
    return normalizeResult(stored);
  });
  const [requestedKey, setRequestedKey] = useState(initialFeedback ? signature : '');
  const [resultKey, setResultKey] = useState(initialFeedback ? signature : '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AIFeedbackResult | null>(initialFeedback);
  const persistedForRef = useRef('');

  const showInline = requestedKey === signature;
  const activeResult = resultKey === signature ? result : null;

  function loadHistory(): { text: string; hasHistory: boolean } {
    const uid = Number(userId);
    const cid = Number(courseId);
    if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(cid) || cid <= 0) {
      return { text: 'Chưa có dữ liệu lần chơi trước.', hasHistory: false };
    }

    const sameActivity = getTodayFeedbackHistory(uid, cid)
      .filter((item) => item.activity_type === activityType)
      .slice(-3);

    if (!sameActivity.length) {
      return { text: 'Chưa có dữ liệu lần chơi trước.', hasHistory: false };
    }

    return {
      hasHistory: true,
      text: sameActivity
        .map(
          (item, index) =>
            `Lần trước ${index + 1}: ${item.score_label || 'không rõ điểm'} — ${item.ai_feedback || 'không có nhận xét'}${
              item.improvement_plan ? ` | Kế hoạch: ${item.improvement_plan}` : ''
            }`
        )
        .join('\n'),
    };
  }

  async function runAnalysis() {
    if (loading || resultKey === signature) return;

    setRequestedKey(signature);
    setResultKey('');
    setResult(null);
    setLoading(true);
    setError(null);

    try {
      const history = loadHistory();
      const prompt = `Bạn là cố vấn học tập thích ứng cho sinh viên đại học.
Môn học: "${courseName}".
Hoạt động vừa hoàn thành: "${activityLabel}" (${activityType}).
Kết quả hiện tại: ${score}/${total}.

DỮ LIỆU CHI TIẾT CỦA VÁN CHƠI:
${sessionSummary.slice(0, 5000)}

LỊCH SỬ CÁC LẦN CHƠI TRƯỚC CÙNG LOẠI:
${history.text.slice(0, 2500)}

Hãy phân tích dựa trên đúng các khái niệm, câu hỏi và lựa chọn ở trên. Không nhận xét chung chung, không bịa thêm câu hỏi không có trong dữ liệu.
Yêu cầu nội dung:
1. "strengths": 1–2 câu nêu chính xác phần kiến thức/kỹ năng bạn làm tốt, có dẫn tên khái niệm hoặc câu cụ thể.
2. "weaknesses": 1–2 câu nêu chính xác phần còn sai hoặc dễ nhầm, có dẫn tên khái niệm hoặc câu cụ thể.
3. "improved": 1–2 câu so sánh với lần chơi trước nếu có dữ liệu; nêu rõ phần nào tiến bộ. Nếu chưa có dữ liệu, ghi rõ "Chưa có mốc so sánh".
4. "not_improved": 1–2 câu nêu phần nào chưa tiến bộ hoặc vẫn lặp lại lỗi cũ; nếu chưa có dữ liệu, ghi rõ.
5. "action_plan": mảng 2–4 hành động ôn tập cụ thể, có thể làm ngay, ưu tiên đúng các chủ đề còn yếu.

Trả về JSON duy nhất theo đúng cấu trúc:
{
  "strengths": "...",
  "weaknesses": "...",
  "improved": "...",
  "not_improved": "...",
  "action_plan": ["...", "..."]
}`;

      let parsed = normalizeResult(await askPuterJSONSafe<Partial<AIFeedbackResult>>(prompt));

      if (!parsed) {
        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [{ role: 'user', content: prompt }],
              mode: 'concise',
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              reply?: string;
              text?: string;
              message?: { content?: string };
            };
            const content = data.reply || data.text || data.message?.content || JSON.stringify(data);
            parsed = normalizeResult(parseAIJson<Partial<AIFeedbackResult>>(content));
          }
        } catch {
          // local fallback below
        }
      }

      const finalResult = parsed || buildLocalFallback(score, total, history.hasHistory);
      setResult(finalResult);
      setResultKey(signature);

      // Lưu chung với dữ liệu ván chơi trong ngày; key cũ của ngày trước sẽ bị dọn tự động.
      saveTodayPlayableFeedback(userId, courseId, activityType, {
        score,
        total,
        ...finalResult,
        created_at: new Date().toISOString(),
      });

      if (persistedForRef.current !== signature) {
        persistedForRef.current = signature;
        const uid = Number(userId);
        const cid = Number(courseId);
        if (Number.isFinite(uid) && uid > 0 && Number.isFinite(cid) && cid > 0) {
          void submitPlayableFeedback({
            userId: uid,
            courseId: cid,
            courseName,
            feedback: {
              id: `fb_${activityType}_${Date.now()}`,
              activity_type: activityType,
              score_label: `${score}/${total}`,
              ai_feedback: [
                `Điểm mạnh: ${finalResult.strengths}`,
                `Cần cải thiện: ${finalResult.weaknesses}`,
                `Tiến bộ: ${finalResult.improved}`,
                `Chưa tiến bộ: ${finalResult.not_improved}`,
              ].join('\n'),
              improvement_plan: finalResult.action_plan.join(' • '),
              created_at: new Date().toISOString(),
            },
          });
        }
      }
    } catch {
      setError('Không thể tạo nhận xét AI lúc này. Bạn vẫn có thể xem lại chi tiết các câu sai bên dưới.');
    } finally {
      setLoading(false);
    }
  }

  if (!showInline) {
    return (
      <div className="playable-ai-inline">
        <div className="playable-ai-cta">
          <button
            type="button"
            className="playable-btn primary"
            onClick={() => void runAnalysis()}
            disabled={loading}
          >
            <Sparkles size={15} />
            AI nhận xét &amp; gợi ý
          </button>
          <p className="playable-ai-cta-sub">
            Phân tích cụ thể ván này: điểm mạnh, điểm yếu, phần đã tiến bộ và việc cần làm tiếp theo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="playable-ai-inline playable-ai-card" aria-live="polite">
      <div className="playable-ai-head">
        <span className="playable-summary-icon">
          <Sparkles size={20} />
        </span>
        <div>
          <p className="playable-eyebrow">NHẬN XÉT AI</p>
          <h3>{activityLabel}</h3>
          <p className="playable-ai-sub">
            {courseName} · {score}/{total}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="playable-ai-loading">
          <LoaderCircle className="playable-spin" size={22} />
          Đang phân tích điểm mạnh, điểm yếu và tiến bộ của bạn…
        </div>
      ) : error ? (
        <div className="playable-ai-error">
          <AlertTriangle size={17} /> {error}
          <button type="button" className="playable-btn outline" onClick={() => void runAnalysis()}>
            Thử lại
          </button>
        </div>
      ) : activeResult ? (
        <div className="playable-ai-sections">
          <div className="playable-ai-section good">
            <div className="playable-ai-section-title">
              <CheckCircle2 size={16} /> Bạn làm tốt
            </div>
            <p>{activeResult.strengths || 'Chưa có nhận xét cụ thể.'}</p>
          </div>

          <div className="playable-ai-section bad">
            <div className="playable-ai-section-title">
              <AlertTriangle size={16} /> Cần cải thiện
            </div>
            <p>{activeResult.weaknesses || 'Chưa có nhận xét cụ thể.'}</p>
          </div>

          <div className="playable-ai-section improved">
            <div className="playable-ai-section-title">
              <TrendingUp size={16} /> Đã tiến bộ
            </div>
            <p>{activeResult.improved || 'Chưa có mốc so sánh.'}</p>
          </div>

          <div className="playable-ai-section not-improved">
            <div className="playable-ai-section-title">
              <TrendingDown size={16} /> Chưa tiến bộ
            </div>
            <p>{activeResult.not_improved || 'Chưa có dữ liệu để so sánh.'}</p>
          </div>

          <div className="playable-ai-section plan">
            <div className="playable-ai-section-title">
              <Target size={16} /> Việc cần làm tiếp theo
            </div>
            {activeResult.action_plan.length > 0 ? (
              <ol className="playable-ai-plan">
                {activeResult.action_plan.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            ) : (
              <p>Chưa có gợi ý cụ thể.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
