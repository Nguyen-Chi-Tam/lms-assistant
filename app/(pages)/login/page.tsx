'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { registerFcmToken } from '@/app/lib/notification-client';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await response.json()) as { error?: string; moodleToken?: string; user?: { id?: number; role?: string } };
      if (!response.ok || !data.moodleToken || !data.user) {
        throw new Error(data.error ?? 'Không thể đăng nhập.');
      }
      localStorage.setItem('moodleToken', data.moodleToken);
      localStorage.setItem('moodleUser', JSON.stringify(data.user));

      if (data.user.id && data.user.role !== 'teacher') {
        try {
          await registerFcmToken(data.user.id, true, data.user.role);
        } catch (fcmErr) {
          console.warn('FCM registration on login:', fcmErr);
        }
      }

      router.push('/home');
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Không thể đăng nhập.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand"><img src="/lms-assistant-icon.png" alt="" /><strong>LMS Assistant</strong></div>
        <p className="eyebrow">KHÔNG GIAN HỌC TẬP</p>
        <h1>{mode === 'login' ? 'Chào mừng trở lại' : 'Tạo tài khoản học tập'}</h1>
        <p className="auth-subtitle">{mode === 'login' ? 'Đăng nhập bằng tài khoản Moodle của bạn.' : 'Tài khoản học viên được tạo và quản lý trên Moodle.'}</p>
        <div className="auth-tabs" role="tablist" aria-label="Tài khoản">
          <button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError(''); }} role="tab" aria-selected={mode === 'login'}>Đăng nhập</button>
          <button className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError(''); }} role="tab" aria-selected={mode === 'signup'}>Đăng ký</button>
        </div>
        {mode === 'signup' ? (
          <div className="signup-note">
            <strong>Đăng ký trên Moodle</strong>
            <p>LMS Assistant dùng tài khoản Moodle để xác thực. Hãy đăng ký với quản trị viên hoặc dùng trang đăng ký của hệ thống Moodle, sau đó quay lại đây để đăng nhập.</p>
            <button onClick={() => setMode('login')}>Quay lại đăng nhập</button>
          </div>
        ) : (
          <form onSubmit={submit} className="auth-form">
            <label>Email hoặc tên đăng nhập<input type="text" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" inputMode="email" placeholder="student@example.com" required /></label>
            <label>Mật khẩu<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="auth-submit" type="submit" disabled={loading}>{loading ? 'Đang đăng nhập...' : 'Đăng nhập'}</button>
          </form>
        )}
        <p className="auth-footer">Kết nối bảo mật với Moodle</p>
      </section>
    </main>
  );
}