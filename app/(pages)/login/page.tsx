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
  const [stepMessage, setStepMessage] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    setStepMessage('Đang xác thực thông tin tài khoản...');

    // Clear any previous session / cached data to prevent cross-account contamination
    try {
      localStorage.removeItem('moodleToken');
      localStorage.removeItem('moodleUser');
      localStorage.removeItem('moodleData');
      localStorage.removeItem('moodleDataSyncedAt');
    } catch {}

    try {
      // Step 1: Authenticate against Moodle
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await response.json()) as {
        error?: string;
        moodleToken?: string;
        user?: { id?: number; fullname?: string; username?: string; avatarUrl?: string };
      };
      if (!response.ok || !data.moodleToken || !data.user) {
        throw new Error(data.error ?? 'Không thể đăng nhập.');
      }

      const token = data.moodleToken;
      const user = data.user;

      localStorage.setItem('moodleToken', token);
      localStorage.setItem('moodleUser', JSON.stringify(user));

      // Step 2: Sync Moodle data during login
      setStepMessage('Đang đồng bộ dữ liệu Moodle...');

      try {
        const syncRes = await fetch('/api/moodle?force=true', {
          headers: {
            Authorization: `Bearer ${token}`,
            'x-force-sync': 'true',
          },
          cache: 'no-store',
        });

        if (syncRes.ok) {
          const moodleData = (await syncRes.json()) as any;
          localStorage.setItem('moodleData', JSON.stringify(moodleData));
          localStorage.setItem('moodleDataSyncedAt', String(Date.now()));

          if (moodleData?.user) {
            localStorage.setItem(
              'moodleUser',
              JSON.stringify({
                ...user,
                ...moodleData.user,
              })
            );
          }
        }
      } catch (syncErr) {
        console.warn('Moodle sync during login warning:', syncErr);
      }

      // Step 3: Register Web Push token for this student device.
      if (user.id) {
        try {
          await registerFcmToken(user.id, true);
        } catch (fcmErr) {
          console.warn('FCM registration on login:', fcmErr);
        }
      }

      // Step 3: Lastly enter the home page
      setStepMessage('Đăng nhập thành công! Đang chuyển hướng...');
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
        <h1>{mode === 'login' ? 'Đăng nhập' : 'Đăng ký tài khoản'}</h1>
        <p className="auth-subtitle">{mode === 'login' ? 'Sử dụng tài khoản Moodle của bạn để tiếp tục.' : 'Tài khoản được cấp và quản lý trên hệ thống Moodle.'}</p>
        <div className="auth-tabs" role="tablist" aria-label="Tài khoản">
          <button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError(''); }} role="tab" aria-selected={mode === 'login'}>Đăng nhập</button>
          <button className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError(''); }} role="tab" aria-selected={mode === 'signup'}>Đăng ký</button>
        </div>
        {mode === 'signup' ? (
          <div className="signup-note">
            <strong>Đăng ký qua Moodle</strong>
            <p>Vui lòng tạo tài khoản trên hệ thống Moodle của trường, sau đó quay lại đây để đăng nhập.</p>
            <button onClick={() => setMode('login')}>Quay lại đăng nhập</button>
          </div>
        ) : (
          <form onSubmit={submit} className="auth-form">
            <label>Tên đăng nhập hoặc email<input type="text" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" inputMode="email" placeholder="student@example.com" required /></label>
            <label>Mật khẩu<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? (stepMessage || 'Đang đăng nhập...') : 'Đăng nhập'}
            </button>
            {loading && stepMessage && (
              <p style={{ marginTop: '8px', fontSize: '12px', color: '#f0a3b2', textAlign: 'center' }}>
                {stepMessage}
              </p>
            )}
          </form>
        )}
        <p className="auth-footer">Kết nối đồng bộ với Moodle</p>
      </section>
    </main>
  );
}