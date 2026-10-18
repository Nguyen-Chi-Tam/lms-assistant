import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import { NotificationManager } from '@/app/components/NotificationManager';
import { AuraBackground } from '@/app/components/AuraBackground';
import { ErrorBoundary } from '@/app/components/ErrorBoundary';

const geist = Geist({ variable: '--font-geist-sans', subsets: ['latin', 'latin-ext'] });


export const metadata: Metadata = {
  title: 'LMS Assistant — Không gian học tập thông minh',
  description: 'Gia sư AI 1-1 và không gian học tập cá nhân đồng bộ với Moodle.',
  metadataBase: new URL(process.env.SITE_ORIGIN ?? 'http://localhost:3000'),
  openGraph: {
    title: 'LMS Assistant — Không gian học tập thông minh',
    description: 'Gia sư AI 1-1, quiz, mindmap và thư viện học tập đồng bộ Moodle.',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'LMS Assistant — Không gian học tập thông minh' }],
    type: 'website',
    locale: 'vi_VN',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'LMS Assistant — Không gian học tập thông minh',
    description: 'Gia sư AI 1-1, quiz, mindmap và thư viện học tập đồng bộ Moodle.',
    images: ['/lms-assistant-icon.png'],
  },
  icons: {
    icon: '/lms-assistant-icon.png',
    shortcut: '/lms-assistant-icon.png',
    apple: '/lms-assistant-icon.png',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" className="dark">
      <body className={geist.variable}>
        <NotificationManager />
        <AuraBackground>
          <ErrorBoundary fallbackTitle="Không thể tải giao diện">
            {children}
          </ErrorBoundary>
        </AuraBackground>
      </body>

    </html>
  );
}
