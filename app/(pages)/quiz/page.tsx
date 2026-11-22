'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { QuickTrainup } from '@/app/components/learning/QuickTrainup';

export default function QuizPage() {
  const router = useRouter();
  const [toast, setToast] = useState('');

  return (
    <main className="app-shell">
      <header className="quiz-topbar">
        <div className="quiz-topbar-left">
          <button
            type="button"
            onClick={() => router.push('/home')}
            aria-label="Về trang chủ"
          >
            <ArrowLeft size={18} />
            <span>Về trang chủ</span>
          </button>
        </div>
        <div className="quiz-topbar-center">
          <span className="quiz-eyebrow">TỰ LUYỆN</span>
          <h1 className="quiz-title">Luyện tập trắc nghiệm</h1>
          <p className="quiz-sub">Bài quiz ngắn do AI tạo từ tài liệu học tập của bạn.</p>
        </div>
        <div className="quiz-topbar-right">
          {toast && (
            <span className="quiz-toast">{toast}</span>
          )}
        </div>
      </header>

      <section className="content">
        <QuickTrainup
          notify={(text: string) => {
            setToast(text);
            window.setTimeout(() => setToast(''), 2600);
          }}
        />
      </section>
    </main>
  );
}
