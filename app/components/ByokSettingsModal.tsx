'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Key,
  Shield,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Trash2,
  Eye,
  EyeOff,
  RefreshCw,
  X,
  Cpu,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { UserKeySummary } from '@/lib/key-manager';

interface ByokSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId?: number | null;
}

type ProviderTab = 'gemini' | 'groq' | 'openrouter';

const PROVIDER_INFO: Record<
  ProviderTab,
  {
    name: string;
    models: string[];
    docUrl: string;
    placeholder: string;
    icon: React.ReactNode;
  }
> = {
  gemini: {
    name: 'Google AI Studio',
    models: ['Gemini 3.8 Flash', 'Gemini 3.1 Pro', 'Gemini Embedding'],
    docUrl: 'https://aistudio.google.com/apikey',
    placeholder: 'AIzaSy...',
    icon: <Sparkles size={18} color="#60a5fa" />,
  },
  groq: {
    name: 'Groq Cloud',
    models: ['GPT-OSS 120B', 'Qwen 3.8 27B'],
    docUrl: 'https://console.groq.com/keys',
    placeholder: 'gsk_...',
    icon: <Zap size={18} color="#fb923c" />,
  },
  openrouter: {
    name: 'OpenRouter',
    models: ['Qwen 3.8 27B', 'Nemotron 3.5 Lightning', 'Gemma 4 31B', 'LFM 2.5'],
    docUrl: 'https://openrouter.ai/keys',
    placeholder: 'sk-or-v1-...',
    icon: <Cpu size={18} color="#ff9dce" />,
  },
};

