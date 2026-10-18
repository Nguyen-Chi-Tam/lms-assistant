'use client';

import React, { Component, type ReactNode } from 'react';
import { AlertCircle, RotateCcw, Home } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackMessage?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled client error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  render() {
    if (this.state.hasError) {
      const title = this.props.fallbackTitle || 'Không thể hiển thị nội dung này';
      const message =
        this.props.fallbackMessage ||
        'Đã xảy ra sự cố khi tải dữ liệu. Khóa học có thể đang bị giới hạn quyền truy cập trên Moodle hoặc đường truyền mạng không ổn định.';

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '280px',
            padding: '2.5rem 1.5rem',
            margin: '1rem',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, rgba(30, 27, 46, 0.85), rgba(20, 18, 32, 0.95))',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
            color: '#f3f2f8',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '1rem',
              color: '#ef4444',
            }}
          >
            <AlertCircle size={28} />
          </div>

          <h3
            style={{
              fontSize: '1.2rem',
              fontWeight: 700,
              margin: '0 0 0.5rem 0',
              color: '#fff',
            }}
          >
            {title}
          </h3>

          <p
            style={{
              fontSize: '0.92rem',
              color: '#a1a0b5',
              maxWidth: '520px',
              margin: '0 0 1.5rem 0',
              lineHeight: 1.5,
            }}
          >
            {message}
          </p>

          {this.state.error?.message && (
            <div
              style={{
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                background: 'rgba(0, 0, 0, 0.3)',
                padding: '0.5rem 0.85rem',
                borderRadius: '8px',
                color: '#fca5a5',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                marginBottom: '1.5rem',
                maxWidth: '600px',
                wordBreak: 'break-word',
              }}
            >
              {this.state.error.message}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              onClick={this.handleReset}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0.55rem 1.1rem',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #7c6df2, #5a49d7)',
                color: '#fff',
                fontSize: '0.88rem',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(124, 109, 242, 0.35)',
              }}
            >
              <RotateCcw size={15} />
              Thử tải lại
            </button>

            <button
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.location.href = '/home';
                }
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0.55rem 1.1rem',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#d1cfe2',
                fontSize: '0.88rem',
                fontWeight: 600,
                border: '1px solid rgba(255, 255, 255, 0.12)',
                cursor: 'pointer',
              }}
            >
              <Home size={15} />
              Về trang chủ
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

