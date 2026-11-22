'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, LogIn, Sparkles, X, Zap } from 'lucide-react';
import { dismissPuterPromptToday, signInPuter } from '@/app/lib/puter-client';

interface PuterSignInPromptModalProps {
  open: boolean;
  userId?: number | string;
  onSignedIn: () => void;
  onContinueWithoutPuter: () => void;
}

export function PuterSignInPromptModal({
  open,
  userId,
  onSignedIn,
  onContinueWithoutPuter,
}: PuterSignInPromptModalProps) {
  const [signingIn, setSigningIn] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !signingIn) {
        dismissPuterPromptToday(userId);
        onContinueWithoutPuter();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, signingIn, userId, onContinueWithoutPuter]);

  if (!open) return null;

  const handleSignIn = async () => {
    if (signingIn) return;
    setSigningIn(true);
    setErrorMsg(null);
    try {
      const ok = await signInPuter();
      if (ok) {
        onSignedIn();
      } else {
        setErrorMsg('Chưa hoàn tất đăng nhập Puter. Bạn có thể thử lại hoặc tiếp tục không dùng Puter.');
      }
    } catch {
      setErrorMsg('Không thể mở cửa sổ đăng nhập Puter lúc này. Bạn vẫn có thể tiếp tục học bình thường.');
    } finally {
      setSigningIn(false);
    }
  };

  const handleDismiss = () => {
    if (signingIn) return;
    dismissPuterPromptToday(userId);
    onContinueWithoutPuter();
  };

  return (
    <div className="quick-test-overlay" onClick={handleDismiss}>
      <section
        className="quick-test-card puter-prompt-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="puter-prompt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="quick-test-close"
          onClick={handleDismiss}
          disabled={signingIn}
          aria-label="Đóng gợi ý đăng nhập Puter"
        >
          <X size={16} />
        </button>

        <div className="quick-test-header">
          <span className="quick-test-icon">
            <Sparkles size={20} />
          </span>
          <div>
            <p className="eyebrow">KẾT NỐI PUTER.JS</p>
            <h2 id="puter-prompt-title">Đăng nhập Puter để tối ưu Không gian học tập</h2>
            <p>Gợi ý hàng ngày · Có thể tiếp tục ngay mà không cần tài khoản Puter</p>
          </div>
        </div>

        <p className="puter-prompt-desc">
          Puter.js hỗ trợ xử lý các tác vụ AI nặng trực tiếp trên trình duyệt giúp tạo trò chơi ôn tập
          nhanh và ổn định hơn. Bạn có thể đăng nhập tài khoản Puter miễn phí hoặc bỏ qua để dùng hệ thống mặc định.
        </p>

        <ul className="puter-prompt-benefits">
          <li>
            <Zap size={15} />
            <span>Sinh nhanh dữ liệu cho 6 trò chơi ôn tập (Đoán thuật ngữ, Nối cặp, Ô chữ, Bingo…)</span>
          </li>
          <li>
            <CheckCircle2 size={15} />
            <span>Mở khóa check-in 3 câu hỏi đầu buổi và giảm tải hạn mức máy chủ</span>
          </li>
        </ul>

        {errorMsg && <p className="puter-prompt-error">{errorMsg}</p>}

        <div className="puter-prompt-actions">
          <button
            type="button"
            className="puter-prompt-primary"
            onClick={() => void handleSignIn()}
            disabled={signingIn}
          >
            {signingIn ? (
              <>
                <LoaderCircle size={15} className="quick-test-spin" />
                <span>Đang mở đăng nhập Puter…</span>
              </>
            ) : (
              <>
                <LogIn size={15} />
                <span>Đăng nhập Puter</span>
              </>
            )}
          </button>

          <button
            type="button"
            className="puter-prompt-secondary"
            onClick={handleDismiss}
            disabled={signingIn}
          >
            <span>Tiếp tục không dùng Puter</span>
            <ArrowRight size={14} />
          </button>
        </div>

        <p className="puter-prompt-footnote">
          Chúng tôi chỉ nhắc lại 1 lần mỗi ngày nếu bạn chưa đăng nhập Puter.
        </p>
      </section>
    </div>
  );
}