export function ByokSettingsModal({ isOpen, onClose, userId }: ByokSettingsModalProps) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<ProviderTab>('gemini');
  const [summary, setSummary] = useState<UserKeySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form input state
  const [inputKey, setInputKey] = useState('');
  const [inputName, setInputName] = useState('');
  const [showPlainKey, setShowPlainKey] = useState(false);
  const [validateKey, setValidateKey] = useState(true);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Resolved user ID (from prop or localStorage)
  const getEffectiveUserId = useCallback((): number | null => {
    if (typeof userId === 'number' && userId > 0) return userId;
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('moodleUser');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed.id === 'number') return parsed.id;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }, [userId]);

  const loadSummary = useCallback(async () => {
    const uid = getEffectiveUserId();
    if (!uid) return;

    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/user/keys?userId=${uid}`);
      const data = (await res.json()) as any;
      if (res.ok && data.success) {
        setSummary(data as UserKeySummary);
      } else {
        setErrorMsg(data.error || 'Không thể tải cấu hình API Key.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Lỗi kết nối máy chủ.');
    } finally {
      setLoading(false);
    }
  }, [getEffectiveUserId]);

  useEffect(() => {
    if (isOpen) {
      void loadSummary();
      setInputKey('');
      setInputName('');
      setErrorMsg(null);
      setSuccessMsg(null);
    }
  }, [isOpen, loadSummary]);

  // Handle ESC key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !mounted) return null;

  const effectiveUserId = getEffectiveUserId();
  const providerKeys = (summary?.keys || []).filter((k) => k.provider === activeTab);
  const hasActiveUserKey = providerKeys.length > 0;
  const currentProviderInfo = PROVIDER_INFO[activeTab];

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveUserId) {
      setErrorMsg('Vui lòng đăng nhập để lưu API Key.');
      return;
    }
    if (!inputKey.trim()) {
      setErrorMsg('Vui lòng nhập API Key.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/user/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: effectiveUserId,
          provider: activeTab,
          apiKey: inputKey.trim(),
          keyName: inputName.trim() || undefined,
          validate: validateKey,
        }),
      });

      const data = (await res.json()) as any;
      if (res.ok && data.success) {
        setSuccessMsg('Đã lưu và kích hoạt key.');
        setInputKey('');
        setInputName('');
        await loadSummary();
      } else {
        setErrorMsg(data.error || 'Lưu khóa thất bại.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Lỗi kết nối khi gửi yêu cầu.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (keyId: string) => {
    if (!effectiveUserId) return;
    if (!window.confirm('Xóa API Key này?')) {
      return;
    }

    setDeletingId(keyId);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/user/keys?keyId=${keyId}&userId=${effectiveUserId}`, {
        method: 'DELETE',
      });
      const data = (await res.json()) as any;
      if (res.ok && data.success) {
        setSuccessMsg('Đã xóa key. Đang dùng key dự phòng.');
        await loadSummary();
      } else {
        setErrorMsg(data.error || 'Không thể xóa API Key.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Lỗi kết nối máy chủ.');
    } finally {
      setDeletingId(null);
    }
  };

  return createPortal(
    <div
      className="byok-modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        animation: 'fadeIn 0.2s ease',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="byok-modal-container"
        style={{
          background: 'linear-gradient(155deg, #26101f 0%, #10070e 100%)',
          border: '1px solid rgba(255, 102, 178, 0.34)',
          borderRadius: '20px',
          width: '100%',
          maxWidth: '660px',
          maxHeight: 'min(92vh, 880px)',
          minHeight: 'min(74vh, 640px)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 65px -15px rgba(0, 0, 0, 0.9), 0 0 40px rgba(246, 83, 168, 0.22)',
          overflow: 'hidden',
          color: '#f8fafc',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header - Stays strictly at the top of the modal */}
        <div
          style={{
            padding: '1.1rem 1.4rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(246, 83, 168, 0.09)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #ff5cae 0%, #db3f8a 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(246, 83, 168, 0.45)',
                flexShrink: 0,
              }}
            >
              <Key size={20} color="#ffffff" />
            </div>
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: '17px',
                  fontWeight: 700,
                  letterSpacing: '-0.2px',
                  color: '#f8fafc',
                }}
              >
                API Key cá nhân (BYOK)
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#94a3b8' }}>
                Key riêng được ưu tiên khi gọi AI.
              </p>
            </div>
          </div>

          {/* Close button with high visibility */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cửa sổ"
            style={{
              background: 'rgba(255, 255, 255, 0.07)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              borderRadius: '10px',
              width: '36px',
              height: '36px',
              color: '#e2e8f0',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.2)';
              e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.4)';
              e.currentTarget.style.color = '#fca5a5';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.07)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.14)';
              e.currentTarget.style.color = '#e2e8f0';
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div
          style={{
            padding: '1.25rem 1.4rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            flex: '1 1 auto',
            minHeight: 0,
          }}
        >
          {/* Alerts */}
          {errorMsg && (
            <div
              style={{
                padding: '10px 14px',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                borderRadius: '10px',
                color: '#fca5a5',
                fontSize: '12.5px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div
              style={{
                padding: '10px 14px',
                backgroundColor: 'rgba(34, 197, 94, 0.15)',
                border: '1px solid rgba(34, 197, 94, 0.35)',
                borderRadius: '10px',
                color: '#86efac',
                fontSize: '12.5px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Compact security note */}
          <div
            style={{
              padding: '9px 12px',
              background: 'linear-gradient(135deg, rgba(246, 83, 168, 0.14), rgba(255, 154, 202, 0.06))',
              border: '1px solid rgba(246, 83, 168, 0.3)',
              borderRadius: '10px',
              fontSize: '11.5px',
              color: '#cbd5e1',
              lineHeight: 1.45,
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
            }}
          >
            <Shield size={15} color="#ff9dce" style={{ flexShrink: 0 }} />
            <span>
              Key được ưu tiên và mã hóa AES-256-GCM.
            </span>
          </div>

          {/* 3 Provider Tabs */}
          <div>
            <div
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: '#94a3b8',
                textTransform: 'uppercase',
                letterSpacing: '0.6px',
                marginBottom: '8px',
              }}
            >
              Chọn nhà cung cấp:
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '8px',
              }}
            >
              {(['gemini', 'groq', 'openrouter'] as ProviderTab[]).map((tab) => {
                const info = PROVIDER_INFO[tab];
                const isSelected = activeTab === tab;
                const keyCount =
                  tab === 'gemini'
                    ? summary?.geminiKeyCount ?? 0
                    : tab === 'groq'
                    ? summary?.groqKeyCount ?? 0
                    : summary?.openRouterKeyCount ?? 0;

                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      setActiveTab(tab);
                      setErrorMsg(null);
                      setSuccessMsg(null);
                    }}
                    style={{
                      padding: '11px 12px',
                      borderRadius: '12px',
                      border: isSelected
                        ? '1.5px solid #ff5cae'
                        : '1px solid rgba(255, 255, 255, 0.08)',
                      background: isSelected
                        ? 'linear-gradient(135deg, rgba(246, 83, 168, 0.24), rgba(205, 55, 128, 0.12))'
                        : 'rgba(255, 255, 255, 0.03)',
                      boxShadow: isSelected ? '0 4px 14px rgba(246, 83, 168, 0.25)' : 'none',
                      color: isSelected ? '#ffffff' : '#94a3b8',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '6px',
                      transition: 'all 0.15s ease',
                      textAlign: 'left',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                      }}
                    >
                      {info.icon}
                      <span
                        style={{
                          fontSize: '9.5px',
                          fontWeight: keyCount > 0 ? 700 : 600,
                          backgroundColor:
                            keyCount > 0 ? 'rgba(34, 197, 94, 0.2)' : 'rgba(148, 163, 184, 0.15)',
                          color: keyCount > 0 ? '#4ade80' : '#94a3b8',
                          padding: '2px 6px',
                          borderRadius: '999px',
                          border: keyCount > 0 ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid transparent',
                        }}
                      >
                        {keyCount}
                      </span>
                    </div>
                    <strong style={{ fontSize: '12.5px', color: isSelected ? '#f8fafc' : '#cbd5e1' }}>
                      {info.name}
                    </strong>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Provider Models + API Key Link */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '12px',
              background: 'rgba(15, 14, 26, 0.6)',
              border: '1px solid rgba(246, 83, 168, 0.2)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#f1f5f9' }}>
                {currentProviderInfo.name}
              </span>
              <a
                href={currentProviderInfo.docUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: '11.5px',
                  color: '#60a5fa',
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  background: 'rgba(59, 130, 246, 0.12)',
                  border: '1px solid rgba(59, 130, 246, 0.25)',
                }}
              >
                <span>Lấy API Key</span>
                <ExternalLink size={11} />
              </a>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '9px' }}>
              {currentProviderInfo.models.map((model) => (
                <span
                  key={model}
                  style={{
                    fontSize: '11px',
                    color: '#cbd5e1',
                    padding: '3px 9px',
                    borderRadius: '999px',
                    background: 'rgba(246, 83, 168, 0.12)',
                    border: '1px solid rgba(246, 83, 168, 0.22)',
                  }}
                >
                  {model}
                </span>
              ))}
            </div>
          </div>

          {/* Active Keys List for Current Provider */}
          {hasActiveUserKey && (
            <div>
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#94a3b8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.6px',
                  marginBottom: '8px',
                }}
              >
                Khóa đang dùng ({providerKeys.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {providerKeys.map((k, index) => (
                  <div
                    key={k.id}
                    style={{
                      padding: '10px 14px',
                      background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.08), rgba(15, 23, 42, 0.6))',
                      border: '1px solid rgba(34, 197, 94, 0.3)',
                      borderRadius: '10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '10px',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 700,
                            color: '#4ade80',
                            backgroundColor: 'rgba(34, 197, 94, 0.15)',
                            padding: '1px 6px',
                            borderRadius: '4px',
                          }}
                        >
                          {index === 0 ? 'Đang ưu tiên' : 'Dự phòng'}
                        </span>
                        <strong style={{ fontSize: '13px', color: '#f1f5f9' }}>{k.keyName}</strong>
                      </div>
                      <div style={{ fontSize: '11.5px', color: '#94a3b8', fontFamily: 'monospace' }}>
                        Mã che mờ: {k.maskedKey}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDelete(k.id)}
                      disabled={deletingId === k.id}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: 'rgba(239, 68, 68, 0.12)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '8px',
                        color: '#f87171',
                        fontSize: '11.5px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.25)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.12)';
                      }}
                    >
                      {deletingId === k.id ? (
                        <RefreshCw size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                      <span>Xóa</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Form to Add Key */}
          <form
            onSubmit={handleSave}
            style={{
              padding: '14px 16px',
              background: 'rgba(15, 14, 26, 0.7)',
              border: '1px solid rgba(246, 83, 168, 0.26)',
              borderRadius: '14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div
              style={{
                fontSize: '12.5px',
                fontWeight: 700,
                color: '#f1f5f9',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Key size={14} color="#ff69b4" />
              <span>{hasActiveUserKey ? 'Thêm hoặc cập nhật khóa' : 'Nhập API Key mới'}</span>
            </div>

            {/* API Key field */}
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '11.5px',
                  color: '#94a3b8',
                  marginBottom: '5px',
                  fontWeight: 500,
                }}
              >
                API Key <span style={{ color: '#f87171' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPlainKey ? 'text' : 'password'}
                  value={inputKey}
                  onChange={(e) => setInputKey(e.target.value)}
                  placeholder={currentProviderInfo.placeholder}
                  required
                  style={{
                    width: '100%',
                    padding: '9px 38px 9px 12px',
                    backgroundColor: '#120a0f',
                    border: '1px solid rgba(246, 83, 168, 0.32)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '12.5px',
                    fontFamily: showPlainKey ? 'monospace' : 'inherit',
                    outline: 'none',
                    boxSizing: 'border-box',
                    transition: 'border-color 0.15s ease',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = '#ff5cae';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(246, 83, 168, 0.32)';
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPlainKey(!showPlainKey)}
                  style={{
                    position: 'absolute',
                    right: '8px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '4px',
                  }}
                  title={showPlainKey ? 'Ẩn khóa' : 'Hiện khóa'}
                >
                  {showPlainKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <div>
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '11.5px',
                    color: '#94a3b8',
                    marginBottom: '5px',
                    fontWeight: 500,
                  }}
                >
                  Tên gợi nhớ
                </label>
                <input
                  type="text"
                  value={inputName}
                  onChange={(e) => setInputName(e.target.value)}
                  placeholder="Ví dụ: Khóa học kỳ 2"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    backgroundColor: '#120a0f',
                    border: '1px solid rgba(246, 83, 168, 0.32)',
                    borderRadius: '8px',
                    color: '#f8fafc',
                    fontSize: '12.5px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

            </div>

            {/* Validate check toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                id="byok-validate-toggle"
                type="checkbox"
                checked={validateKey}
                onChange={(e) => setValidateKey(e.target.checked)}
                style={{ accentColor: '#f653a8', width: '14px', height: '14px', cursor: 'pointer' }}
              />
              <label
                htmlFor="byok-validate-toggle"
                style={{
                  fontSize: '12px',
                  color: '#cbd5e1',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                Kiểm tra key trước khi lưu
              </label>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  color: '#cbd5e1',
                  fontSize: '12.5px',
                  cursor: 'pointer',
                }}
              >
                Hủy bỏ
              </button>
              <button
                type="submit"
                disabled={saving || !inputKey.trim()}
                style={{
                  padding: '8px 20px',
                  background: 'linear-gradient(135deg, #ff5cae 0%, #db3f8a 100%)',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#ffffff',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  cursor: saving || !inputKey.trim() ? 'not-allowed' : 'pointer',
                  opacity: saving || !inputKey.trim() ? 0.6 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  boxShadow: '0 4px 14px rgba(246, 83, 168, 0.35)',
                }}
              >
                {saving ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" />
                    <span>Đang lưu...</span>
                  </>
                ) : (
                  <span>Lưu &amp; kích hoạt</span>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ByokSettingsModal;
