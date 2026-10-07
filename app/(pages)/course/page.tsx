'use client';

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  MessageSquare,
  FileText,
  GitFork,
  Layers,
  HelpCircle,
  Zap,
  BookOpen,
  ListChecks,
  Copy,
  Check,
  Trash2,
  Square,
  Send,
  Plus,
  Play,
  Search,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Folder,
  BarChart3,
  BookmarkPlus,
  GraduationCap,
  Sparkles,
  Lock,
  Globe,
  Printer,
  FileDown,
  RotateCcw,
  Sliders,
  CheckCircle2,
  X,
  User,
  ShieldCheck,
  Award,
  Calendar,
  CalendarDays,
  CalendarCheck,
  Clock,
  AlertCircle,
  CheckSquare,
  ListTodo,
  Flame,
  UploadCloud,
  Layout,
  Pencil,
  Bell,
} from 'lucide-react';
import {
  baseCourses,
  getCourseSources,
  inspirationalQuotes,
  nav,
} from '@/app/mock-data';
import type {
  ChatMessage,
  CitationSource,
  Course,
  CourseSourceItem,
  ErrorResponse,
  ExamResult,
  MoodleData,
  MoodleResource,
  MoodleUser,
  QuizAnalysisData,
  RagMode,
  StudyToolResponse,
  TutorResponse,
} from '@/app/types';
import { MarkdownRenderer } from '@/app/components/MarkdownRenderer';
import { InteractiveMindmap } from '@/app/components/InteractiveMindmap';
import { QuizComponent } from '@/app/components/QuizComponent';
import { QuizAnalysisModal } from '@/app/components/QuizAnalysisModal';
import { CourseHeader } from '@/app/components/CourseHeader';
import { CourseTopBar } from '@/app/components/CourseTopBar';
import { CourseSwitcher } from '@/app/components/CourseSwitcher';
import {
  getStoredAnalysis,
  saveStoredAnalysis,
  getAllStoredAttemptIds,
  removeStoredAnalysis,
} from '@/app/lib/quiz-client-cache';
import {
  resolveGradeRoute,
  buildGradePrompt,
  formatGrade,
  GRADE_RESPONSE_STRATEGIES,
  type GradeResponseStrategy,
} from '@/app/lib/grade-router';
import { SlidePresentation } from '@/app/components/SlidePresentation';
import type { SlideDeckData } from '@/lib/pptx-export';
import { TeacherPortal } from '@/app/components/teacher/TeacherPortal';
import { exportSummaryToDocx, copyRichHtmlForWord, exportChatMessageToDocx } from '@/lib/export-utils';
import { cleanSummaryData } from '@/lib/summary-cleaner';
import { getDeviceId } from '@/app/lib/device-id';
import { registerFcmToken, unregisterFcmToken } from '@/app/lib/notification-client';

const MOODLE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/* ── Flashcards Component ────────────────────────────────── */

function Flashcards({
  initial,
  courseTitle,
  notify,
}: {
  initial: Array<{ front: string; back: string }>;
  courseTitle: string;
  notify: (s: string) => void;
}) {
  const [cards, setCards] = useState(initial);
  const [i, setI] = useState(0);
  const [flip, setFlip] = useState(false);

  const add = () => {
    const front = window.prompt('Nhập nội dung mặt trước của thẻ:');
    if (!front) return;
    const back = window.prompt('Nhập nội dung mặt sau của thẻ:');
    if (!back) return;
    setCards(v => [...v, { front, back }]);
    setI(cards.length);
    setFlip(false);
    notify('Đã thêm thẻ ghi nhớ mới');
  };

  return (
    <div className="artifact flash">
      <div className="artifact-head">
        <div>
          <h2>Bộ thẻ ghi nhớ: {courseTitle}</h2>
          <p>
            {cards.length > 0 ? `Thẻ ${i + 1} / ${cards.length}` : 'Chưa có thẻ nào'}
          </p>
        </div>
        <button onClick={add} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <Plus size={14} />
          Thêm thẻ
        </button>
      </div>

      {cards.length > 0 ? (
        <div
          role="button"
          tabIndex={0}
          className={`flash-card ${flip ? 'flipped' : ''}`}
          onClick={() => setFlip(!flip)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setFlip(!flip);
            }
          }}
        >
          <div className="flash-side-badge">
            <span className="flash-side-dot" />
            <span>{flip ? 'GIẢI THÍCH / ĐÁP ÁN' : 'KHÁI NIỆM / CÂU HỎI'}</span>
          </div>
          <div className="flash-card-content">
            <MarkdownRenderer content={flip ? (cards[i]?.back || '') : (cards[i]?.front || '')} />
          </div>
          <div className="flash-card-footer">
            <span>{flip ? 'Nhấn để xem câu hỏi' : 'Nhấn để lật xem đáp án'}</span>
          </div>
        </div>
      ) : (
        <div className="empty-state">Chưa có thẻ ghi nhớ nào. Nhấn "Thêm thẻ" để tạo mới.</div>
      )}

      {cards.length > 0 && (
        <div className="card-nav">
          <button
            onClick={() => {
              setI((i + cards.length - 1) % cards.length);
              setFlip(false);
            }}
            title="Thẻ trước đó"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ChevronLeft size={16} />
          </button>
          <div>
            {cards.map((_, x) => (
              <i className={x === i ? 'on' : ''} key={x} />
            ))}
          </div>
          <button
            onClick={() => {
              setI((i + 1) % cards.length);
              setFlip(false);
            }}
            title="Thẻ tiếp theo"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Study Artifact Component ────────────────────────────── */

interface GeneratedArtifact {
  id: string;
  name: string;
  data: unknown;
  originalData?: unknown;
  level: 'simple' | 'standard' | 'complex';
  topic: string;
  orientation?: 'horizontal' | 'vertical';
}

function StudyArtifact({
  type,
  artifact,
  courseTitle,
  loading,
  selectedSourcesCount,
  onGenerate,
  onReset,
  onOrientationChange,
  onUpdateData,
  onStop,
  copyText,
  notify,
}: {
  type: string;
  artifact: GeneratedArtifact | null;
  courseTitle: string;
  loading: boolean;
  selectedSourcesCount: number;
  onGenerate: (level: 'simple' | 'standard' | 'complex', topic: string, allowExternal: boolean, ragMode?: RagMode) => void;
  onReset: () => void;
  onOrientationChange?: (artifactId: string, orientation: 'horizontal' | 'vertical') => void;
  onUpdateData?: (artifactId: string, newData: unknown) => Promise<boolean>;
  onStop?: () => void;
  copyText: (s: string) => void;
  notify: (s: string) => void;
}) {
  const [selectedLevel, setSelectedLevel] = useState<'simple' | 'standard' | 'complex'>('standard');
  const [topicInput, setTopicInput] = useState('');
  const [selectedRagMode, setSelectedRagMode] = useState<RagMode>('hybrid');

  const toolIcon =
    type === 'Tóm tắt' ? (
      <FileText size={20} />
    ) : type === 'Mindmap' ? (
      <GitFork size={20} />
    ) : type === 'Slide' ? (
      <Layout size={20} />
    ) : (
      <Layers size={20} />
    );

  const toolName =
    type === 'Tóm tắt'
      ? 'Bản tóm tắt học thuật'
      : type === 'Mindmap'
      ? 'Sơ đồ tư duy (Mindmap)'
      : type === 'Slide'
      ? 'Slide bài giảng (PowerPoint)'
      : 'Bộ thẻ ghi nhớ (Flashcards)';

  if (loading) {
    return (
      <div
        className="artifact artifact-loading"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 'calc(100vh - 220px)',
          height: '100%',
          width: '100%',
          boxSizing: 'border-box',
          padding: '2.5rem 1.5rem 1.5rem',
          position: 'relative',
        }}
      >
        {/* Top spacer to keep center content vertically balanced */}
        <div style={{ flex: '1 1 0%', minHeight: '30px' }} />

        {/* Center Loading Status */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.9rem',
            textAlign: 'center',
            maxWidth: '580px',
          }}
        >
          <span className="bot-avatar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Sparkles size={16} />
          </span>
          <h3 style={{ margin: 0, textAlign: 'center', fontSize: '14.5px', fontWeight: 500, color: '#f1f5f9', lineHeight: 1.5 }}>
            Đang phân tích tài liệu và khởi tạo {type.toLowerCase()} cấp độ {selectedLevel === 'simple' ? 'Cơ bản' : selectedLevel === 'complex' ? 'Chuyên sâu' : 'Tiêu chuẩn'}…
          </h3>
          <div className="typing">
            <i />
            <i />
            <i />
          </div>
        </div>

        {/* Bottom Stop Button Container */}
        <div
          style={{
            flex: '1 1 0%',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            width: '100%',
            paddingBottom: '1rem',
            minHeight: '80px',
            position: 'sticky',
            bottom: '1.25rem',
          }}
        >
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              style={{
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                color: '#fff',
                border: 'none',
                padding: '0.55rem 1.35rem',
                borderRadius: '10px',
                fontWeight: 600,
                fontSize: '13px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(239, 68, 68, 0.4)',
                transition: 'all 0.2s ease',
              }}
              title="Dừng khởi tạo học liệu"
            >
              <Square size={13} fill="currentColor" />
              <span>Dừng tạo {type.toLowerCase()}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // If artifact hasn't been generated yet or was reset, show configuration & confirmation panel
  if (!artifact) {
    return (
      <div className="tool-config-panel">
        <div className="tool-config-head">
          <div className="tool-icon-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{toolIcon}</div>
          <div>
            <h3>Khởi tạo {toolName}</h3>
            <p>Phân tích và tổng hợp dựa trên {selectedSourcesCount} nguồn tài liệu đã chọn của môn {courseTitle}.</p>
          </div>
        </div>

        <div>
          <div className="tool-section-label">1. CHỌN MỨC ĐỘ CHI TIẾT</div>
          <div className="level-selector">
            <button
              type="button"
              className={`level-card ${selectedLevel === 'simple' ? 'active' : ''}`}
              onClick={() => setSelectedLevel('simple')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Zap size={14} />
                Cơ bản
              </strong>
              <small>3-4 luận điểm trọng tâm, tổng hợp nhanh trong 1-2 phút</small>
            </button>

            <button
              type="button"
              className={`level-card ${selectedLevel === 'standard' ? 'active' : ''}`}
              onClick={() => setSelectedLevel('standard')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <BookOpen size={14} />
                Tiêu chuẩn
              </strong>
              <small>Cấu trúc mạch lạc, 5-7 luận điểm cân đối, dễ tiếp thu</small>
            </button>

            <button
              type="button"
              className={`level-card ${selectedLevel === 'complex' ? 'active' : ''}`}
              onClick={() => setSelectedLevel('complex')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Sparkles size={14} />
                Chuyên sâu
              </strong>
              <small>Phân tích đa chiều, đào sâu nguyên lý, công thức và ví dụ thực tế</small>
            </button>
          </div>
        </div>

        <div>
          <div className="tool-section-label">2. CHỦ ĐỀ / PHẠM VI TRỌNG TÂM (TÙY CHỌN)</div>
          <input
            className="tool-topic-input"
            value={topicInput}
            onChange={e => setTopicInput(e.target.value)}
            placeholder={`Để trống để phân tích toàn bộ môn ${courseTitle}, hoặc nhập chuyên đề...`}
          />
        </div>

        <div>
          <div className="tool-section-label">3. PHẠM VI DỮ LIỆU THAM KHẢO</div>
          <div className="level-selector">
            <button
              type="button"
              className={`level-card ${selectedRagMode === 'strict' ? 'active' : ''}`}
              onClick={() => setSelectedRagMode('strict')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Lock size={14} style={{ color: selectedRagMode === 'strict' ? '#f87171' : undefined }} />
                Bám sát (Strict)
              </strong>
              <small>100% bám sát tài liệu đã chọn, không suy diễn ngoài giáo trình</small>
            </button>

            <button
              type="button"
              className={`level-card ${selectedRagMode === 'hybrid' ? 'active' : ''}`}
              onClick={() => setSelectedRagMode('hybrid')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Sparkles size={14} style={{ color: selectedRagMode === 'hybrid' ? '#10b981' : undefined }} />
                RAG Lai (Hybrid)
              </strong>
              <small>Ưu tiên giáo trình; tự động bù đắp tri thức chuyên ngành khi thiếu</small>
            </button>

            <button
              type="button"
              className={`level-card ${selectedRagMode === 'creative' ? 'active' : ''}`}
              onClick={() => setSelectedRagMode('creative')}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Globe size={14} style={{ color: selectedRagMode === 'creative' ? '#38bdf8' : undefined }} />
                Sáng tạo (Creative)
              </strong>
              <small>Tự do mở rộng thực tiễn ngành, xu hướng và tư duy đa chiều</small>
            </button>
          </div>
        </div>

        <button
          type="button"
          className="generate-tool-btn"
          onClick={() => onGenerate(selectedLevel, topicInput.trim() || courseTitle, selectedRagMode === 'creative', selectedRagMode)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
        >
          <Sparkles size={16} />
          Bắt đầu khởi tạo {type}
        </button>
      </div>
    );
  }

  const levelLabel =
    artifact.level === 'simple' ? 'Cơ bản' : artifact.level === 'complex' ? 'Chuyên sâu' : 'Tiêu chuẩn';

  if (type === 'Slide') {
    return (
      <SlidePresentation
        initialDeck={artifact.data as SlideDeckData}
        courseTitle={courseTitle}
        levelLabel={levelLabel}
        topic={artifact.topic}
        onReconfigure={onReset}
        notify={notify}
      />
    );
  }

  if (type === 'Mindmap') {
    const map = artifact.data as {
      root?: string;
      branches?: Array<any>;
      customLinks?: any[];
      orientation?: 'horizontal' | 'vertical';
    };
    const origData = (artifact.originalData || (artifact.data as any)?.originalData) as {
      root?: string;
      branches?: Array<any>;
      customLinks?: any[];
    } | undefined;
    const initialOrientation = artifact.orientation || map?.orientation || 'horizontal';
    return (
      <InteractiveMindmap
        key={artifact.id || `mindmap-${artifact.topic || 'default'}`}
        root={map?.root || courseTitle}
        branches={map?.branches || []}
        customLinks={map?.customLinks || []}
        originalData={origData}
        courseTitle={courseTitle}
        levelLabel={levelLabel}
        topic={artifact.topic}
        initialOrientation={initialOrientation}
        onOrientationChange={(newOrientation) => {
          if (onOrientationChange && artifact.id) {
            onOrientationChange(artifact.id, newOrientation);
          }
        }}
        onSaveData={async (newData) => {
          if (onUpdateData && artifact.id) {
            await onUpdateData(artifact.id, newData);
          }
        }}
        onReconfigure={onReset}
        notify={notify}
      />
    );
  }

  if (type === 'Flashcard') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="level-badge">{levelLabel}</span>
            <small style={{ color: '#94a3b8' }}>Chủ đề: {artifact.topic}</small>
          </div>
          <button
            className="reconfigure-btn"
            onClick={onReset}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <RotateCcw size={14} />
            Cấu hình lại
          </button>
        </div>
        <Flashcards
          initial={artifact.data as Array<{ front: string; back: string }>}
          courseTitle={courseTitle}
          notify={notify}
        />
      </div>
    );
  }

  // Summary
  const summary = cleanSummaryData(artifact.data as { title: string; overview: string; points: string[] });
  const text = `${summary.title}\n\n${summary.overview}\n\n${(summary.points ?? []).map(x => `• ${x}`).join('\n')}`;

  const handleExportDocx = async () => {
    try {
      notify('Đang xuất tài liệu Word (.docx)…');
      await exportSummaryToDocx(summary, courseTitle);
      notify('Đã tải tệp Word (.docx) thành công');
    } catch {
      notify('Không thể xuất tệp Word.');
    }
  };

  return (
    <div className="artifact summary">
      <div className="artifact-head">
        <div>
          <h2>{summary.title || `Tóm tắt: ${courseTitle}`}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <span className="level-badge">{levelLabel}</span>
            <small style={{ color: '#94a3b8' }}>Chủ đề: {artifact.topic}</small>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className="reconfigure-btn"
            onClick={onReset}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <RotateCcw size={14} />
            Cấu hình lại
          </button>
          <button
            className="reconfigure-btn"
            onClick={() => void copyText(text)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Copy size={14} />
            Sao chép
          </button>
          <button
            className="reconfigure-btn"
            style={{
              background: 'rgba(59, 130, 246, 0.25)',
              borderColor: '#3b82f6',
              color: '#ffffff',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
            onClick={() => void handleExportDocx()}
          >
            <FileDown size={14} />
            Xuất Word (.docx)
          </button>

        </div>
      </div>
      <h3>Tổng quan</h3>
      <p>{summary.overview}</p>
      <h3>Nội dung chính</h3>
      <ul>
        {(summary.points ?? []).map(p => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className="source-note" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <FileText size={14} />
        Tổng hợp dựa trên {selectedSourcesCount} tài liệu môn học. Vui lòng đối chiếu với giáo trình chính thức khi ôn tập.
      </div>
    </div>
  );
}

/* ── Source Validation & Badge Helper ─────────────────────── */

function isValidKnowledgeSource(type: string, name: string) {
  const t = (type || '').toLowerCase();
  const n = (name || '').toLowerCase();

  // Exclude Announcements / Forums / Quizzes / Assignments / Exams / Homework
  if (
    t.includes('forum') ||
    t.includes('assign') ||
    t.includes('quiz') ||
    t.includes('exam') ||
    t.includes('homework') ||
    t.includes('feedback') ||
    t.includes('survey') ||
    n.includes('announcement') ||
    n.includes('thông báo') ||
    n.includes('diễn đàn tin tức') ||
    n.includes('bài tập về nhà') ||
    n.includes('bài kiểm tra') ||
    n.includes('thi kết thúc')
  ) {
    return false;
  }

  // Allow PDF
  if (t === 'pdf' || n.endsWith('.pdf')) return true;

  // Allow Word (.doc, .docx)
  if (t.includes('doc') || t.includes('word') || n.endsWith('.docx') || n.endsWith('.doc')) return true;

  // Allow Web Link (http, https, url, link)
  if (t === 'url' || t === 'link' || n.startsWith('http://') || n.startsWith('https://') || n.includes('.link')) return true;

  // Allow PPT (.ppt, .pptx) / Text (.txt)
  if (t.includes('ppt') || n.endsWith('.pptx') || n.endsWith('.ppt') || t === 'txt' || n.endsWith('.txt')) return true;

  return false;
}

function isStudentSource(item: CourseSourceItem) {
  return Boolean(
    item.id?.startsWith('mat-') ||
    item.id?.startsWith('upload-') ||
    item.id?.startsWith('url-') ||
    item.id?.startsWith('note-') ||
    item.sizeOrPages?.includes('cá nhân') ||
    item.sizeOrPages?.includes('đã nạp') ||
    item.sizeOrPages?.includes('Ghi chú')
  );
}

function getSourceBadge(type: string, name: string): { label: React.ReactNode; className: string } {
  const upperType = (type || '').toUpperCase();
  const lowerName = name.toLowerCase();

  if (upperType === 'LINK' || upperType === 'URL' || lowerName.startsWith('http') || lowerName.includes('.link')) {
    return { label: <Globe size={14} />, className: 'link-badge' };
  }
  if (upperType === 'DOCX' || upperType === 'DOC' || lowerName.endsWith('.docx') || lowerName.endsWith('.doc')) {
    return { label: 'W', className: 'word-badge' };
  }
  if (upperType === 'PPTX' || upperType === 'PPT' || lowerName.endsWith('.pptx') || lowerName.endsWith('.ppt')) {
    return { label: 'P', className: 'ppt-badge' };
  }
  return { label: 'P', className: 'pdf-badge' };
}

/* ── Course Detail Inner Content ─────────────────────────── */

function CourseDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryId = searchParams.get('id');
  const queryCode = searchParams.get('code');
  const queryName = searchParams.get('name');
  const initialIntent = searchParams.get('intent') || searchParams.get('q') || '';
  // When draft=1 the intent is pre-filled but NOT auto-sent (user can edit model/prompt first)
  const draftMode = searchParams.get('draft') === '1';

  const [moodle, setMoodle] = useState<MoodleData | null>(null);
  const [user, setUser] = useState<MoodleUser | null>(null);
  const [toast, setToast] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [profile, setProfile] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if ('Notification' in window) setNotificationPermission(Notification.permission);
  }, []);

  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2600);
  };

  const handleLogout = async () => {
    try {
      await unregisterFcmToken(user?.id);
    } catch (e) {
      console.warn('FCM unregister error on logout:', e);
    }
    localStorage.removeItem('moodleToken');
    localStorage.removeItem('moodleUser');
    localStorage.removeItem('moodleData');
    router.push('/login');
  };

  useEffect(() => {
    if (user?.id && user?.role !== 'teacher') {
      void registerFcmToken(user.id, false, user.role);
    }
  }, [user?.id, user?.role]);

  // Sync Moodle data and read local caches
  const syncMoodleData = async (force = false) => {
    const cachedAt = Number(localStorage.getItem('moodleDataSyncedAt') || 0);
    if (!force && localStorage.getItem('moodleData') && Date.now() - cachedAt < MOODLE_CACHE_MAX_AGE_MS) return;
    setSyncing(true);
    try {
      const token = localStorage.getItem('moodleToken');
      const res = await fetch('/api/moodle', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = (await res.json()) as MoodleData & ErrorResponse;
      if (res.ok && data) {
        setMoodle(data);
        localStorage.setItem('moodleData', JSON.stringify(data));
        localStorage.setItem('moodleDataSyncedAt', String(Date.now()));
        if (data.user) {
          setUser(prev => {
            const avatarUrl =
              data.user!.avatarUrl ||
              (token ? `/api/moodle/avatar?token=${encodeURIComponent(token)}&id=${data.user!.id}` : prev?.avatarUrl);
            const updated: MoodleUser = {
              id: data.user!.id,
              fullname: data.user!.name || prev?.fullname || '',
              username: data.user!.username || prev?.username || '',
              avatarUrl,
            };
            localStorage.setItem('moodleUser', JSON.stringify(updated));
            return updated;
          });
        }
      }
    } catch {
      // offline or demo mode
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const storedUser = localStorage.getItem('moodleUser');
    const token = localStorage.getItem('moodleToken');
    if (storedUser) {
      try {
        const parsed = JSON.parse(storedUser) as MoodleUser;
        if (
          token &&
          (!parsed.avatarUrl ||
            parsed.avatarUrl.includes('/u/f1') ||
            parsed.avatarUrl.includes('/u/f2') ||
            !parsed.avatarUrl.startsWith('/api/moodle/avatar'))
        ) {
          parsed.avatarUrl = `/api/moodle/avatar?token=${encodeURIComponent(token)}&id=${parsed.id}`;
        }
        setUser(parsed);
      } catch {
        localStorage.removeItem('moodleUser');
      }
    }

    const storedMoodle = localStorage.getItem('moodleData');
    if (storedMoodle) {
      try {
        setMoodle(JSON.parse(storedMoodle) as MoodleData);
      } catch {
        localStorage.removeItem('moodleData');
        localStorage.removeItem('moodleDataSyncedAt');
      }
    }

    void syncMoodleData(false);
  }, []);

  // Compute all available courses (exclusively from Moodle live courses)
  const allCourses: Course[] = useMemo(() => {
    const coursesMap = new Map<string, Course>();
    const defaultColors = ['#6c5ce7', '#ff8a65', '#20bfa9', '#3b82f6', '#ec4899', '#f59e0b'];

    if (moodle?.courses?.length) {
      moodle.courses.forEach((mc, index) => {
        const isTeacher =
          mc.role === 'editingteacher' ||
          mc.role === 'teacher' ||
          mc.role === 'manager' ||
          mc.role === 'coursecreator' ||
          mc.role === 'admin' ||
          Boolean(mc.isTeacher);
        coursesMap.set(mc.shortname.toLowerCase(), {
          id: mc.id,
          code: mc.shortname,
          name: mc.fullname,
          progress: mc.progress ?? 0,
          color: defaultColors[index % defaultColors.length],
          icon: mc.shortname.slice(0, 2).toUpperCase(),
          next: isTeacher ? 'Quản lý khóa học & Giảng dạy' : 'Xem nội dung khóa học Moodle',
          role: isTeacher ? (mc.role || 'editingteacher') : 'student',
          isTeacher,
        });
      });
    }

    return Array.from(coursesMap.values());
  }, [moodle]);

  // Determine current active course
  const activeCourse: Course = useMemo(() => {
    // Match by ID
    if (queryId) {
      const found = allCourses.find(c => String(c.id) === String(queryId));
      if (found) return found;
    }

    // Match by Code
    if (queryCode) {
      const decodedCode = decodeURIComponent(queryCode).toLowerCase().trim();
      const found = allCourses.find(c => c.code.toLowerCase() === decodedCode);
      if (found) return found;
    }

    // Match by Name
    if (queryName) {
      const decodedName = decodeURIComponent(queryName).toLowerCase().trim();
      const found = allCourses.find(
        c =>
          c.name.toLowerCase() === decodedName ||
          c.name.toLowerCase().includes(decodedName) ||
          decodedName.includes(c.name.toLowerCase())
      );
      if (found) return found;
    }

    // If queryCode or queryName was specified but not in allCourses, construct it dynamically
    if (queryCode || queryName) {
      const codeStr = queryCode ? decodeURIComponent(queryCode) : 'COURSE';
      const nameStr = queryName ? decodeURIComponent(queryName) : codeStr;
      return {
        id: queryId ? Number(queryId) : 999,
        code: codeStr,
        name: nameStr,
        progress: 0,
        color: '#6c5ce7',
        icon: codeStr.slice(0, 2).toUpperCase(),
        next: 'Khóa học Moodle',
      };
    }

    return (
      allCourses[0] || {
        id: 0,
        code: '',
        name: 'Chưa chọn khóa học',
        progress: 0,
        color: '#6c5ce7',
        icon: 'LM',
        next: '',
      }
    );
  }, [queryId, queryCode, queryName, allCourses]);

  // Redirect to /home if no course was specified in the URL params (e.g. Back button or empty /course)
  useEffect(() => {
    if (!queryCode && !queryName && !queryId) {
      router.replace('/home');
    }
  }, [queryCode, queryName, queryId, router]);

  const isTeacherCourse = Boolean(activeCourse.isTeacher);

  const handleCourseChange = (target: Course) => {
    router.replace(
      `/course?code=${encodeURIComponent(target.code)}&name=${encodeURIComponent(target.name)}&id=${target.id ?? ''}`
    );
  };

  // Compute knowledge sources for the active course (from Moodle resources only)
  const courseSources: CourseSourceItem[] = useMemo(() => {
    const results: CourseSourceItem[] = [];

    // Extract matching resources from Moodle (Filtered: only Word, PDF, Web links)
    if (moodle?.resources?.length) {
      const moodleMatches = moodle.resources.filter(r => {
        // Exclude Announcements, Quizzes, Homework, Exams
        if (!isValidKnowledgeSource(r.type || '', r.name || r.module || '')) {
          return false;
        }

        const matchId = activeCourse.id && r.courseId && r.courseId === activeCourse.id;
        const matchCode =
          r.courseCode && r.courseCode.toLowerCase() === activeCourse.code.toLowerCase();
        const matchName =
          r.courseName &&
          (r.courseName.toLowerCase() === activeCourse.name.toLowerCase() ||
            r.courseName.toLowerCase().includes(activeCourse.name.toLowerCase()) ||
            activeCourse.name.toLowerCase().includes(r.courseName.toLowerCase()));
        return matchId || matchCode || matchName;
      });

      moodleMatches.forEach((mr, idx) => {
        const fileId = mr.fileId || mr.moduleId || (idx + 1);
        results.push({
          id: `moodle-${mr.courseId ?? activeCourse.id}-${fileId}`,
          name: mr.name || mr.module || 'Tài liệu Moodle',
          type: mr.type || 'FILE',
          sizeOrPages: mr.sectionName ? `Moodle · ${mr.sectionName}` : mr.module ? `Moodle · ${mr.module}` : 'Tài liệu Moodle',
          url: mr.url || undefined,
          courseCode: activeCourse.code,
          courseId: activeCourse.id ?? mr.courseId,
          moduleId: mr.moduleId,
          fileId,
          sectionId: mr.sectionId,
          sectionName: mr.sectionName,
          chapter: mr.sectionName || undefined,
          isStudentUpload: false,
        });
      });
    }

    return results;
  }, [moodle, activeCourse]);

  // Compute direct LMS URL for the active course
  const lmsCourseUrl = useMemo(() => {
    let baseUrl = moodle?.moodleUrl;
    if (!baseUrl && moodle?.resources?.length) {
      const resWithUrl = moodle.resources.find(
        r => r.url && (r.url.startsWith('http://') || r.url.startsWith('https://'))
      );
      if (resWithUrl?.url) {
        try {
          baseUrl = new URL(resWithUrl.url).origin;
        } catch {}
      }
    }
    const cleanBase = (baseUrl || 'http://moodle.test').replace(/\/$/, '');
    if (activeCourse.id) {
      return `${cleanBase}/course/view.php?id=${activeCourse.id}`;
    }
    return cleanBase;
  }, [moodle, activeCourse.id]);

  // Compute direct LMS URL for student profile
  const lmsProfileUrl = useMemo(() => {
    let baseUrl = moodle?.moodleUrl;
    if (!baseUrl && moodle?.resources?.length) {
      const resWithUrl = moodle.resources.find(
        r => r.url && (r.url.startsWith('http://') || r.url.startsWith('https://'))
      );
      if (resWithUrl?.url) {
        try {
          baseUrl = new URL(resWithUrl.url).origin;
        } catch {}
      }
    }
    const cleanBase = (baseUrl || 'https://moodletvk.duckdns.org').replace(/\/$/, '');
    if (user?.id) {
      return `${cleanBase}/user/profile.php?id=${user.id}`;
    }
    return `${cleanBase}/user/profile.php`;
  }, [moodle, user?.id]);

  const [sources, setSources] = useState<CourseSourceItem[]>(courseSources);
  const [checked, setChecked] = useState<boolean[]>(() => new Array(courseSources.length).fill(true));
  const [sourceQuery, setSourceQuery] = useState('');
  const sourceCourseKeyRef = useRef<string | null>(null);
  const sourceItemsRef = useRef<CourseSourceItem[]>(courseSources);

  // Sync sources whenever active course or Moodle data updates
  useEffect(() => {
    const courseKey = `${activeCourse.id ?? ''}:${activeCourse.code}`;
    const isSameCourse = sourceCourseKeyRef.current === courseKey;
    const personalSources = isSameCourse ? sourceItemsRef.current.filter(isStudentSource) : [];
    const nextSources = [...personalSources, ...courseSources];
    sourceItemsRef.current = nextSources;
    setSources(nextSources);
    setChecked(new Array(nextSources.length).fill(true));
    sourceCourseKeyRef.current = courseKey;
  }, [activeCourse.id, activeCourse.code, courseSources]);

  useEffect(() => {
    sourceItemsRef.current = sources;
  }, [sources]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([
    {
      role: 'ai',
      text: `Trợ lý Học tập AI môn ${activeCourse.name} đã sẵn sàng. Bạn có thể đặt câu hỏi hoặc yêu cầu phân tích, tóm tắt tài liệu.`,
      sources: [`${courseSources.length} tài liệu sẵn sàng`],
    },
  ]);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);

  // Reset chat and all study artifacts (mindmap, flashcard, summary, slide) when switching courses
  useEffect(() => {
    setChat([
      {
        role: 'ai',
        text: `Trợ lý Học tập AI môn ${activeCourse.name} đã sẵn sàng. Bạn có thể đặt câu hỏi hoặc yêu cầu phân tích, tóm tắt tài liệu.`,
        sources: [`${courseSources.length} tài liệu sẵn sàng`],
      },
    ]);
    setChatSessionId(null);
    setArtifactsMap({});
    if (!initialIntent || !draftMode) {
      setInput('');
    } else {
      setInput(initialIntent);
      setHideStrategyBar(false);
    }
  }, [activeCourse.id, activeCourse.code, activeCourse.name, courseSources.length]);

  const [input, setInput] = useState(
    initialIntent.startsWith('__') || initialIntent.startsWith('Tiếp tục học') ? '' : initialIntent
  );
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState(initialIntent === '__mindmap' ? 'Mindmap' : 'Chat');
  const [artifactsMap, setArtifactsMap] = useState<Record<string, GeneratedArtifact[]>>({});
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<Record<string, string>>({});
  const [showArtifactList, setShowArtifactList] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const artifactAbortRef = useRef<AbortController | null>(null);
  const artifactRequestIdRef = useRef<string | null>(null);
  const [ragMode, setRagMode] = useState<RagMode>('hybrid');
  const allowExternalSource = ragMode === 'creative';
  const [answerStyle, setAnswerStyle] = useState<'concise' | 'detailed'>('concise');
  const [isSourcePanelCollapsed, setIsSourcePanelCollapsed] = useState<boolean>(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [selectedModel, setSelectedModel] = useState<string>('auto');
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; provider: string; label: string; available?: boolean }>>([]);
  const [mounted, setMounted] = useState<boolean>(false);
  useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined') {
      if (window.innerWidth < 1100) {
        setIsSourcePanelCollapsed(true);
      }
    }
  }, []);

  // Fetch available AI models for Teachers to perform Healthcheck
  useEffect(() => {
    if (isTeacherCourse) {
      fetch('/api/models?all=true')
        .then(res => res.json())
        .then(data => {
          const mList = (data as any)?.models;
          if (mList && Array.isArray(mList)) {
            setAvailableModels(mList);
          }
        })
        .catch(err => console.warn('Failed to load available models for teacher:', err));
    }
  }, [isTeacherCourse]);
  const [showGradeHistory, setShowGradeHistory] = useState<boolean>(false);
  const [showActivityModal, setShowActivityModal] = useState<boolean>(false);
  const [teacherTab, setTeacherTab] = useState<'assistant' | 'grades' | 'quiz' | 'notifications'>('assistant');
  const askedIntent = useRef(false);

  // Student Document & Resource Upload Modal State
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);
  const [uploadTab, setUploadTab] = useState<'file' | 'url' | 'text'>('file');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFileTitle, setUploadFileTitle] = useState<string>('');
  const [uploadUrl, setUploadUrl] = useState<string>('');
  const [uploadUrlTitle, setUploadUrlTitle] = useState<string>('');
  const [uploadTextTitle, setUploadTextTitle] = useState<string>('');
  const [uploadTextContent, setUploadTextContent] = useState<string>('');
  const [uploadLoading, setUploadLoading] = useState<boolean>(false);
  const [uploadDragActive, setUploadDragActive] = useState<boolean>(false);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);

  // Hydrate course-specific persistent data (personal_materials, learning_artifacts, chat_sessions) from Database
  useEffect(() => {
    let isCancelled = false;
    const currentUserId = user?.id || 4;
    const currentCourseId = activeCourse.id;
    if (!currentCourseId) return;

    async function hydrateCourseData() {
      // 1. Fetch personal materials and merge into sources
      try {
        const matRes = await fetch(`/api/documents/process?moodleCourseId=${currentCourseId}&userId=${currentUserId}`);
        const matData = (await matRes.json()) as {
          materials?: Array<{ id: string | number; title: string; storage_url?: string; storageUrl?: string }>;
        };
        if (!isCancelled && matData?.materials && Array.isArray(matData.materials)) {
          const personalItems: CourseSourceItem[] = matData.materials.map(mat => {
            const rawUrl = mat.storage_url || mat.storageUrl || '';
            const ext = (mat.title || rawUrl).split('.').pop()?.toLowerCase() || '';
            let type: 'PDF' | 'DOCX' | 'PPTX' | 'TXT' | 'LINK' | 'FILE' = 'FILE';
            if (ext === 'pdf') type = 'PDF';
            else if (ext === 'docx' || ext === 'doc') type = 'DOCX';
            else if (ext === 'pptx' || ext === 'ppt') type = 'PPTX';
            else if (ext === 'txt') type = 'TXT';
            else if (rawUrl.startsWith('http')) type = 'LINK';

            return {
              id: `mat-${mat.id}`,
              name: mat.title,
              type,
              sizeOrPages: 'Tài liệu cá nhân',
              url: rawUrl || undefined,
              courseCode: activeCourse.code,
              courseId: currentCourseId,
              isStudentUpload: true,
            };
          });

          if (personalItems.length > 0) {
            setSources(prev => {
              const existingIds = new Set(prev.map(p => p.id || p.name));
              const newItems = personalItems.filter(p => !existingIds.has(p.id || p.name));
              if (newItems.length > 0) {
                setChecked(old => [...new Array(newItems.length).fill(true), ...old]);
                return [...newItems, ...prev];
              }
              return prev;
            });
          }
        }
      } catch (err) {
        console.warn('Failed to hydrate personal materials:', err);
      }

      // 2. Fetch learning artifacts (mindmap, flashcards, summary, slides)
      try {
        const artRes = await fetch(`/api/learning-artifacts?moodleCourseId=${currentCourseId}&userId=${currentUserId}`);
        const artData = (await artRes.json()) as {
          artifacts?: Array<{
            artifact_type?: string;
            artifactType?: string;
            content_data?: unknown;
            contentData?: unknown;
          }>;
        };
        if (!isCancelled && artData?.artifacts && Array.isArray(artData.artifacts)) {
          const hydratedMap: Record<string, GeneratedArtifact[]> = {};
          for (const a of artData.artifacts) {
            let toolKey: string | null = null;
            const aType = a.artifact_type || a.artifactType;
            if (aType === 'summary') toolKey = 'Tóm tắt';
            else if (aType === 'mindmap') toolKey = 'Mindmap';
            else if (aType === 'slides' || aType === 'slide' || aType === 'presentation') toolKey = 'Slide';
            else if (aType === 'flashcards' || aType === 'flashcard') toolKey = 'Flashcard';

            if (toolKey) {
              const cd = a.content_data || a.contentData;
              let artifactData = cd;
              let level: 'simple' | 'standard' | 'complex' = 'standard';
              let topic = activeCourse.name;
              let orientation: 'horizontal' | 'vertical' | undefined = undefined;
              if (cd && typeof cd === 'object') {
                if ('data' in cd) artifactData = (cd as Record<string, unknown>).data;
                if ('level' in cd && typeof (cd as Record<string, unknown>).level === 'string') {
                  level = (cd as { level: 'simple' | 'standard' | 'complex' }).level;
                }
                if ('topic' in cd && typeof (cd as Record<string, unknown>).topic === 'string') {
                  topic = (cd as { topic: string }).topic;
                }
                if ('orientation' in cd) {
                  const o = (cd as Record<string, unknown>).orientation;
                  if (o === 'horizontal' || o === 'vertical') orientation = o;
                }
              }
              if (!orientation && artifactData && typeof artifactData === 'object' && 'orientation' in artifactData) {
                const o = (artifactData as Record<string, unknown>).orientation;
                if (o === 'horizontal' || o === 'vertical') orientation = o;
              }
              const origData = (cd && typeof cd === 'object' && 'originalData' in cd)
                ? (cd as Record<string, unknown>).originalData
                : artifactData;
              const hydratedArtifact: GeneratedArtifact = {
                id: String((a as { id?: string | number }).id || `${toolKey}-${Date.now()}-${Math.random()}`),
                name: cd && typeof cd === 'object' && typeof (cd as Record<string, unknown>).name === 'string'
                  ? (cd as Record<string, unknown>).name as string
                  : topic,
                data: artifactData,
                originalData: origData,
                level,
                topic,
                orientation,
              };
              hydratedMap[toolKey] = [...(hydratedMap[toolKey] || []), hydratedArtifact];
            }
          }
          if (Object.keys(hydratedMap).length > 0) {
            setArtifactsMap(prev => ({ ...prev, ...hydratedMap }));
            setSelectedArtifactIds(prev => {
              const next = { ...prev };
              for (const [toolKey, items] of Object.entries(hydratedMap)) {
                if (items.length > 0 && !next[toolKey]) next[toolKey] = items[0].id;
              }
              return next;
            });
            setShowArtifactList(false);
          }
        }
      } catch (err) {
        console.warn('Failed to hydrate learning artifacts:', err);
      }

      // 3. Fetch latest chat session
      try {
        const chatRes = await fetch(`/api/chat-sessions?moodleCourseId=${currentCourseId}&userId=${currentUserId}`);
        const chatData = (await chatRes.json()) as {
          latest?: {
            id?: string;
            response_model?: string;
            messages?: ChatMessage[];
          };
        };
        if (
          !isCancelled &&
          chatData?.latest?.messages &&
          Array.isArray(chatData.latest.messages) &&
          chatData.latest.messages.length > 0
        ) {
          const loadedMessages = chatData.latest.messages.map(m => {
            if (m.role === 'ai' && !m.model && chatData.latest?.response_model) {
              return { ...m, model: chatData.latest.response_model };
            }
            return m;
          });
          setChat(loadedMessages as ChatMessage[]);
          if (chatData.latest.id) setChatSessionId(String(chatData.latest.id));
        }
      } catch (err) {
        console.warn('Failed to hydrate chat session:', err);
      }
    }

    void hydrateCourseData();

    return () => {
      isCancelled = true;
    };
  }, [activeCourse.id, user?.id, activeCourse.code, activeCourse.name]);

  // Compute exam results for current active course ONLY (excluding attendance)
  const courseExamResults = useMemo(() => {
    if (!moodle?.examResults?.length) return [];
    return moodle.examResults.filter(r => {
      const mod = (r.itemModule || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      if (
        mod === 'attendance' ||
        mod.includes('attendance') ||
        name.includes('attendance') ||
        name.includes('điểm danh')
      ) {
        return false;
      }
      return (
        (activeCourse.id && String(r.courseId) === String(activeCourse.id)) ||
        (activeCourse.code && r.courseCode?.toLowerCase() === activeCourse.code.toLowerCase()) ||
        (activeCourse.name && r.courseName?.toLowerCase() === activeCourse.name.toLowerCase())
      );
    });
  }, [moodle?.examResults, activeCourse.id, activeCourse.code, activeCourse.name]);

  // Compute course activities (Moodle deadlines & exams merged by base name)
  const courseActivities = useMemo(() => {
    type ActivityEntry = {
      id: string | number;
      name: string;
      courseName: string;
      openTimestamp?: number;
      closeTimestamp?: number;
      timestamp: number;
      url?: string;
      type: 'homework' | 'exam' | 'quiz' | 'task';
    };

    const groupedMap = new Map<string, ActivityEntry>();

    if (moodle?.deadlines?.length) {
      moodle.deadlines.forEach(d => {
        const matchesCourse =
          (activeCourse.name && (d.courseName?.toLowerCase().includes(activeCourse.name.toLowerCase()) || activeCourse.name.toLowerCase().includes(d.courseName?.toLowerCase()))) ||
          (activeCourse.code && (d.name?.toLowerCase().includes(activeCourse.code.toLowerCase()) || d.courseName?.toLowerCase().includes(activeCourse.code.toLowerCase())));

        if (matchesCourse) {
          const rawName = d.name.trim();
          let baseName = rawName;
          let eventKind: 'open' | 'close' | 'general' = 'general';

          // Detect "opens" or "mở" / "bắt đầu"
          const opensMatch = /(?:\s+opens|\s+mở|\s+bắt đầu)$/i.exec(rawName);
          if (opensMatch) {
            baseName = rawName.slice(0, opensMatch.index).trim();
            eventKind = 'open';
          } else {
            // Detect "closes", "is due", "due", "đóng", "hết hạn", "kết thúc"
            const closesMatch = /(?:\s+closes|\s+is due|\s+due|\s+đóng|\s+hết hạn|\s+kết thúc|\s+hạn chót)$/i.exec(rawName);
            if (closesMatch) {
              baseName = rawName.slice(0, closesMatch.index).trim();
              eventKind = 'close';
            }
          }

          const lowerBase = baseName.toLowerCase();
          let type: 'homework' | 'exam' | 'quiz' | 'task' = 'homework';
          if (lowerBase.includes('thi') || lowerBase.includes('exam') || lowerBase.includes('kiểm tra')) {
            type = lowerBase.includes('trắc nghiệm') || lowerBase.includes('quiz') ? 'quiz' : 'exam';
          }

          const existing = groupedMap.get(lowerBase);
          if (existing) {
            if (eventKind === 'open') {
              existing.openTimestamp = d.timestamp;
            } else if (eventKind === 'close') {
              existing.closeTimestamp = d.timestamp;
            }
            if (d.url && !existing.url) {
              existing.url = d.url;
            }
            existing.timestamp = existing.closeTimestamp || existing.openTimestamp || d.timestamp;
          } else {
            const entry: ActivityEntry = {
              id: d.id,
              name: baseName,
              courseName: d.courseName || activeCourse.name,
              openTimestamp: eventKind === 'open' ? d.timestamp : undefined,
              closeTimestamp: eventKind === 'close' ? d.timestamp : undefined,
              timestamp: d.timestamp,
              url: d.url,
              type,
            };
            groupedMap.set(lowerBase, entry);
          }
        }
      });
    }

    const list = Array.from(groupedMap.values());
    list.forEach(item => {
      if (item.closeTimestamp && item.openTimestamp) {
        item.timestamp = item.closeTimestamp;
      }
    });

    return list.sort((a, b) => a.timestamp - b.timestamp);
  }, [moodle?.deadlines, activeCourse.name, activeCourse.code]);

  // Quiz Analysis state & handler
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [currentAnalysis, setCurrentAnalysis] = useState<QuizAnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisLoadingStage, setAnalysisLoadingStage] = useState<'fetching_saved' | 'ai_diagnosing'>('fetching_saved');
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [selectedExamResult, setSelectedExamResult] = useState<ExamResult | null>(null);
  const [analyzedAttemptIds, setAnalyzedAttemptIds] = useState<Set<number>>(new Set());
  const [quizInitialMode, setQuizInitialMode] = useState<'comprehensive' | 'targeted'>('comprehensive');
  const [quizInitialTopics, setQuizInitialTopics] = useState<string[]>([]);
  const [selectedStrategies, setSelectedStrategies] = useState<GradeResponseStrategy[]>(['roadmap']);
  const [hideStrategyBar, setHideStrategyBar] = useState<boolean>(false);
  const analysisAbortRef = useRef<AbortController | null>(null);

  const handleStopQuizAnalysis = () => {
    if (analysisAbortRef.current) {
      analysisAbortRef.current.abort();
      analysisAbortRef.current = null;
    }
    setAnalysisLoading(false);
    if (!currentAnalysis) {
      setAnalysisError('Đã dừng quá trình chẩn đoán bài thi.');
    }
  };

  // Auto-restore selectedExamResult when navigating via URL with prompt intent
  useEffect(() => {
    if (!selectedExamResult && courseExamResults.length > 0 && (input.includes('Chào Gia sư AI!') || input.includes('bài kiểm tra'))) {
      const matched = courseExamResults.find(r => input.includes(`"${r.name}"`) || input.includes(r.name));
      if (matched) {
        setSelectedExamResult(matched);
      }
    }
  }, [courseExamResults, input, selectedExamResult]);

  // Sync analyzed status with database source of truth
  useEffect(() => {
    const localIds = getAllStoredAttemptIds();
    setAnalyzedAttemptIds(new Set(localIds));

    fetch('/api/quiz/analysis')
      .then(r => r.json() as Promise<{ analyses?: QuizAnalysisData[] }>)
      .then(data => {
        const serverAnalyses = data?.analyses || [];
        const serverAttemptIds = new Set<number>();
        for (const item of serverAnalyses) {
          if (item?.attemptId) {
            serverAttemptIds.add(Number(item.attemptId));
            saveStoredAnalysis(item.attemptId, item);
          }
        }
        setAnalyzedAttemptIds(serverAttemptIds);
      })
      .catch(() => {});
  }, []);

  // Listen to popstate event to close grade history or modal if open
  useEffect(() => {
    const onPop = () => {
      setShowGradeHistory(false);
      setShowActivityModal(false);
      setAnalysisModalOpen(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Sync tool and targeted remediation mode from searchParams
  useEffect(() => {
    const qTool = searchParams.get('tool');
    const qMode = searchParams.get('mode');
    const qTopics = searchParams.get('topics');
    if (qTool === 'Quiz' || qTool === 'Trắc nghiệm') {
      setTool('Trắc nghiệm');
    }
    if (qMode === 'targeted') {
      setQuizInitialMode('targeted');
    }
    if (qTopics) {
      const decodedTopics = qTopics
        .split(',')
        .map(t => decodeURIComponent(t.trim()))
        .filter(Boolean);
      if (decodedTopics.length > 0) {
        setQuizInitialTopics(decodedTopics);
      }
    }
  }, [searchParams]);

  // Keep search params synced with state
  useEffect(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (tool) params.set('tool', tool);
    else params.delete('tool');
    const newQuery = params.toString();
    const newUrl = `${window.location.pathname}${newQuery ? `?${newQuery}` : ''}`;
    window.history.replaceState(null, '', newUrl);
  }, [tool, searchParams]);

  // Handler to ask AI about an exam result (with 2x2 context matrix routing)
  const handleAskAiAboutGrade = async (res: ExamResult, forceReanalyze = false) => {
    setSelectedExamResult(res);

    const isAnalyzed = !!res.attemptId && analyzedAttemptIds.has(Number(res.attemptId));
    const route = resolveGradeRoute(res, isAnalyzed);

    // 1. Chat Action: Ôn tập theo nhận xét hoặc Gia sư AI
    // Directly place prompt into input of course chat
    if (route.actionType === 'chat') {
      setShowGradeHistory(false);
      setHideStrategyBar(false);
      const defaultSt = route.defaultStrategy || 'roadmap';
      setSelectedStrategies([defaultSt]);
      const prompt =
        route.prompt ||
        buildGradePrompt(
          res,
          [defaultSt],
          answerStyle,
          res.attemptId ? getStoredAnalysis(res.attemptId) : null
        );
      setTool('Chat');
      setInput(prompt);
      notify('Đã nạp câu lệnh vào ô chat. Bạn có thể kiểm tra và chỉnh sửa trước khi gửi.');
      return;
    }

    // 2. Modal Action: Chẩn đoán chi tiết bài thi
    const attemptIdToUse = res.attemptId;
    if (attemptIdToUse) {
      setShowGradeHistory(false);

      // Instant re-open: if already loaded in component state
      if (currentAnalysis && Number(currentAnalysis.attemptId) === Number(attemptIdToUse) && !forceReanalyze) {
        setAnalysisError(null);
        setAnalysisModalOpen(true);
        return;
      }

      // Client-side localStorage cache-first: 0 network calls, 0 token consumption, instant modal open
      if (!forceReanalyze) {
        const localCached = getStoredAnalysis(attemptIdToUse);
        if (localCached) {
          setCurrentAnalysis(localCached);
          setAnalysisError(null);
          setAnalysisModalOpen(true);
          return;
        }
      }

      // Abort any ongoing diagnosis request
      if (analysisAbortRef.current) {
        analysisAbortRef.current.abort();
      }
      const controller = new AbortController();
      analysisAbortRef.current = controller;

      // Clear previous analysis to prevent showing old exam title or data while loading
      setCurrentAnalysis(null);
      setAnalysisModalOpen(true);
      setAnalysisLoading(true);
      setAnalysisLoadingStage('fetching_saved');
      setAnalysisError(null);

      try {
        // Database cache-first: fetch existing saved analysis before spending AI credits
        if (!forceReanalyze) {
          const checkRes = await fetch(`/api/quiz/analysis?attemptId=${attemptIdToUse}`, {
            signal: controller.signal,
          });
          const checkText = await checkRes.text();
          let checkData: { analysis?: QuizAnalysisData; error?: string } = {};
          try {
            checkData = JSON.parse(checkText) as typeof checkData;
          } catch {
            throw new Error(checkText.trim().slice(0, 240) || 'Không thể đọc dữ liệu chẩn đoán đã lưu.');
          }
          if (checkData?.analysis) {
            setCurrentAnalysis({ ...checkData.analysis, cached: true });
            saveStoredAnalysis(attemptIdToUse, checkData.analysis);
            setAnalyzedAttemptIds(prev => new Set(prev).add(Number(attemptIdToUse)));
            setAnalysisLoading(false);
            return;
          }
        }

        // Need new AI diagnosis: indicate to user that AI generation is starting
        setAnalysisLoadingStage('ai_diagnosing');

        // Trigger analysis with 2x2 matrix context flags
        const apiRes = await fetch('/api/quiz/analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            attemptId: attemptIdToUse,
            courseId: res.courseId,
            courseCode: res.courseCode,
            courseName: res.courseName,
            quizName: res.name,
            userId: user?.id,
            feedback: res.feedback,
            has_details: route.hasDetails,
            has_feedback: route.hasFeedback,
            forceReanalyze,
          }),
        });
        const responseText = await apiRes.text();
        let data: { analysis?: QuizAnalysisData; error?: string } = {};
        try {
          data = JSON.parse(responseText) as typeof data;
        } catch {
          throw new Error(responseText.trim().slice(0, 240) || 'Máy chủ không trả về dữ liệu chẩn đoán hợp lệ.');
        }
        if (!apiRes.ok || data.error || !data.analysis) {
          throw new Error(data.error || 'Không thể chẩn đoán bài thi lúc này.');
        }
        setCurrentAnalysis(data.analysis);
        saveStoredAnalysis(attemptIdToUse, data.analysis);
        setAnalyzedAttemptIds(prev => new Set(prev).add(Number(attemptIdToUse)));
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          setAnalysisError('Đã dừng quá trình chẩn đoán bài thi.');
        } else {
          setAnalysisError(err instanceof Error ? err.message : 'Có lỗi khi phân tích bài thi.');
        }
      } finally {
        if (analysisAbortRef.current === controller) {
          analysisAbortRef.current = null;
        }
        setAnalysisLoading(false);
      }
      return;
    }
  };

  // Close drawers on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showGradeHistory) setShowGradeHistory(false);
        if (showActivityModal) setShowActivityModal(false);
        if (!isSourcePanelCollapsed && typeof window !== 'undefined' && window.innerWidth < 1100) {
          setIsSourcePanelCollapsed(true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showGradeHistory, showActivityModal, isSourcePanelCollapsed]);

  // Lock body scroll when any modal is active in course page
  useEffect(() => {
    const isAnyModalOpen = showGradeHistory || showActivityModal || showUploadModal || profile;
    if (!isAnyModalOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [showGradeHistory, showActivityModal, showUploadModal, profile]);

  // Auto cleanup RAM vector cache on course unmount / exit
  useEffect(() => {
    const courseCode = activeCourse.code;
    return () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify({ courseCode })], { type: 'application/json' });
          navigator.sendBeacon('/api/documents/cache', blob);
        } else {
          fetch('/api/documents/cache', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseCode }),
            keepalive: true,
          }).catch(() => {});
        }
      } catch {}
    };
  }, [activeCourse.code]);

  const handleClearChat = () => {
    if (chat.length <= 1) return;
    const ok = window.confirm(
      'Bạn có chắc chắn muốn xóa toàn bộ lịch sử trò chuyện môn học này không? Hành động này sẽ làm mới toàn bộ đoạn hội thoại và giải phóng bộ nhớ RAM cache.'
    );
    if (!ok) return;

    fetch('/api/documents/cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseCode: activeCourse.code }),
    }).catch(() => {});

    const resetChat: ChatMessage[] = [
      {
        role: 'ai',
        text: `Trợ lý Học tập AI môn ${activeCourse.name} đã sẵn sàng. Bạn có thể đặt câu hỏi hoặc yêu cầu phân tích, tóm tắt tài liệu.`,
        sources: [`${courseSources.length} tài liệu sẵn sàng`],
      },
    ];
    setChat(resetChat);
    const uId = user?.id || 4;
    const cId = activeCourse.id || 1;
    fetch(`/api/chat-sessions?userId=${uId}&moodleCourseId=${cId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});

    setChatSessionId(null);
    setInput('');
    notify('Đã xóa lịch sử trò chuyện khỏi cơ sở dữ liệu');
  };

  // Stop AI response manually
  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading(false);
    setChat(v => {
      const updated = [...v];
      if (updated.length > 0 && updated[updated.length - 1].role === 'ai') {
        const lastMsg = updated[updated.length - 1];
        const currentText = lastMsg.text.trim();
        updated[updated.length - 1] = {
          ...lastMsg,
          text: currentText ? `${currentText}\n\n*(Đã dừng câu trả lời theo yêu cầu)*` : '*(Đã dừng câu trả lời theo yêu cầu)*',
          model: lastMsg.model,
          provider: lastMsg.provider,
        };
        return updated;
      }
      return v;
    });
  };

  // Auto-collapse source panel on compact windows (e.g. tablet / split-screen)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 880) {
      setIsSourcePanelCollapsed(true);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat, loading]);

  const selectedSourceNames = sources.filter((_, i) => checked[i]).map(s => s.name);

  // Helper: Persist updated messages to chat-sessions database
  const persistChatSession = (updatedMessages: ChatMessage[], responseModelName?: string) => {
    const uId = user?.id || 4;
    const cId = activeCourse.id || 1;
    fetch('/api/chat-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: uId,
        userName: user?.fullname || 'Sinh viên',
        moodleCourseId: cId,
        sessionId: chatSessionId || undefined,
        messages: updatedMessages,
        response_model: responseModelName,
      }),
    })
      .then(response => response.json() as Promise<{ session?: { id?: string } }>)
      .then(result => {
        if (result.session?.id) setChatSessionId(String(result.session.id));
      })
      .catch(err => console.warn('Chat session persist error:', err));
  };

  // Submit question to LLM
  const ask = async (
    customPrompt?: string,
    baseChat?: ChatMessage[],
    overrideExternalSource?: boolean,
    overrideRagMode?: RagMode
  ) => {
    if (loading) {
      stopGeneration();
      return;
    }

    const q = (customPrompt ?? input).trim();
    if (!q) return;

    const currentBaseChat = baseChat ?? chat;
    const nextChat: ChatMessage[] = [...currentBaseChat, { role: 'user', text: q }];
    setChat(nextChat);
    if (!customPrompt) setInput('');
    setLoading(true);

    const selectedSources = sources.filter((_, i) => checked[i]);
    const selectedSourceNames = selectedSources.map(s => s.name);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const effectiveRagMode: RagMode =
        overrideRagMode !== undefined
          ? overrideRagMode
          : overrideExternalSource !== undefined
            ? (overrideExternalSource ? 'creative' : 'strict')
            : ragMode;
      const isExternalEffective = effectiveRagMode === 'creative';
      const res = await fetch('/api/tutor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          question: q,
          course: `${activeCourse.name} (${activeCourse.code})`,
          courseId: activeCourse.id,
          courseCode: activeCourse.code,
          userId: user?.id || 4,
          userName: user?.fullname || 'Sinh viên',
          gradebook: courseExamResults,
          upcomingDeadlines: courseActivities.map(a => ({
            name: a.name,
            timestamp: a.timestamp,
            type: a.type,
            url: a.url,
          })),
          sources: selectedSources,
          sourceNames: selectedSourceNames,
          sectionId:
            selectedSources.length === 1
              ? selectedSources[0]?.sectionId
              : (selectedSources.length > 1 && selectedSources.every(s => s.sectionId && s.sectionId === selectedSources[0]?.sectionId)
                ? selectedSources[0]?.sectionId
                : undefined),
          sectionName:
            selectedSources.length === 1
              ? selectedSources[0]?.sectionName
              : undefined,
          chapter:
            selectedSources.length === 1
              ? selectedSources[0]?.chapter
              : undefined,
          ragMode: effectiveRagMode,
          allowExternalSource: isExternalEffective,
          answerStyle,
          model: selectedModel,
          stream: true,
          history: currentBaseChat.slice(1).map(c => ({ role: c.role, text: c.text })),
        }),
      });

      if (!res.ok) {
        let errMessage = 'Lỗi kết nối tới Trợ lý AI.';
        try {
          const errData = (await res.json()) as { error?: string };
          if (errData?.error) errMessage = errData.error;
        } catch {
          // ignore
        }
        throw new Error(errMessage);
      }

      const contentType = res.headers.get('content-type') || '';
      let fullAnswer = '';
      let receivedSources: Array<string | CitationSource> = [];
      let responseModelName = '';
      let responseProviderName = '';

      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.model) {
                responseModelName = parsed.model;
              }
              if (parsed.provider) {
                responseProviderName = parsed.provider;
              }
              if (parsed.meta) {
                setChat(v => {
                  const updated = [...v];
                  if (updated.length > 0 && updated[updated.length - 1].role === 'ai') {
                    updated[updated.length - 1] = {
                      ...updated[updated.length - 1],
                      model: responseModelName || updated[updated.length - 1].model,
                      provider: responseProviderName || updated[updated.length - 1].provider,
                    };
                  }
                  return updated;
                });
              }
              if (parsed.delta) {
                if (parsed.replace) {
                  fullAnswer = parsed.delta;
                } else {
                  fullAnswer += parsed.delta;
                }
                setChat(v => {
                  const updated = [...v];
                  if (updated.length > 0 && updated[updated.length - 1].role === 'ai') {
                    updated[updated.length - 1] = {
                      ...updated[updated.length - 1],
                      text: fullAnswer,
                      model: responseModelName || updated[updated.length - 1].model,
                      provider: responseProviderName || updated[updated.length - 1].provider,
                    };
                  } else {
                    updated.push({
                      role: 'ai',
                      text: fullAnswer,
                      sources: [],
                      model: responseModelName,
                      provider: responseProviderName,
                    });
                  }
                  return updated;
                });
              }
              if (parsed.sources && Array.isArray(parsed.sources)) {
                receivedSources = parsed.sources;
                setChat(v => {
                  const updated = [...v];
                  if (updated.length > 0 && updated[updated.length - 1].role === 'ai') {
                    updated[updated.length - 1] = {
                      ...updated[updated.length - 1],
                      sources: receivedSources,
                      model: responseModelName || updated[updated.length - 1].model,
                      provider: responseProviderName || updated[updated.length - 1].provider,
                    };
                  } else {
                    updated.push({
                      role: 'ai',
                      text: fullAnswer,
                      sources: receivedSources,
                      model: responseModelName,
                      provider: responseProviderName,
                    });
                  }
                  return updated;
                });
              }
              if (parsed.done) {
                if (parsed.model) responseModelName = parsed.model;
                if (parsed.provider) responseProviderName = parsed.provider;
                if (parsed.fullText) fullAnswer = parsed.fullText;
                const msgRagMode = (parsed.ragMode as RagMode) || effectiveRagMode;
                const msgIsFallback = Boolean(parsed.isFallback);
                const msgFinishReason = (parsed.finishReason as string) || 'stop';
                setChat(v => {
                  const updated = [...v];
                  if (updated.length > 0 && updated[updated.length - 1].role === 'ai') {
                    updated[updated.length - 1] = {
                      ...updated[updated.length - 1],
                      text: fullAnswer,
                      sources: receivedSources.length > 0 ? receivedSources : updated[updated.length - 1].sources,
                      model: responseModelName || updated[updated.length - 1].model,
                      provider: responseProviderName || updated[updated.length - 1].provider,
                      ragMode: msgRagMode,
                      isFallback: msgIsFallback,
                      finishReason: msgFinishReason,
                    };
                  }
                  return updated;
                });
              }
              if (parsed.error) {
                throw new Error(parsed.error);
              }
            } catch (pErr) {
              if (pErr instanceof Error && pErr.message !== 'Unexpected end of JSON input') {
                console.warn('SSE parse error:', pErr);
              }
            }
          }
        }
      } else {
        const data = (await res.json()) as TutorResponse & { model?: string; provider?: string; ragMode?: RagMode; isFallback?: boolean };
        fullAnswer = data.answer ?? '';
        receivedSources = (data.sources ?? []) as Array<string | CitationSource>;
        responseModelName = data.model || 'Groq LPU';
        responseProviderName = data.provider || 'groq';
        const msgRagMode = data.ragMode || effectiveRagMode;
        const msgIsFallback = Boolean(data.isFallback);
        const msgFinishReason = data.finishReason || 'stop';
        setChat(v => {
          const updated = [...v];
          if (updated.length > 0 && updated[updated.length - 1].role === 'ai') {
            updated[updated.length - 1] = {
              role: 'ai',
              text: fullAnswer,
              sources: receivedSources,
              model: responseModelName,
              provider: responseProviderName,
              ragMode: msgRagMode,
              isFallback: msgIsFallback,
              finishReason: msgFinishReason,
            };
          } else {
            updated.push({
              role: 'ai',
              text: fullAnswer,
              sources: receivedSources,
              model: responseModelName,
              provider: responseProviderName,
              ragMode: msgRagMode,
              isFallback: msgIsFallback,
              finishReason: msgFinishReason,
            });
          }
          return updated;
        });
      }

      // Save to chat-sessions database with response_model
      const finalChatMessages: ChatMessage[] = [
        ...nextChat,
        {
          role: 'ai',
          text: fullAnswer,
          sources: receivedSources,
          model: responseModelName,
          provider: responseProviderName,
        },
      ];
      persistChatSession(finalChatMessages, responseModelName);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        return;
      }
      setChat(v => {
        const updated = [...v];
        if (updated.length > 0 && updated[updated.length - 1].role === 'ai') {
          updated[updated.length - 1] = {
            role: 'ai',
            text: e instanceof Error ? e.message : 'Không thể kết nối gia sư lúc này.',
            sources: [],
          };
        } else {
          updated.push({
            role: 'ai',
            text: e instanceof Error ? e.message : 'Không thể kết nối gia sư lúc này.',
            sources: [],
          });
        }
        return updated;
      });
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setLoading(false);
    }
  };

  // Prompt Actions: Re-answer, Delete, Edit
  const handleReAnswer = (
    index: number,
    promptText: string,
    overrideExternalSource?: boolean,
    overrideRagMode?: RagMode
  ) => {
    if (loading) return;
    if (overrideRagMode) {
      setRagMode(overrideRagMode);
    } else if (overrideExternalSource !== undefined) {
      setRagMode(overrideExternalSource ? 'creative' : 'strict');
    }
    // Slices conversation to before this prompt so previous question and previous AI answer are cleared immediately
    const baseChat = chat.slice(0, index);
    setChat(baseChat);
    void ask(promptText, baseChat, overrideExternalSource, overrideRagMode);
  };

  const handleDeletePrompt = (index: number) => {
    if (loading) return;
    const next = [...chat];
    if (next[index + 1] && next[index + 1].role === 'ai') {
      next.splice(index, 2);
    } else {
      next.splice(index, 1);
    }
    setChat(next);
    persistChatSession(next);
    notify('Đã xóa câu hỏi khỏi cuộc trò chuyện và cơ sở dữ liệu');
  };

  const handleEditPrompt = (index: number, promptText: string) => {
    if (loading) return;
    const next = [...chat];
    if (next[index + 1] && next[index + 1].role === 'ai') {
      next.splice(index, 2);
    } else {
      next.splice(index, 1);
    }
    setChat(next);
    persistChatSession(next);
    setInput(promptText);

    setTimeout(() => {
      if (chatInputRef.current) {
        chatInputRef.current.focus();
        const len = promptText.length;
        chatInputRef.current.setSelectionRange(len, len);
        chatInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);
    notify('Đã đưa câu hỏi vào khung nhập liệu');
  };

  useEffect(() => {
    if (
      initialIntent &&
      !initialIntent.startsWith('__') &&
      !initialIntent.startsWith('Tiếp tục học') &&
      !initialIntent.startsWith('Giảng dạy') &&
      !askedIntent.current
    ) {
      askedIntent.current = true;
      if (!draftMode) {
        // Auto-send only when NOT in draft mode
        void ask(initialIntent);
      } else {
        // In draft mode, ensure input has the intent, switch to Chat, and do NOT auto-send!
        setInput(initialIntent);
        setTool('Chat');
        notify('Đã nạp câu lệnh vào ô chat. Bạn có thể kiểm tra và chỉnh sửa trước khi gửi.');
      }
    }
  }, [initialIntent, activeCourse.code]);

  // Tab switching simply activates the view without auto-fetching
  const openTool = (next: string) => {
    if (tool === next) {
      if ((artifactsMap[next] || []).length > 0) {
        setShowArtifactList(prev => !prev);
      }
    } else {
      setTool(next);
      if ((artifactsMap[next] || []).length > 0 && !selectedArtifactIds[next]) {
        setShowArtifactList(true);
      }
    }
  };

  // Manual abort for artifact generation
  const stopArtifactGeneration = () => {
    const requestId = artifactRequestIdRef.current;
    if (requestId) {
      void fetch('/api/study-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', requestId }),
        keepalive: true,
      }).catch(() => {});
    }
    if (artifactAbortRef.current) {
      artifactAbortRef.current.abort();
      artifactAbortRef.current = null;
    }
    artifactRequestIdRef.current = null;
    setArtifactLoading(false);
    notify('Đã dừng tạo học liệu theo yêu cầu.');
  };

  // On-demand generation triggered only when user validates
  const generateToolArtifact = async (
    type: string,
    level: 'simple' | 'standard' | 'complex',
    topic: string,
    allowExternal?: boolean,
    toolRagMode?: RagMode
  ) => {
    setArtifactLoading(true);
    const selectedSources = sources.filter((_, i) => checked[i]);
    const selectedSourceNames = selectedSources.map(s => s.name);
    const apiType =
      type === 'Tóm tắt'
        ? 'summary'
        : type === 'Mindmap'
        ? 'mindmap'
        : type === 'Slide'
        ? 'slides'
        : 'flashcards';
    const effectiveRagMode: RagMode =
      toolRagMode ||
      (allowExternal !== undefined ? (allowExternal ? 'creative' : 'hybrid') : ragMode);
    const effectiveAllowExternal = effectiveRagMode === 'creative';

    if (artifactAbortRef.current) {
      artifactAbortRef.current.abort();
    }
    if (artifactRequestIdRef.current) {
      void fetch('/api/study-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', requestId: artifactRequestIdRef.current }),
        keepalive: true,
      }).catch(() => {});
    }
    const controller = new AbortController();
    const requestId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    artifactAbortRef.current = controller;
    artifactRequestIdRef.current = requestId;

    try {
      const res = await fetch('/api/study-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          type: apiType,
          requestId,
          topic: topic || activeCourse.name,
          course: `${activeCourse.name} (${activeCourse.code})`,
          courseId: activeCourse.id,
          courseCode: activeCourse.code,
          userId: user?.id || 4,
          userName: user?.fullname || 'Sinh viên',
          sources: selectedSources,
          sourceNames: selectedSourceNames,
          level,
          ragMode: effectiveRagMode,
          allowExternalSource: effectiveAllowExternal,
          model: selectedModel,
        }),
      });
      const data = (await res.json()) as StudyToolResponse;
      if (!res.ok) throw new Error(data.error);
      if (artifactRequestIdRef.current !== requestId) return;

      const newArtifact: GeneratedArtifact = {
        id: data.artifactId || `${type}-${Date.now()}`,
        name: topic || activeCourse.name,
        data: data.data,
        originalData: data.data,
        level,
        topic: topic || activeCourse.name,
        orientation: type === 'Mindmap' ? 'horizontal' : undefined,
      };
      setArtifactsMap(prev => ({ ...prev, [type]: [...(prev[type] || []), newArtifact] }));
      setSelectedArtifactIds(prev => ({ ...prev, [type]: newArtifact.id }));
      setShowArtifactList(false);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return;
      }
      notify(e instanceof Error ? e.message : 'Không thể tạo học liệu.');
    } finally {
      if (artifactAbortRef.current === controller) {
        artifactAbortRef.current = null;
        artifactRequestIdRef.current = null;
        setArtifactLoading(false);
      }
    }
  };

  const resetToolArtifact = (type: string) => {
    setSelectedArtifactIds(prev => {
      const next = { ...prev };
      delete next[type];
      return next;
    });
    setShowArtifactList(true);
  };

  const renameToolArtifact = async (type: string, artifact: GeneratedArtifact) => {
    const name = window.prompt('Đặt tên dễ nhớ cho học liệu:', artifact.name);
    if (!name || name.trim() === artifact.name) return;

    try {
      const response = await fetch(`/api/learning-artifacts?id=${encodeURIComponent(artifact.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const responseText = await response.text();
      let result: { error?: string } = {};
      try {
        result = JSON.parse(responseText) as typeof result;
      } catch {
        throw new Error(responseText.trim().slice(0, 240) || 'Máy chủ không trả về phản hồi hợp lệ.');
      }
      if (!response.ok) throw new Error(result.error || 'Không thể đổi tên học liệu.');
      setArtifactsMap(prev => ({
        ...prev,
        [type]: (prev[type] || []).map(item => item.id === artifact.id ? { ...item, name: name.trim() } : item),
      }));
      notify('Đã đổi tên học liệu.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Không thể đổi tên học liệu.');
    }
  };

  const deleteToolArtifact = async (type: string, artifactId: string) => {
    try {
      const response = await fetch(`/api/learning-artifacts?id=${encodeURIComponent(artifactId)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Không thể xóa học liệu.');
      setArtifactsMap(prev => {
        const remaining = (prev[type] || []).filter(item => item.id !== artifactId);
        return remaining.length > 0 ? { ...prev, [type]: remaining } : Object.fromEntries(Object.entries(prev).filter(([key]) => key !== type));
      });
      setSelectedArtifactIds(prev => {
        const next = { ...prev };
        if (next[type] === artifactId) delete next[type];
        return next;
      });
      notify('Đã xóa học liệu.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Không thể xóa học liệu.');
    }
  };

  const updateToolArtifactOrientation = async (type: string, artifactId: string, orientation: 'horizontal' | 'vertical') => {
    setArtifactsMap(prev => ({
      ...prev,
      [type]: (prev[type] || []).map(item =>
        item.id === artifactId
          ? {
              ...item,
              orientation,
              data: typeof item.data === 'object' && item.data !== null
                ? { ...(item.data as Record<string, unknown>), orientation }
                : item.data,
            }
          : item
      ),
    }));

    try {
      const response = await fetch(`/api/learning-artifacts?id=${encodeURIComponent(artifactId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orientation }),
      });
      if (!response.ok) {
        console.warn('Không thể lưu hướng sơ đồ tư duy vào cơ sở dữ liệu.');
      }
    } catch (error) {
      console.warn('Lỗi khi lưu hướng sơ đồ tư duy vào cơ sở dữ liệu:', error);
    }
  };

  const updateToolArtifactData = async (type: string, artifactId: string, newData: unknown): Promise<boolean> => {
    // 1. Immediately update in-memory state
    const currentItem = (artifactsMap[type] || []).find(item => item.id === artifactId);
    const preservedOriginalData = currentItem?.originalData || (currentItem?.data as any)?.originalData || currentItem?.data;

    setArtifactsMap(prev => ({
      ...prev,
      [type]: (prev[type] || []).map(item =>
        item.id === artifactId
          ? {
              ...item,
              data: newData,
              originalData: item.originalData || (item.data as any)?.originalData || item.data,
              orientation: (newData as any)?.orientation || item.orientation,
            }
          : item
      ),
    }));

    // 2. Persist to Database via PATCH /api/learning-artifacts
    try {
      const response = await fetch(`/api/learning-artifacts?id=${encodeURIComponent(artifactId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentData: {
            data: newData,
            originalData: preservedOriginalData,
          },
          orientation: (newData as any)?.orientation,
          userId: user?.id || 4,
          moodleCourseId: activeCourse.id,
          artifactType: type === 'Mindmap' ? 'mindmap' : type.toLowerCase(),
        }),
      });
      if (!response.ok) {
        throw new Error('Lỗi phản hồi từ máy chủ khi lưu học liệu.');
      }
      return true;
    } catch (error) {
      console.warn('Lỗi khi lưu dữ liệu học liệu vào CSDL:', error);
      throw error;
    }
  };

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    notify('Đã sao chép vào bộ nhớ tạm');
  };

  const handleAddSource = () => {
    setShowUploadModal(true);
  };

  const handleUploadSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (uploadTab === 'file') {
      if (!uploadFile) {
        notify('Vui lòng chọn hoặc kéo thả một tệp tài liệu.');
        return;
      }
      setUploadLoading(true);
      try {
        const fileName = uploadFileTitle.trim() || uploadFile.name;
        const ext = uploadFile.name.split('.').pop()?.toLowerCase() || '';
        let type: 'PDF' | 'DOCX' | 'PPTX' | 'TXT' | 'FILE' = 'FILE';
        if (ext === 'pdf') type = 'PDF';
        else if (ext === 'docx' || ext === 'doc') type = 'DOCX';
        else if (ext === 'pptx' || ext === 'ppt') type = 'PPTX';
        else if (ext === 'txt') type = 'TXT';

        let content = '';
        if (ext === 'txt') {
          content = await uploadFile.text();
        }

        let uploadedFileUrl: string | undefined = undefined;
        try {
          const formData = new FormData();
          formData.append('file', uploadFile);
          formData.append('title', fileName);
          formData.append('courseId', activeCourse.code);
          if (activeCourse.id) formData.append('moodleCourseId', String(activeCourse.id));
          formData.append('userId', String(user?.id || 4));
          formData.append('userName', user?.fullname || 'Sinh viên');
          formData.append('uploadSource', 'student');
          if (content) formData.append('content', content);

          const uploadRes = await fetch('/api/documents/process', {
            method: 'POST',
            body: formData,
          });
          const uploadData = (await uploadRes.json()) as {
            material?: { id?: string | number; storage_url?: string; storageUrl?: string };
            fileUrl?: string;
          };
          if (uploadData?.material?.storage_url || uploadData?.material?.storageUrl || uploadData?.fileUrl) {
            uploadedFileUrl = uploadData.material?.storage_url || uploadData.material?.storageUrl || uploadData.fileUrl;
          }
          const materialId = uploadData.material?.id;
          const sizeStr = (uploadFile.size / (1024 * 1024)).toFixed(1) + ' MB';
          const newItem: CourseSourceItem = {
            id: materialId ? `mat-${materialId}` : `upload-${Date.now()}`,
            name: fileName,
            type,
            sizeOrPages: `Tệp đã nạp · ${sizeStr}`,
            url: uploadedFileUrl,
            courseCode: activeCourse.code,
          };
          setSources(v => [newItem, ...v]);
          setChecked(v => [true, ...v]);
          setShowUploadModal(false);
          setUploadFile(null);
          setUploadFileTitle('');
          notify(`Đã nạp thành công tài liệu: "${fileName}"`);
          return;
        } catch (err) {
          console.warn('Document indexing note:', err);
        }

        const sizeStr = (uploadFile.size / (1024 * 1024)).toFixed(1) + ' MB';
        const newItem: CourseSourceItem = {
          id: `upload-${Date.now()}`,
          name: fileName,
          type,
          sizeOrPages: `Tệp đã nạp · ${sizeStr}`,
          url: uploadedFileUrl,
          courseCode: activeCourse.code,
        };

        setSources(v => [newItem, ...v]);
        setChecked(v => [true, ...v]);
        setShowUploadModal(false);
        setUploadFile(null);
        setUploadFileTitle('');
        notify(`Đã nạp thành công tài liệu: "${fileName}"`);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Tải tài liệu thất bại.');
      } finally {
        setUploadLoading(false);
      }
    } else if (uploadTab === 'url') {
      if (!uploadUrl.trim()) {
        notify('Vui lòng nhập đường dẫn liên kết.');
        return;
      }
      const cleanUrl = uploadUrl.trim();
      if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
        notify('Đường dẫn phải bắt đầu bằng http:// hoặc https://');
        return;
      }
      const title = uploadUrlTitle.trim() || cleanUrl;
      const newItem: CourseSourceItem = {
        id: `url-${Date.now()}`,
        name: title,
        type: 'LINK',
        sizeOrPages: 'Cá nhân',
        url: cleanUrl,
        courseCode: activeCourse.code,
      };

      try {
        const urlUploadResponse = await fetch('/api/documents/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            fileUrl: cleanUrl,
            content: `[Liên kết web: ${cleanUrl}]`,
            courseId: activeCourse.code,
            moodleCourseId: activeCourse.id || 1,
            userId: user?.id || 4,
            userName: user?.fullname || 'Sinh viên',
          }),
        });
        const urlUploadData = (await urlUploadResponse.json()) as { material?: { id?: string | number; storage_url?: string; storageUrl?: string }; fileUrl?: string };
        if (urlUploadData.material?.id) newItem.id = `mat-${urlUploadData.material.id}`;
      } catch (err) {
        console.warn('URL document indexing note:', err);
      }

      setSources(v => [newItem, ...v]);
      setChecked(v => [true, ...v]);
      setShowUploadModal(false);
      setUploadUrl('');
      setUploadUrlTitle('');
      notify(`Đã thêm liên kết: "${title}"`);
    } else if (uploadTab === 'text') {
      if (!uploadTextContent.trim()) {
        notify('Vui lòng nhập nội dung ghi chú.');
        return;
      }
      const title = uploadTextTitle.trim() || 'Ghi chú bài học mới';
      const newItem: CourseSourceItem = {
        id: `note-${Date.now()}`,
        name: title,
        type: 'TXT',
        sizeOrPages: 'Ghi chú cá nhân',
        courseCode: activeCourse.code,
      };

      try {
        const noteUploadResponse = await fetch('/api/documents/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            content: uploadTextContent.trim(),
            courseId: activeCourse.code,
            moodleCourseId: activeCourse.id || 1,
            userId: user?.id || 4,
            userName: user?.fullname || 'Sinh viên',
          }),
        });
        const noteUploadData = (await noteUploadResponse.json()) as { material?: { id?: string | number } };
        if (noteUploadData.material?.id) newItem.id = `mat-${noteUploadData.material.id}`;
      } catch (err) {
        console.warn('Text document indexing note:', err);
      }

      setSources(v => [newItem, ...v]);
      setChecked(v => [true, ...v]);
      setShowUploadModal(false);
      setUploadTextTitle('');
      setUploadTextContent('');
      notify(`Đã lưu ghi chú: "${title}"`);
    }
  };

  const visibleSources = sources
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item.name.toLowerCase().includes(sourceQuery.toLowerCase()));

  const groupedVisibleSources = [
    {
      key: 'lms',
      label: 'Từ LMS',
      items: visibleSources.filter(({ item }) => !isStudentSource(item)),
    },
    {
      key: 'student',
      label: 'Sinh viên tải lên',
      items: visibleSources.filter(({ item }) => isStudentSource(item)),
    },
  ];

  const displayName = user?.fullname || moodle?.user?.name || 'Student';

  const deletePersonalSource = async (item: CourseSourceItem) => {
    if (!isStudentSource(item) || !item.id) return;
    const materialId = item.id.replace(/^(mat|upload|url|note)-/, '');
    if (!window.confirm(`Xóa tài liệu "${item.name}" khỏi khóa học và bộ nhớ đám mây?`)) return;

    try {
      const response = await fetch(`/api/documents/process?id=${encodeURIComponent(materialId)}&userId=${user?.id || 4}`, {
        method: 'DELETE',
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || 'Không thể xóa tài liệu.');
      setSources(prev => prev.filter(source => source.id !== item.id));
      setChecked(prev => prev.filter((_, index) => sources[index]?.id !== item.id));
      notify(`Đã xóa tài liệu: "${item.name}"`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Không thể xóa tài liệu.');
    }
  };

  const savedUrls = useMemo(() => {
    return sources.map(s => s.url).filter(Boolean) as string[];
  }, [sources]);

  const handleAddExternalLinkToPersonalMaterial = async ({ title, url }: { title: string; url: string }) => {
    const cleanUrl = url.trim();
    if (!cleanUrl) return;

    const cleanNormUrl = cleanUrl.toLowerCase().replace(/\/+$/, '');
    const existing = sources.find(s => {
      if (!s.url) return false;
      const sNorm = s.url.toLowerCase().replace(/\/+$/, '');
      return sNorm === cleanNormUrl || cleanNormUrl.startsWith(sNorm) || sNorm.startsWith(cleanNormUrl);
    });

    if (existing) {
      notify(`Liên kết "${existing.name}" đã có trong danh sách tài liệu môn học.`);
      return;
    }

    const cleanTitle =
      title.trim() ||
      (() => {
        try {
          return new URL(cleanUrl).hostname.replace(/^www\./, '');
        } catch {
          return cleanUrl;
        }
      })();

    const tempId = `url-${Date.now()}`;
    const newItem: CourseSourceItem = {
      id: tempId,
      name: cleanTitle,
      type: 'LINK',
      sizeOrPages: 'Cá nhân',
      url: cleanUrl,
      courseCode: activeCourse.code,
    };

    setSources(v => [newItem, ...v]);
    setChecked(v => [true, ...v]);
    notify(`Đang lập chỉ mục và lưu "${cleanTitle}" vào tài liệu cá nhân...`);

    try {
      const res = await fetch('/api/documents/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: cleanTitle,
          fileUrl: cleanUrl,
          content: `[Liên kết web nguồn ngoài: ${cleanUrl}]`,
          courseId: activeCourse.code,
          moodleCourseId: activeCourse.id || 1,
          userId: user?.id || 4,
          userName: user?.fullname || 'Sinh viên',
        }),
      });
      const data = (await res.json()) as { material?: { id?: string | number } };
      if (data?.material?.id) {
        setSources(v =>
          v.map(s => (s.id === tempId || s.url === cleanUrl ? { ...s, id: `mat-${data.material?.id}` } : s))
        );
      }
      notify(`Đã lưu "${cleanTitle}" vào tài liệu cá nhân môn học!`);
    } catch (err) {
      console.warn('Save external link error:', err);
      notify(`Đã lưu "${cleanTitle}" vào danh sách học liệu phiên làm việc.`);
    }
  };

  return (
    <main className="app-shell course-shell-layout">
      <CourseTopBar
        search={search}
        onSearchChange={setSearch}
        searchRef={searchRef}
        syncing={syncing}
        onSync={() => void syncMoodleData(true)}
        notifications={notifications}
        onToggleNotifications={() => setNotifications(!notifications)}
        onCloseNotifications={() => setNotifications(false)}
        notificationPermission={notificationPermission}
        onRequestNotificationPermission={undefined}
        user={user}
        displayName={displayName}
        onOpenProfile={() => setProfile(true)}
        onOpenNotification={(notif) => {
          setNotifications(false);
          if (notif.url) {
            window.open(notif.url, '_blank');
          } else {
            router.push('/home');
          }
        }}
      />

      {/* Main content */}
      <section className="content course-content">

        {/* Course Detail Page Body */}
        {isTeacherCourse ? (
          <div className={`workspace-page course-workspace teacher-workspace fade-in ${teacherTab === 'assistant' ? 'assistant-tab-active' : ''}`}>
            <CourseHeader
              activeCourse={activeCourse}
              allCourses={allCourses}
              isTeacher={true}
              onSelectCourse={handleCourseChange}
            />

            <TeacherPortal
              courses={allCourses}
              moodleUrl={moodle?.moodleUrl || 'http://moodle.test'}
              token={typeof window !== 'undefined' ? localStorage.getItem('moodleToken') || '' : ''}
              initialCourseId={activeCourse.id || activeCourse.code}
              hideHeader={true}
              sources={courseSources}
              initialTab="assistant"
              onTabChange={setTeacherTab}
            />
          </div>
        ) : (
          <div className="workspace-page course-workspace student-workspace fade-in">
            <CourseHeader
              activeCourse={activeCourse}
              allCourses={allCourses}
              isTeacher={false}
              onSelectCourse={handleCourseChange}
            />

          <div className={`tutor-layout ${isSourcePanelCollapsed ? 'source-collapsed' : ''}`}>
            {/* Backdrop for source drawer on narrow/half screens */}
            {!isSourcePanelCollapsed && (
              <div
                className="source-drawer-backdrop"
                onClick={() => setIsSourcePanelCollapsed(true)}
                title="Đóng bảng tài liệu (Esc)"
                aria-label="Đóng bảng tài liệu"
              />
            )}

            {/* Source panel */}
            <aside className={`source-panel ${isSourcePanelCollapsed ? 'collapsed' : ''}`}>
              <div className="source-panel-header">
                <div className="panel-title">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <Folder size={15} style={{ color: '#a78bfa' }} />
                    <strong>Nguồn tài liệu</strong>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <span>{selectedSourceNames.length} đã chọn</span>
                    <button
                      type="button"
                      className="collapse-source-btn"
                      onClick={() => setIsSourcePanelCollapsed(true)}
                      title="Thu gọn danh sách tài liệu môn học"
                      aria-label="Thu gọn danh sách tài liệu môn học"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <ChevronLeft size={14} />
                    </button>
                  </div>
                </div>

                <label className="source-search">
                  <Search size={14} style={{ color: '#94a3b8', flexShrink: 0 }} />
                  <input
                    value={sourceQuery}
                    onChange={e => setSourceQuery(e.target.value)}
                    placeholder="Tìm tài liệu môn học..."
                  />
                </label>
              </div>

              <div className="source-list-scroll">
                {visibleSources.length === 0 ? (
                  <div className="empty-state" style={{ padding: '1rem', fontSize: '13px' }}>
                    Chưa có tài liệu nào trong khóa học này. Hãy nhấn "Thêm nguồn tài liệu" bên dưới hoặc đồng bộ từ Moodle.
                  </div>
                ) : (
                  groupedVisibleSources.map(group => (
                    group.items.length > 0 && (
                      <div className="source-group" key={group.key}>
                        <div className="source-group-heading">
                          <span>{group.label}</span>
                          <small>{group.items.length}</small>
                        </div>
                        {group.items.map(({ item, i }) => {
                          const badge = getSourceBadge(item.type, item.name);
                          return (
                            <label className={`source-item ${isStudentSource(item) ? 'student-source-item' : ''}`} key={`${item.name}-${i}`}>
                              <input
                                type="checkbox"
                                checked={checked[i] ?? true}
                                onChange={() =>
                                  setChecked(v => v.map((x, n) => (n === i ? !x : x)))
                                }
                              />
                              <span className={`file-badge ${isStudentSource(item) ? (item.type === 'LINK' ? 'link-badge' : 'student-file-badge') : badge.className}`}>
                                {isStudentSource(item) ? (item.type === 'LINK' ? <Globe size={13} /> : <FileText size={13} />) : badge.label}
                              </span>
                              <span
                                className="source-item-text"
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '2px',
                                  overflow: 'hidden',
                                  minWidth: 0,
                                  flex: '1 1 auto',
                                  fontSize: isStudentSource(item) ? '11px' : undefined,
                                  lineHeight: isStudentSource(item) ? 1.3 : undefined,
                                }}
                              >
                                {item.url ? (
                                  <a
                                    href={item.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    style={{
                                      color: 'inherit',
                                      textDecoration: 'none',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      fontSize: isStudentSource(item) ? '11px' : undefined,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                    title="Mở tài liệu gốc"
                                  >
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                                    <ExternalLink size={12} style={{ opacity: 0.7, flexShrink: 0 }} />
                                  </a>
                                ) : (
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                                )}
                                {!isStudentSource(item) ? (
                                  <small style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {item.type === 'LINK' ? 'Liên kết Web' : item.type}
                                  </small>
                                ) : (
                                  <small
                                    style={{
                                      display: 'block',
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      color: '#94a3b8',
                                    }}
                                  >
                                    {item.type === 'LINK'
                                      ? 'Cá nhân'
                                      : (item.sizeOrPages?.replace(/Liên kết [wW]eb\s*[·•-]?\s*/gi, '').trim() || 'Tài liệu cá nhân')}
                                  </small>
                                )}
                              </span>
                              {isStudentSource(item) && (
                                <button
                                  type="button"
                                  className="source-delete-btn"
                                  onClick={event => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    void deletePersonalSource(item);
                                  }}
                                  title="Xóa tài liệu cá nhân"
                                  aria-label={`Xóa ${item.name}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )
                  ))
                )}

                <button className="add-source" onClick={handleAddSource} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <Plus size={15} />
                  Thêm nguồn tài liệu (PDF, Word, Web)
                </button>
              </div>
            </aside>

            {/* Chat / Artifact panel */}
            <section className="chat-panel">
              <div className="tool-tabs">
                <div className="tool-tabs-left">
                  {isSourcePanelCollapsed && (
                    <button
                      type="button"
                      className="expand-source-pill"
                      onClick={() => setIsSourcePanelCollapsed(false)}
                      title="Mở danh sách tài liệu môn học"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      <Folder size={14} style={{ color: '#a78bfa' }} />
                      <span className="expand-source-text">Nguồn tài liệu</span>
                      <span className="source-count-badge">{selectedSourceNames.length}</span>
                    </button>
                  )}
                  {[
                    { id: 'Chat', label: 'Chat', icon: <MessageSquare size={14} /> },
                    { id: 'Tóm tắt', label: 'Tóm tắt', icon: <FileText size={14} /> },
                    { id: 'Mindmap', label: 'Mindmap', icon: <GitFork size={14} /> },
                    { id: 'Flashcard', label: 'Flashcard', icon: <Layers size={14} /> },
                    { id: 'Slide', label: 'Slide', icon: <Layout size={14} /> },
                    { id: 'Trắc nghiệm', label: 'Trắc nghiệm', icon: <HelpCircle size={14} /> },
                  ].map(tab => {
                    const artifactCount = (artifactsMap[tab.id] || []).length;
                    return (
                      <button
                        key={tab.id}
                        className={tool === tab.id ? 'selected' : ''}
                        onClick={() => void openTool(tab.id)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                        title={
                          artifactCount > 0
                            ? `${tab.label} (${artifactCount} học liệu đã tạo${tool === tab.id ? ' · Nhấn để ẩn/hiện danh sách' : ''})`
                            : tab.label
                        }
                      >
                        {tab.icon}
                        <span>{tab.label}</span>
                        {artifactCount > 0 && (
                          <span className="tab-artifact-count-badge">
                            {artifactCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="tool-tabs-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setShowGradeHistory(false);
                      setShowActivityModal(prev => !prev);
                    }}
                    className="grade-history-tab-btn"
                    title={showActivityModal ? 'Ẩn hoạt động (Esc)' : 'Xem bài tập, lịch thi & hạn nộp môn học'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <CalendarCheck size={14} />
                    <span>Hoạt động</span>
                    {courseActivities.length > 0 && (
                      <span
                        style={{
                          background: showActivityModal ? '#20bfa9' : 'rgba(32, 191, 169, 0.3)',
                          color: '#fff',
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: '999px',
                        }}
                      >
                        {courseActivities.length}
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setShowActivityModal(false);
                      setShowGradeHistory(prev => !prev);
                    }}
                    className="grade-history-tab-btn"
                    title={showGradeHistory ? 'Ẩn bảng điểm (Esc)' : 'Xem kết quả học tập & nhận xét môn học'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <BarChart3 size={14} />
                    <span>Bảng điểm</span>
                    {courseExamResults.length > 0 && (
                      <span
                        style={{
                          background: showGradeHistory ? '#7c6df2' : 'rgba(124, 109, 242, 0.3)',
                          color: '#fff',
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: '999px',
                        }}
                      >
                        {courseExamResults.length}
                      </span>
                    )}
                  </button>

                  <a
                    href={lmsCourseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lms-redirect-btn"
                    title={`Mở trực tiếp khóa học ${activeCourse.name} trên hệ thống LMS`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <GraduationCap size={15} />
                    <span>Mở LMS</span>
                    <ExternalLink size={12} style={{ opacity: 0.8 }} />
                  </a>
                </div>
              </div>

              {tool === 'Chat' ? (
                <>
                  <div className="messages">
                    {chat.map((m, i) => {
                      if (m.role === 'ai' && !m.text.trim() && (!m.sources || m.sources.length === 0)) {
                        return null;
                      }
                      return (
                        <div className={`message ${m.role}`} key={i}>
                          {m.role === 'ai' && (
                            <span className="bot-avatar">
                              <Sparkles size={16} />
                            </span>
                          )}

                          {m.role === 'user' && (
                            <div className="user-message-actions">
                              <button
                                type="button"
                                className="user-action-btn"
                                onClick={() => handleReAnswer(i, m.text)}
                                title="Trả lời lại (Re-answer)"
                              >
                                <RotateCcw size={13} />
                              </button>
                              <button
                                type="button"
                                className="user-action-btn delete"
                                onClick={() => handleDeletePrompt(i)}
                                title="Xóa (Delete)"
                              >
                                <Trash2 size={13} />
                              </button>
                              <button
                                type="button"
                                className="user-action-btn"
                                onClick={() => handleEditPrompt(i, m.text)}
                                title="Chỉnh sửa (Edit)"
                              >
                                <Pencil size={13} />
                              </button>
                            </div>
                          )}

                          <div id={`chat-msg-${i}`} style={{ minWidth: 0, width: '100%' }}>
                            {m.text.includes('[OUT_OF_CONTEXT]') ? (
                              <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm flex flex-col gap-2.5 my-1">
                                <div className="flex items-center gap-2 font-semibold text-amber-300">
                                  <BookOpen size={16} />
                                  <span>Tài liệu đã chọn chưa đề cập đến nội dung này</span>
                                </div>
                                <p className="text-xs text-amber-200/90 leading-relaxed">
                                  Tài liệu bạn đã tích chọn trong môn <strong>{activeCourse.name}</strong> không có thông tin chi tiết về câu hỏi này. Bạn có thể bật chế độ <strong>Nguồn ngoài</strong> để AI tra cứu mở rộng từ kiến thức chuyên môn thực chiến.
                                </p>
                                <div className="mt-1 flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const prevUserMsg = chat.slice(0, i).reverse().find(msg => msg.role === 'user');
                                      if (prevUserMsg) {
                                        handleReAnswer(i - 1, prevUserMsg.text, true);
                                      } else {
                                        setRagMode('creative');
                                      }
                                    }}
                                    className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-medium border border-amber-500/40 transition-colors flex items-center gap-1.5 cursor-pointer"
                                  >
                                    <Globe size={13} />
                                    <span>Bật nguồn ngoài & Trả lời lại ngay</span>
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <MarkdownRenderer
                                content={m.text}
                                onAddMaterial={handleAddExternalLinkToPersonalMaterial}
                                savedUrls={savedUrls}
                              />
                            )}
                            {(() => {
                              if (!m.sources || m.sources.length === 0) return null;

                              // 1. Course document sources (Green/Emerald pills)
                              const courseSources = m.sources.filter(s => {
                                if (typeof s === 'object' && s !== null) {
                                  return s.type === 'course_material' || (!s.isExternal && !s.url && s.type !== 'extended_knowledge');
                                }
                                const str = String(s);
                                return !str.includes('➕') && !str.includes('http') && !str.toLowerCase().includes('mở rộng') && !str.toLowerCase().includes('kiểm chứng') && !str.toLowerCase().includes('external');
                              });

                              // 2. Parametric fallback / Extended knowledge indicator (Amber/Orange pill)
                              const hasFallbackSource =
                                Boolean(m.isFallback) ||
                                m.sources.some(s => typeof s === 'object' && s !== null && (s.isFallback || s.type === 'extended_knowledge')) ||
                                m.text.includes('Kiến thức mở rộng ngoài khóa học') ||
                                m.text.includes('Kiến thức mở rộng ngoài giáo trình');

                              // 3. External web sources with URLs (Blue merged pills with save action)
                              const externalWebSources = m.sources.filter(s => {
                                if (typeof s === 'object' && s !== null) {
                                  return Boolean(s.isExternal) && Boolean(s.url) && s.type !== 'extended_knowledge';
                                }
                                const str = String(s);
                                return (str.includes('➕') || str.toLowerCase().includes('kiểm chứng') || str.includes('http://') || str.includes('https://')) && !str.includes('Kiến thức mở rộng');
                              });

                              if (courseSources.length === 0 && !hasFallbackSource && externalWebSources.length === 0) return null;

                              return (
                                <div className="citations">
                                  {/* Green Course Document Badges */}
                                  {courseSources.map((s, idx) => {
                                    const isObj = typeof s === 'object' && s !== null;
                                    const rawName = isObj ? s.name : String(s);
                                    const cleanName = rawName.replace(/^(▤|\s*)+/, '').trim();
                                    const chapter = isObj && s.chapter ? ` (Chương ${s.chapter})` : '';
                                    return (
                                      <div
                                        key={`course-${cleanName}-${idx}`}
                                        className="citation-pill course-citation"
                                        title={`Tài liệu môn học được đối chiếu & bám sát: ${cleanName}${chapter}`}
                                      >
                                        <BookOpen size={12} style={{ color: '#10b981', flexShrink: 0 }} />
                                        <span className="citation-text">Nguồn: {cleanName}{chapter}</span>
                                      </div>
                                    );
                                  })}

                                  {/* Orange Extended Knowledge Fallback Badge */}
                                  {hasFallbackSource && (
                                    <div
                                      key="fallback-pill"
                                      className="citation-pill warning-citation"
                                      title="Câu trả lời sử dụng tri thức học thuật mở rộng do tài liệu môn học chưa đề cập nội dung này"
                                    >
                                      <Sparkles size={12} style={{ color: '#f59e0b', flexShrink: 0 }} />
                                      <span className="citation-text">Kiến thức tham khảo ngoài giáo trình</span>
                                    </div>
                                  )}

                                  {/* Blue External Web Badges with Save button */}
                                  {externalWebSources.map((s, idx) => {
                                    const isObj = typeof s === 'object' && s !== null;
                                    const rawName = isObj ? s.name : String(s);
                                    const cleanName = rawName.replace(/^(▤|➕|\+\s*|\[Mở rộng\])/, '').trim();
                                    const searchTarget = cleanName.replace(/^(Kiểm chứng|Nguồn mở rộng):\s*/i, '');
                                    const url = isObj && s.url ? s.url : `https://www.google.com/search?q=${encodeURIComponent(searchTarget)}`;
                                    const cleanNorm = url.trim().toLowerCase().replace(/\/+$/, '');
                                    const isSaved = Boolean(
                                      savedUrls.some(u => {
                                        const norm = u.trim().toLowerCase().replace(/\/+$/, '');
                                        return norm === cleanNorm || cleanNorm.startsWith(norm) || norm.startsWith(cleanNorm);
                                      })
                                    );

                                    return (
                                      <div key={`ext-${cleanName}-${idx}`} className="citation-pill-merged">
                                        <a
                                          className="citation-link"
                                          href={url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          title={`Mở nguồn ngoài đối chiếu & kiểm chứng: ${url}`}
                                        >
                                          <Globe size={12} style={{ color: '#38bdf8', flexShrink: 0 }} />
                                          <span className="citation-text">{cleanName}</span>
                                          <ExternalLink size={10} style={{ opacity: 0.7, flexShrink: 0 }} />
                                        </a>
                                        <span className="citation-divider" />
                                        <button
                                          type="button"
                                          onClick={() => handleAddExternalLinkToPersonalMaterial({ title: cleanName, url })}
                                          disabled={isSaved}
                                          className={`citation-action-btn ${isSaved ? 'saved' : ''}`}
                                          title={isSaved ? 'Đã có trong tài liệu môn học' : `Thêm "${cleanName}" vào tài liệu cá nhân`}
                                        >
                                          {isSaved ? (
                                            <>
                                              <Check size={11} style={{ flexShrink: 0 }} />
                                              <span>Đã lưu</span>
                                            </>
                                          ) : (
                                            <>
                                              <span>+</span>
                                            </>
                                          )}
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}

                            {/* Toolbar for AI message - ONLY show when response is complete and has text */}
                            {m.role === 'ai' && m.text.trim().length > 0 && !(loading && i === chat.length - 1) && (
                              <div
                                className="message-toolbar"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: '8px',
                                  width: '100%',
                                }}
                              >
                                {/* Left side of AI's response: Model name badge */}
                                {m.model ? (() => {
                                  const displayModel = m.model.toLowerCase().includes('datacurso')
                                    ? 'Groq GPT-OSS 120B'
                                    : m.model;
                                  const isCohere = displayModel.toLowerCase().includes('cohere');
                                  const isGemini = displayModel.toLowerCase().includes('gemini');
                                  const isGroq = displayModel.toLowerCase().includes('groq');
                                  const isCache = displayModel.toLowerCase().includes('cache') || displayModel.toLowerCase().includes('bộ nhớ đệm');

                                  return (
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
                                          ? 'rgba(168, 85, 247, 0.16)'
                                          : isGroq
                                          ? 'rgba(249, 115, 22, 0.14)'
                                          : isCache
                                          ? 'rgba(16, 185, 129, 0.16)'
                                          : 'rgba(56, 189, 248, 0.16)',
                                        color: isCohere
                                          ? '#fb7185'
                                          : isGemini
                                          ? '#c084fc'
                                          : isGroq
                                          ? '#fb923c'
                                          : isCache
                                          ? '#34d399'
                                          : '#38bdf8',
                                        border: `1px solid ${
                                          isCohere
                                            ? 'rgba(244, 63, 94, 0.35)'
                                            : isGemini
                                            ? 'rgba(168, 85, 247, 0.35)'
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
                                  );
                                })() : (
                                  <div />
                                )}

                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                  {m.finishReason === 'length' && (
                                    <button
                                      type="button"
                                      className="continue-generate-btn"
                                      onClick={() => ask('Hãy viết tiếp tục câu trả lời đang dang dở ở trên, tuyệt đối không lặp lại đoạn đã viết.')}
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
                                        background: 'linear-gradient(135deg, rgba(249, 115, 22, 0.18), rgba(234, 88, 12, 0.22))',
                                        color: '#f97316',
                                        border: '1px solid rgba(249, 115, 22, 0.4)',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s ease',
                                      }}
                                    >
                                      <Play size={11} style={{ fill: '#f97316' }} />
                                      <span>Viết tiếp</span>
                                    </button>
                                  )}

                                  <button
                                    type="button"
                                    className={`copy-message-btn ${copiedIndex === i ? 'copied' : ''}`}
                                    onClick={async () => {
                                      const el = document.getElementById(`chat-msg-${i}`);
                                      if (el) {
                                        await copyRichHtmlForWord(el, m.text);
                                      } else {
                                        await navigator.clipboard.writeText(m.text);
                                      }
                                      setCopiedIndex(i);
                                      notify('Đã sao chép nội dung câu trả lời');
                                      window.setTimeout(() => {
                                        setCopiedIndex(prev => (prev === i ? null : prev));
                                      }, 2000);
                                    }}
                                    title="Sao chép câu trả lời (hỗ trợ dán vào Word hoặc Markdown)"
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                                  >
                                    {copiedIndex === i ? <Check size={13} /> : <Copy size={13} />}
                                    <span>{copiedIndex === i ? 'Đã sao chép' : 'Sao chép'}</span>
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {loading && chat[chat.length - 1]?.role !== 'ai' && (
                      <div className="message ai">
                        <span className="bot-avatar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Sparkles size={16} />
                        </span>
                        <div className="typing">
                          <i />
                          <i />
                          <i />
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  <div className="chat-compose">
                    {/* Strategy Multi-Select Quick Chooser Bar */}
                    {!hideStrategyBar && (selectedExamResult || input.includes('kết quả bài') || input.includes('Chào Gia sư AI') || input.includes('bài kiểm tra')) && (
                      <div className="grade-strategy-toolbar">
                        <div className="grade-strategy-label-wrap">
                          <span className="grade-strategy-title">
                            <Sparkles size={13} style={{ color: '#a855f7' }} />
                            Phương pháp phản hồi:
                          </span>
                          <span className="grade-strategy-count-pill" title="Số lượng phương pháp đang kết hợp cùng lúc">
                            {selectedStrategies.length}/4
                          </span>
                          <span className="grade-strategy-hint">
                            (chọn nhiều mục)
                          </span>
                        </div>

                        <div className="grade-strategy-chips-group">
                          {GRADE_RESPONSE_STRATEGIES.map(st => {
                            const isSelected = selectedStrategies.includes(st.id);
                            return (
                              <button
                                key={st.id}
                                type="button"
                                onClick={() => {
                                  let next: GradeResponseStrategy[];
                                  if (isSelected) {
                                    if (selectedStrategies.length > 1) {
                                      next = selectedStrategies.filter(id => id !== st.id);
                                    } else {
                                      notify('Vui lòng chọn ít nhất 1 phương pháp phản hồi');
                                      return;
                                    }
                                  } else {
                                    next = [...selectedStrategies, st.id];
                                  }
                                  setSelectedStrategies(next);

                                  const targetExam =
                                    selectedExamResult ||
                                    courseExamResults.find(
                                      r => input.includes(`"${r.name}"`) || input.includes(r.name)
                                    ) ||
                                    null;

                                  if (targetExam) {
                                    const newPrompt = buildGradePrompt(
                                      targetExam,
                                      next,
                                      answerStyle,
                                      currentAnalysis ||
                                        (targetExam.attemptId
                                          ? getStoredAnalysis(targetExam.attemptId)
                                          : null)
                                    );
                                    setInput(newPrompt);
                                    notify(
                                      !isSelected
                                        ? `Đã thêm phương pháp: ${st.label}`
                                        : `Đã bỏ phương pháp: ${st.label}`
                                    );
                                  } else {
                                    notify(
                                      !isSelected
                                        ? `Đã chọn: ${st.label}`
                                        : `Đã bỏ: ${st.label}`
                                    );
                                  }
                                }}
                                className={`grade-strategy-chip-btn ${isSelected ? 'active' : ''}`}
                                title={st.description}
                              >
                                {st.id === 'roadmap' && <ListChecks size={13} />}
                                {st.id === 'deep_dive' && <BookOpen size={13} />}
                                {st.id === 'socratic' && <HelpCircle size={13} />}
                                {st.id === 'practice' && <Sparkles size={13} />}
                                <span>{st.label}</span>
                                {isSelected && (
                                  <span className="grade-strategy-chip-check">✓</span>
                                )}
                              </button>
                            );
                          })}
                        </div>

                        <button
                          type="button"
                          onClick={() => setHideStrategyBar(true)}
                          className="grade-strategy-close-btn"
                          title="Đóng thanh phương pháp phản hồi"
                          aria-label="Đóng thanh phương pháp"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    )}
                    <textarea
                      ref={chatInputRef}
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void ask();
                        }
                      }}
                      placeholder={`Đặt câu hỏi về ${activeCourse.name} từ các tài liệu đã chọn...`}
                    />
                    <div className="chat-compose-footer">
                      <div className="chat-compose-chips">                        
                        {/* 3-State RAG Mode Selector Chip */}
                        <button
                          type="button"
                          onClick={() => {
                            setRagMode(prev => {
                              const next: RagMode =
                                prev === 'strict'
                                  ? 'hybrid'
                                  : prev === 'hybrid'
                                    ? 'creative'
                                    : 'strict';
                              notify(
                                next === 'strict'
                                  ? '🔒 Chế độ Bám sát nghiêm ngặt: 100% tài liệu môn học, ngắt mạch nếu không có'
                                  : next === 'hybrid'
                                    ? '⚡ Chế độ RAG Lai: Ưu tiên tài liệu, tự động mở rộng kiến thức khi thiếu'
                                    : '🌐 Chế độ Sáng tạo: Ưu tiên tư duy thực tiễn, tra cứu & mở rộng ngoài giáo trình'
                              );
                              return next;
                            });
                          }}
                          className={`mode-indicator-chip mode-${ragMode}`}
                          title={
                            ragMode === 'strict'
                              ? 'Chế độ Bám sát (Strict RAG): 100% sự thật trong tài liệu, ngắt mạch khi thiếu (Bấm để chuyển sang RAG Lai)'
                              : ragMode === 'hybrid'
                                ? 'Chế độ RAG Lai (Hybrid RAG): Ưu tiên tài liệu, tự động bù đắp tri thức khi thiếu (Bấm để chuyển sang Sáng tạo)'
                                : 'Chế độ Sáng tạo (Creative Mode): Tự do mở rộng & liên hệ thực tiễn ngoài giáo trình (Bấm để chuyển sang Bám sát)'
                          }
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                        >
                          {ragMode === 'strict' ? (
                            <Lock size={13} style={{ color: '#f87171' }} />
                          ) : ragMode === 'hybrid' ? (
                            <Sparkles size={13} style={{ color: '#10b981' }} />
                          ) : (
                            <Globe size={13} style={{ color: '#38bdf8' }} />
                          )}
                          <span>
                            {ragMode === 'strict'
                              ? 'Bám sát: 100%'
                              : ragMode === 'hybrid'
                                ? 'RAG Lai (Ưu tiên tài liệu)'
                                : 'Sáng tạo (Nguồn ngoài)'}
                          </span>
                        </button>

                        {/* Answer Style Selector (Concise vs Detailed) */}
                        <button
                          type="button"
                          onClick={() => {
                            setAnswerStyle(prev => {
                              const next = prev === 'concise' ? 'detailed' : 'concise';
                              notify(
                                next === 'detailed'
                                  ? 'Chế độ phân tích: Chi tiết & Chuyên sâu'
                                  : 'Chế độ phân tích: Nhanh & Trọng tâm'
                              );
                              return next;
                            });
                          }}
                          className={`mode-indicator-chip ${answerStyle === 'detailed' ? 'style-detailed' : ''}`}
                          title="Chuyển đổi giữa phân tích trọng tâm và phân tích chuyên sâu"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                        >
                          {answerStyle === 'concise' ? <Zap size={13} /> : <BookOpen size={13} />}
                          <span>{answerStyle === 'concise' ? 'Nhanh / Trọng tâm' : 'Chi tiết / Chuyên sâu'}</span>
                        </button>

                        {/* AI Model Selector & Healthcheck (CHỈ HIỂN THỊ VỚI GIẢNG VIÊN ĐỂ TEST / HEALTHCHECK) */}
                        {isTeacherCourse && (
                          <select
                            value={selectedModel}
                            onChange={e => {
                              setSelectedModel(e.target.value);
                              const chosen = availableModels.find(m => m.id === e.target.value);
                              const label = e.target.value === 'auto'
                                ? 'Tự động'
                                : (chosen?.label || e.target.value);
                              notify(`[Giảng viên] Đã chọn: ${label}`);
                            }}
                            className="model-selector-chip"
                            title="Chọn model AI để kiểm tra kết nối và độ nhạy"
                            style={{
                              height: '28px',
                              fontSize: '11px',
                              fontWeight: 600,
                              borderRadius: '8px',
                              background: selectedModel !== 'auto' ? 'rgba(124, 109, 242, 0.22)' : 'rgba(255, 255, 255, 0.05)',
                              borderColor: selectedModel !== 'auto' ? 'rgba(124, 109, 242, 0.5)' : 'rgba(255, 255, 255, 0.12)',
                              color: '#e2e8f0',
                              cursor: 'pointer',
                            }}
                          >
                            <option value="auto">Model: Tự động</option>
                            {availableModels.map(m => (
                              <option key={m.id} value={m.id} disabled={m.available === false}>
                                {m.available === false ? '[Offline] ' : ''}{m.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="chat-compose-actions">
                        <button
                          type="button"
                          className="clear-chat-btn"
                          onClick={handleClearChat}
                          disabled={chat.length <= 1 || loading}
                          title="Xóa toàn bộ lịch sử trò chuyện môn học"
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
                            className="chat-send-btn"
                            onClick={() => void ask()}
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
                </>
              ) : (
                <div className="tool-workspace-container">
                  {tool === 'Trắc nghiệm' ? (
                    <QuizComponent
                      key={`quiz-${activeCourse.id}-${activeCourse.code}`}
                      courseTitle={activeCourse.name}
                      courseCode={activeCourse.code}
                      courseId={activeCourse.id}
                      selectedSources={sources.filter((_, i) => checked[i])}
                      allowExternalSource={allowExternalSource}
                      ragMode={ragMode}
                      selectedModel={selectedModel}
                      hasLmsGrades={courseExamResults.length > 0}
                      initialMode={quizInitialMode}
                      initialWeakTopics={quizInitialTopics}
                      notify={notify}
                    />
                  ) : (
                    <div className={`artifact-browser ${showArtifactList ? 'with-list' : 'focus-mode'}`}>
                      {(artifactsMap[tool] || []).length > 0 && showArtifactList && (
                        <aside className="artifact-list" aria-label="Danh sách học liệu đã lưu">
                          <div className="artifact-list-heading">
                            <span>Học liệu đã lưu</span>
                            <small>{(artifactsMap[tool] || []).length}</small>
                          </div>
                          {(artifactsMap[tool] || []).map((item, index) => (
                            <div
                              key={item.id}
                              className={`artifact-list-item ${selectedArtifactIds[tool] === item.id ? 'selected' : ''}`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedArtifactIds(prev => ({ ...prev, [tool]: item.id }));
                                  setShowArtifactList(false);
                                }}
                                className="artifact-list-select"
                              >
                                <span>{item.name || item.topic || `${tool} ${index + 1}`}</span>
                                <small>{item.level === 'simple' ? 'Cơ bản' : item.level === 'complex' ? 'Chuyên sâu' : 'Tiêu chuẩn'}</small>
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteToolArtifact(tool, item.id)}
                                title="Xóa học liệu"
                                aria-label={`Xóa ${item.name || item.topic || `${tool} ${index + 1}`}`}
                                className="artifact-list-delete"
                              >
                                <Trash2 size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={() => void renameToolArtifact(tool, item)}
                                title="Đổi tên học liệu"
                                aria-label={`Đổi tên ${item.name || item.topic || `${tool} ${index + 1}`}`}
                                className="artifact-list-rename"
                              >
                                <Pencil size={13} />
                              </button>
                            </div>
                          ))}
                        </aside>
                      )}
                      <main className="artifact-browser-content">
                        <StudyArtifact
                        key={`study-${tool}-${activeCourse.id}-${activeCourse.code}`}
                        type={tool}
                        artifact={(artifactsMap[tool] || []).find(item => item.id === selectedArtifactIds[tool]) ?? null}
                        courseTitle={activeCourse.name}
                        loading={artifactLoading}
                        selectedSourcesCount={selectedSourceNames.length}
                        onGenerate={(level, customTopic, ext, rMode) => void generateToolArtifact(tool, level, customTopic, ext, rMode)}
                        onReset={() => resetToolArtifact(tool)}
                        onOrientationChange={(artifactId, orientation) => void updateToolArtifactOrientation(tool, artifactId, orientation)}
                        onUpdateData={(artifactId, newData) => updateToolArtifactData(tool, artifactId, newData)}
                        onStop={stopArtifactGeneration}
                        copyText={copyText}
                        notify={notify}
                        />
                      </main>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
      </section>

      {/* Toast */}
      {toast && <div className="toast" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><CheckCircle2 size={15} /> {toast}</div>}

      {/* Profile Modal */}
      {profile && (
        <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setProfile(false)}>
          <section className="modal">
            <header>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <User size={18} />
                Tài khoản học viên
              </h2>
              <button onClick={() => setProfile(false)} title="Đóng">
                <X size={16} />
              </button>
            </header>
            <div className="profile-modal">
              <span className="profile-avatar large">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" />
                ) : (
                  displayName.slice(0, 2).toUpperCase()
                )}
              </span>
              <h3>{displayName}</h3>
              <p>{user?.username || 'Sinh viên'}</p>
              <div>
                <a
                  href={lmsProfileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setProfile(false)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <ShieldCheck size={14} />
                  Thông tin tài khoản
                </a>
                <button
                  onClick={handleLogout}
                  className="logout-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#ef4444' }}
                >
                  <ExternalLink size={14} />
                  Đăng xuất
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Grade History Popup Modal (Strictly for this course) */}
      {showGradeHistory && mounted && createPortal(
        <div
          className="grade-modal-overlay"
          onClick={() => setShowGradeHistory(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 4, 15, 0.82)',
            backdropFilter: 'blur(8px)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.25rem',
            animation: 'fadeIn 0.2s ease',
            overscrollBehavior: 'contain',
          }}
        >
          <div
            className="grade-modal-card"
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '720px',
              maxHeight: '86vh',
              background: 'linear-gradient(180deg, #18152e 0%, #110e22 100%)',
              border: '1px solid rgba(124, 109, 242, 0.35)',
              borderRadius: '20px',
              boxShadow: '0 25px 80px rgba(0, 0, 0, 0.7), 0 0 40px rgba(124, 109, 242, 0.18)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              overscrollBehavior: 'contain',
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '1.2rem 1.5rem',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(255, 255, 255, 0.02)',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', minWidth: 0 }}>
                <div
                  style={{
                    width: '42px',
                    height: '42px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, #7c6df2, #5a49d7)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    boxShadow: '0 4px 14px rgba(124, 109, 242, 0.45)',
                    color: '#fff',
                  }}
                >
                  <BarChart3 size={20} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#fff' }}>
                      Bảng điểm môn học
                    </h3>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '999px',
                        background: 'rgba(124, 109, 242, 0.25)',
                        border: '1px solid rgba(124, 109, 242, 0.4)',
                        color: '#c4b5fd',
                      }}
                    >
                      {courseExamResults.length} đầu điểm
                    </span>
                  </div>
                  <p
                    style={{
                      margin: '3px 0 0',
                      fontSize: '12.5px',
                      color: '#94a3b8',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {activeCourse.name} {activeCourse.code ? `(${activeCourse.code.toUpperCase()})` : ''}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowGradeHistory(false)}
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#cbd5e1',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '15px',
                  fontWeight: 600,
                  transition: 'all 0.2s ease',
                }}
                title="Đóng bảng điểm (Esc)"
              >
                <X size={15} />
              </button>
            </div>

            {/* Modal Body - Grades of THIS course only */}
            <div
              style={{
                padding: '1.25rem 1.5rem',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.9rem',
                flex: '1 1 auto',
                minHeight: 0,
                overscrollBehavior: 'contain',
              }}
            >
              {courseExamResults.length === 0 ? (
                <div
                  style={{
                    padding: '3.5rem 1rem',
                    textAlign: 'center',
                    color: '#94a3b8',
                  }}
                >
                  <FileText size={40} style={{ margin: '0 auto 0.85rem', color: '#64748b' }} />
                  <h4 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#f1f5f9' }}>
                    Chưa có đầu điểm nào cho môn học này
                  </h4>
                  <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#64748b' }}>
                    Điểm các bài kiểm tra, bài thi và nhận xét trên LMS của môn {activeCourse.name} sẽ tự động hiển thị ở đây khi được cập nhật.
                  </p>
                </div>
              ) : (
                courseExamResults.map((res, idx) => (
                  <div
                    key={`${res.id}-${res.courseId}-${idx}`}
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '14px',
                      padding: '1.1rem 1.25rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.85rem',
                    }}
                  >
                    {/* Row 1: Exam Title + Date */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                      }}
                    >
                      <div>
                        <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>
                          {res.name}
                        </h4>
                        <span style={{ fontSize: '11.5px', color: '#64748b', marginTop: '2px', display: 'inline-block' }}>
                          Loại bài: {res.itemModule || 'Kiểm tra'}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                        <span style={{ fontSize: '11.5px', color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <CalendarDays size={12} />
                          {res.gradedAt
                            ? new Date(res.gradedAt).toLocaleDateString('vi-VN', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                              })
                            : 'LMS'}
                        </span>
                        <span className={`result-status-tag ${res.passed ? 'pass' : 'fail'}`}>
                          {res.passed ? 'Đạt' : 'Cần cải thiện'}
                        </span>
                      </div>
                    </div>

                    {/* Row 2: Score + Progress track */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '12px', color: '#94a3b8' }}>Điểm số:</span>
                        <div>
                          <span
                            style={{
                              fontSize: '22px',
                              fontWeight: 800,
                              color: res.passed ? '#22c55e' : '#ef4444',
                            }}
                          >
                            {formatGrade(res.score)}
                          </span>
                          <span style={{ fontSize: '13px', color: '#64748b' }}>/{formatGrade(res.maxScore)}</span>
                        </div>
                      </div>

                      <div className="result-progress-track" style={{ height: '4px' }}>
                        <div
                          className={`result-progress-bar ${res.passed ? 'pass' : 'fail'}`}
                          style={{
                            width: `${Math.min(100, Math.max(0, (res.score / (res.maxScore || 10)) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>

                    {/* Row 3: Teacher Feedback */}
                    {res.feedback ? (
                      <div
                        style={{
                          padding: '0.65rem 0.85rem',
                          borderRadius: '10px',
                          background:
                            'linear-gradient(135deg, rgba(124, 109, 242, 0.12), rgba(90, 73, 215, 0.08))',
                          border: '1px solid rgba(124, 109, 242, 0.28)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.25rem',
                        }}
                      >
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            color: '#c4b5fd',
                            textTransform: 'uppercase',
                            letterSpacing: '0.4px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                          }}
                        >
                          <MessageSquare size={13} />
                          Nhận xét của Giảng viên:
                        </span>
                        <p
                          style={{
                            margin: 0,
                            fontSize: '13px',
                            color: '#f1f5f9',
                            fontStyle: 'italic',
                            lineHeight: '1.45',
                          }}
                        >
                          "{res.feedback}"
                        </p>
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: '0.5rem 0.85rem',
                          borderRadius: '8px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontSize: '12px',
                          color: '#94a3b8',
                        }}
                      >
                        <span style={{ fontWeight: 600, color: '#a5b4fc', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          <MessageSquare size={13} style={{ flexShrink: 0 }} />
                          <span>Nhận xét:</span>
                        </span>
                        <span style={{ color: '#cbd5e1', fontWeight: 600 }}>Chưa có nhận xét riêng</span>
                      </div>
                    )}

                    {/* Row 4: Actions */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '8px',
                        marginTop: '2px',
                      }}
                    >
                      {res.url && (
                        <a
                          href={res.url}
                          target="_blank"
                          rel="noreferrer"
                          className="result-action-link"
                          style={{ fontSize: '11px', padding: '0.4rem 0.85rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                          title="Mở trực tiếp trên LMS"
                        >
                          <span>Mở trên LMS</span>
                          <ExternalLink size={11} />
                        </a>
                      )}
                      {(() => {
                        const isAnalyzed = !!res.attemptId && analyzedAttemptIds.has(Number(res.attemptId));
                        const route = resolveGradeRoute(res, isAnalyzed);
                        return (
                          <button
                            type="button"
                            className="result-ai-btn"
                            style={{
                              fontSize: '11.5px',
                              padding: '0.4rem 0.95rem',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              background: route.buttonGradient,
                              borderColor: route.borderColor,
                            }}
                            onClick={() => handleAskAiAboutGrade(res)}
                            title={route.buttonTooltip}
                          >
                            <Sparkles size={13} />
                            <span>{route.buttonLabel}</span>
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: '0.9rem 1.5rem',
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(0, 0, 0, 0.25)',
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                Tổng cộng {courseExamResults.length} đầu điểm môn học
              </span>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Activity / Homework / Exams Modal (Simplified) */}
      {showActivityModal && mounted && createPortal(
        <div
          className="grade-modal-overlay"
          onClick={() => setShowActivityModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 4, 15, 0.82)',
            backdropFilter: 'blur(8px)',
            zIndex: 100000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.25rem',
            animation: 'fadeIn 0.2s ease',
            overscrollBehavior: 'contain',
          }}
        >
          <div
            className="grade-modal-card"
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '680px',
              maxHeight: '86vh',
              background: 'linear-gradient(180deg, #18152e 0%, #110e22 100%)',
              border: '1px solid rgba(32, 191, 169, 0.35)',
              borderRadius: '20px',
              boxShadow: '0 25px 80px rgba(0, 0, 0, 0.7), 0 0 40px rgba(32, 191, 169, 0.15)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '1.2rem 1.5rem',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(255, 255, 255, 0.02)',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', minWidth: 0 }}>
                <div
                  style={{
                    width: '42px',
                    height: '42px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, #20bfa9, #148373)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    boxShadow: '0 4px 14px rgba(32, 191, 169, 0.4)',
                    color: '#fff',
                  }}
                >
                  <CalendarCheck size={20} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#fff' }}>
                      Hoạt động & Lịch môn học
                    </h3>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '999px',
                        background: 'rgba(32, 191, 169, 0.25)',
                        border: '1px solid rgba(32, 191, 169, 0.4)',
                        color: '#6ee7b7',
                      }}
                    >
                      {courseActivities.length} hoạt động
                    </span>
                  </div>
                  <p
                    style={{
                      margin: '3px 0 0',
                      fontSize: '12.5px',
                      color: '#94a3b8',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {activeCourse.name} {activeCourse.code ? `(${activeCourse.code})` : ''}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowActivityModal(false)}
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#cbd5e1',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '15px',
                  fontWeight: 600,
                  transition: 'all 0.2s ease',
                }}
                title="Đóng cửa sổ (Esc)"
              >
                <X size={15} />
              </button>
            </div>

            {/* Modal Body */}
            <div
              style={{
                padding: '1.25rem 1.5rem',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.9rem',
                flex: '1 1 auto',
                minHeight: 0,
              }}
            >
              {courseActivities.length === 0 ? (
                <div
                  style={{
                    padding: '3.5rem 1rem',
                    textAlign: 'center',
                    color: '#94a3b8',
                  }}
                >
                  <CalendarCheck size={40} style={{ margin: '0 auto 0.85rem', color: '#475569' }} />
                  <h4 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#f1f5f9' }}>
                    Chưa có hoạt động hay hạn nộp nào
                  </h4>
                  <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#64748b' }}>
                    Các bài tập và lịch thi từ Moodle của môn {activeCourse.name} sẽ tự động hiển thị ở đây.
                  </p>
                </div>
              ) : (
                courseActivities.map((act, idx) => {
                  const date = new Date(act.timestamp);
                  const isPast = act.timestamp < Date.now();
                  const diffHours = Math.round((act.timestamp - Date.now()) / 3600000);
                  const isUrgent = !isPast && diffHours <= 48;
                  const isExam = act.type === 'exam' || act.type === 'quiz';
                  const targetLmsUrl = act.url || lmsCourseUrl;

                  return (
                    <div
                      key={`${act.id}-${idx}`}
                      style={{
                        background: 'rgba(255, 255, 255, 0.035)',
                        border: isUrgent
                          ? '1px solid rgba(239, 68, 68, 0.4)'
                          : '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: '14px',
                        padding: '1.1rem 1.25rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.85rem',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {/* Top Row: Date Badge + Title & Meta + Status */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: '0.75rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem', minWidth: 0, flex: 1 }}>
                          {/* Date Block */}
                          <div
                            style={{
                              width: '44px',
                              height: '44px',
                              borderRadius: '10px',
                              background: isUrgent
                                ? 'rgba(239, 68, 68, 0.15)'
                                : isExam
                                ? 'rgba(249, 115, 22, 0.15)'
                                : 'rgba(32, 191, 169, 0.15)',
                              border: isUrgent
                                ? '1px solid rgba(239, 68, 68, 0.35)'
                                : isExam
                                ? '1px solid rgba(249, 115, 22, 0.35)'
                                : '1px solid rgba(32, 191, 169, 0.35)',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <span
                              style={{
                                fontSize: '15px',
                                fontWeight: 800,
                                color: isUrgent ? '#f87171' : isExam ? '#fb923c' : '#20bfa9',
                                lineHeight: 1,
                              }}
                            >
                              {date.getDate().toString().padStart(2, '0')}
                            </span>
                            <span style={{ fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginTop: '2px' }}>
                              T{date.getMonth() + 1}
                            </span>
                          </div>

                          <div style={{ minWidth: 0, flex: 1 }}>
                            <h4
                              style={{
                                margin: 0,
                                fontSize: '15px',
                                fontWeight: 700,
                                color: '#f8fafc',
                              }}
                            >
                              {act.name}
                            </h4>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginTop: '4px', flexWrap: 'wrap' }}>
                              <span
                                style={{
                                  fontSize: '11px',
                                  padding: '1px 7px',
                                  borderRadius: '4px',
                                  background: isExam ? 'rgba(249, 115, 22, 0.15)' : 'rgba(56, 189, 248, 0.15)',
                                  color: isExam ? '#fb923c' : '#38bdf8',
                                  fontWeight: 600,
                                }}
                              >
                                {isExam ? 'Kiểm tra / Thi' : 'Bài tập Moodle'}
                              </span>

                              {act.openTimestamp && act.closeTimestamp ? (
                                <span style={{ fontSize: '11.5px', color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                  <Clock size={12} />
                                  {new Date(act.openTimestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} - {new Date(act.closeTimestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · {new Date(act.closeTimestamp).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                </span>
                              ) : (
                                <span style={{ fontSize: '11.5px', color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                  <Clock size={12} />
                                  {date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} · {date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Status / Countdown Tag */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {(() => {
                            const now = Date.now();
                            const closeTime = act.closeTimestamp || act.timestamp;
                            const openTime = act.openTimestamp;

                            if (closeTime < now) {
                              return (
                                <span
                                  style={{
                                    fontSize: '11px',
                                    padding: '2px 8px',
                                    borderRadius: '6px',
                                    background: 'rgba(100, 116, 139, 0.2)',
                                    color: '#94a3b8',
                                    fontWeight: 600,
                                  }}
                                >
                                  Đã kết thúc
                                </span>
                              );
                            }

                            if (openTime && now < openTime) {
                              const openDiffHours = Math.round((openTime - now) / 3600000);
                              return (
                                <span
                                  style={{
                                    fontSize: '11px',
                                    padding: '2px 8px',
                                    borderRadius: '6px',
                                    background: 'rgba(56, 189, 248, 0.15)',
                                    border: '1px solid rgba(56, 189, 248, 0.3)',
                                    color: '#38bdf8',
                                    fontWeight: 600,
                                  }}
                                >
                                  Mở sau {openDiffHours > 24 ? `${Math.ceil(openDiffHours / 24)} ngày` : `${openDiffHours}h`}
                                </span>
                              );
                            }

                            const remainingHours = Math.round((closeTime - now) / 3600000);
                            const isVeryUrgent = remainingHours <= 48;

                            return isVeryUrgent ? (
                              <span
                                style={{
                                  fontSize: '11px',
                                  padding: '2px 8px',
                                  borderRadius: '6px',
                                  background: 'rgba(239, 68, 68, 0.2)',
                                  border: '1px solid rgba(239, 68, 68, 0.35)',
                                  color: '#f87171',
                                  fontWeight: 700,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                }}
                              >
                                <Flame size={12} />
                                {remainingHours <= 0 ? 'Đang mở (sắp hết hạn)' : `Gấp (còn ${remainingHours}h)`}
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: '11px',
                                  padding: '2px 8px',
                                  borderRadius: '6px',
                                  background: 'rgba(32, 191, 169, 0.15)',
                                  color: '#20bfa9',
                                  fontWeight: 600,
                                }}
                              >
                                Còn {Math.ceil(remainingHours / 24)} ngày
                              </span>
                            );
                          })()}
                        </div>
                      </div>

                      {/* Action Bar with Exactly 2 Buttons: To Course and To LMS */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                          borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                          paddingTop: '0.65rem',
                          gap: '0.65rem',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setShowActivityModal(false);
                            notify(`Đang ở trong khóa học ${activeCourse.name}`);
                          }}
                          style={{
                            padding: '6px 14px',
                            borderRadius: '8px',
                            background: 'rgba(124, 109, 242, 0.18)',
                            border: '1px solid rgba(124, 109, 242, 0.35)',
                            color: '#c4b5fd',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                          }}
                        >
                          <BookOpen size={13} />
                          <span>Vào khóa học</span>
                        </button>

                        <a
                          href={targetLmsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            padding: '6px 14px',
                            borderRadius: '8px',
                            background: '#20bfa9',
                            border: 'none',
                            color: '#032c25',
                            fontSize: '12px',
                            fontWeight: 700,
                            textDecoration: 'none',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            cursor: 'pointer',
                          }}
                        >
                          <GraduationCap size={14} />
                          <span>Mở LMS</span>
                          <ExternalLink size={11} />
                        </a>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: '0.9rem 1.5rem',
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(0, 0, 0, 0.25)',
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                Tổng cộng {courseActivities.length} hoạt động môn học
              </span>
              <button
                type="button"
                onClick={() => setShowActivityModal(false)}
                style={{
                  padding: '5px 14px',
                  borderRadius: '7px',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: '#cbd5e1',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Đóng (Esc)
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Student Document & Resource Upload Modal */}
      {showUploadModal && mounted && createPortal(
        <div
          className="teacher-modal-backdrop"
          onClick={() => {
            if (!uploadLoading) setShowUploadModal(false);
          }}
        >
          <div
            className="teacher-modal-panel"
            style={{ width: 'min(100%, 640px)', padding: 0 }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '1.25rem 1.5rem',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'rgba(20, 18, 34, 0.95)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, #7c6df2, #5a49d7)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    flexShrink: 0,
                  }}
                >
                  <UploadCloud size={18} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#f3f2f8', fontWeight: 700 }}>
                    Thêm Nguồn Tài Liệu Học Tập
                  </h3>
                  <p style={{ margin: '0.15rem 0 0', fontSize: '0.8rem', color: '#9894ad' }}>
                    Nạp tài liệu môn học để Gia sư AI và các công cụ học tập hỗ trợ phân tích
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!uploadLoading) setShowUploadModal(false);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#9894ad',
                  fontSize: '1.25rem',
                  cursor: 'pointer',
                  padding: '0.3rem 0.5rem',
                  borderRadius: '6px',
                }}
                aria-label="Đóng"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
                {/* 3 Mode Tabs */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    background: '#141220',
                    padding: '4px',
                    borderRadius: '10px',
                    border: '1px solid #26233a',
                    gap: '4px',
                  }}
                >
                  {[
                    { id: 'file', label: 'Tải tệp lên', icon: FileText, desc: 'PDF, Word, PPTX, TXT' },
                    { id: 'url', label: 'Liên kết Web', icon: Globe, desc: 'URL, Bài viết, Tài liệu' },
                    { id: 'text', label: 'Ghi chú nhanh', icon: BookOpen, desc: 'Dán trực tiếp văn bản' },
                  ].map(tab => {
                    const isSelected = uploadTab === tab.id;
                    const Icon = tab.icon;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setUploadTab(tab.id as 'file' | 'url' | 'text')}
                        style={{
                          padding: '0.6rem 0.5rem',
                          borderRadius: '8px',
                          border: isSelected ? '1px solid rgba(124, 109, 242, 0.5)' : '1px solid transparent',
                          background: isSelected ? 'rgba(124, 109, 242, 0.2)' : 'transparent',
                          color: isSelected ? '#ffffff' : '#9894ad',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '6px',
                          fontSize: '0.85rem',
                          fontWeight: isSelected ? 600 : 500,
                          transition: 'all 0.2s ease',
                        }}
                      >
                        <Icon size={15} style={{ color: isSelected ? '#a594fd' : '#71717a' }} />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Tab 1: File Upload Dropzone */}
                {uploadTab === 'file' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <div
                      onDragOver={e => {
                        e.preventDefault();
                        setUploadDragActive(true);
                      }}
                      onDragLeave={() => setUploadDragActive(false)}
                      onDrop={e => {
                        e.preventDefault();
                        setUploadDragActive(false);
                        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                          setUploadFile(e.dataTransfer.files[0]);
                          if (!uploadFileTitle) {
                            setUploadFileTitle(e.dataTransfer.files[0].name.replace(/\.[^/.]+$/, ''));
                          }
                        }
                      }}
                      onClick={() => uploadFileInputRef.current?.click()}
                      style={{
                        padding: '1.75rem 1.25rem',
                        border: uploadDragActive ? '2px dashed #7c6df2' : '2px dashed rgba(124, 109, 242, 0.4)',
                        borderRadius: '12px',
                        background: uploadDragActive ? 'rgba(124, 109, 242, 0.15)' : 'rgba(20, 18, 34, 0.6)',
                        textAlign: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.4rem',
                      }}
                    >
                      <input
                        ref={uploadFileInputRef}
                        type="file"
                        accept=".pdf,.docx,.doc,.pptx,.ppt,.txt"
                        style={{ display: 'none' }}
                        onChange={e => {
                          if (e.target.files && e.target.files[0]) {
                            const f = e.target.files[0];
                            setUploadFile(f);
                            if (!uploadFileTitle) {
                              setUploadFileTitle(f.name.replace(/\.[^/.]+$/, ''));
                            }
                          }
                        }}
                      />

                      {uploadFile ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', maxWidth: '380px', padding: '0.65rem 0.85rem', background: '#141220', borderRadius: '10px', border: '1px solid rgba(124, 109, 242, 0.35)' }} onClick={e => e.stopPropagation()}>
                          <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(124, 109, 242, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a594fd', flexShrink: 0 }}>
                            <FileText size={18} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                            <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#f3f2f8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {uploadFile.name}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: '#9894ad' }}>
                              {(uploadFile.size / (1024 * 1024)).toFixed(2)} MB
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setUploadFile(null);
                              setUploadFileTitle('');
                            }}
                            style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px', fontSize: '1rem' }}
                            title="Xóa tệp đã chọn"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <>
                          <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(124, 109, 242, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a594fd', marginBottom: '0.2rem' }}>
                            <UploadCloud size={24} />
                          </div>
                          <strong style={{ fontSize: '0.92rem', color: '#f3f2f8' }}>
                            Kéo thả tài liệu vào đây hoặc nhấp để chọn tệp
                          </strong>
                          <p style={{ margin: 0, fontSize: '0.78rem', color: '#9894ad' }}>
                            Hỗ trợ các định dạng: PDF, Word (.docx, .doc), PowerPoint (.pptx, .ppt), TXT
                          </p>
                        </>
                      )}
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cfc8ff', marginBottom: '0.4rem' }}>
                        Tên hiển thị tài liệu (Tùy chọn):
                      </label>
                      <input
                        type="text"
                        value={uploadFileTitle}
                        onChange={e => setUploadFileTitle(e.target.value)}
                        placeholder="VD: Giáo trình Chương 3 - Cấu trúc dữ liệu..."
                        style={{
                          width: '100%',
                          padding: '0.65rem 0.85rem',
                          borderRadius: '8px',
                          background: '#141220',
                          color: '#f3f2f8',
                          border: '1px solid #26233a',
                          fontSize: '16px',
                          outline: 'none',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Tab 2: Web URL */}
                {uploadTab === 'url' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cfc8ff', marginBottom: '0.4rem' }}>
                        Địa chỉ liên kết Web (URL): <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <Globe size={16} style={{ position: 'absolute', left: '12px', color: '#9894ad' }} />
                        <input
                          type="url"
                          value={uploadUrl}
                          onChange={e => setUploadUrl(e.target.value)}
                          placeholder="https://example.com/tai-lieu-hoc-tap"
                          required
                          style={{
                            width: '100%',
                            padding: '0.65rem 0.85rem 0.65rem 36px',
                            borderRadius: '8px',
                            background: '#141220',
                            color: '#f3f2f8',
                            border: '1px solid #26233a',
                            fontSize: '16px',
                            outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      </div>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cfc8ff', marginBottom: '0.4rem' }}>
                        Tiêu đề liên kết / Tên tài liệu:
                      </label>
                      <input
                        type="text"
                        value={uploadUrlTitle}
                        onChange={e => setUploadUrlTitle(e.target.value)}
                        placeholder="VD: Tài liệu tham khảo chính thức..."
                        style={{
                          width: '100%',
                          padding: '0.65rem 0.85rem',
                          borderRadius: '8px',
                          background: '#141220',
                          color: '#f3f2f8',
                          border: '1px solid #26233a',
                          fontSize: '16px',
                          outline: 'none',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Tab 3: Text Note */}
                {uploadTab === 'text' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cfc8ff', marginBottom: '0.4rem' }}>
                        Tiêu đề ghi chú:
                      </label>
                      <input
                        type="text"
                        value={uploadTextTitle}
                        onChange={e => setUploadTextTitle(e.target.value)}
                        placeholder="VD: Tóm tắt bài giảng tuần 4..."
                        style={{
                          width: '100%',
                          padding: '0.65rem 0.85rem',
                          borderRadius: '8px',
                          background: '#141220',
                          color: '#f3f2f8',
                          border: '1px solid #26233a',
                          fontSize: '16px',
                          outline: 'none',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#cfc8ff', marginBottom: '0.4rem' }}>
                        Nội dung bài học / Ghi chép: <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <textarea
                        rows={6}
                        value={uploadTextContent}
                        onChange={e => setUploadTextContent(e.target.value)}
                        placeholder="Dán nội dung bài học, định nghĩa, ghi chép cá nhân vào đây..."
                        required
                        style={{
                          width: '100%',
                          padding: '0.75rem',
                          borderRadius: '8px',
                          background: '#141220',
                          color: '#f3f2f8',
                          border: '1px solid #26233a',
                          fontSize: '16px',
                          outline: 'none',
                          resize: 'vertical',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div
                style={{
                  padding: '1rem 1.5rem',
                  borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: '0.75rem',
                  background: 'rgba(0, 0, 0, 0.25)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  disabled={uploadLoading}
                  style={{
                    padding: '0.55rem 1.15rem',
                    borderRadius: '8px',
                    border: '1px solid #26233a',
                    background: 'transparent',
                    color: '#9894ad',
                    fontWeight: 600,
                    fontSize: '0.88rem',
                    cursor: 'pointer',
                  }}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={uploadLoading}
                  style={{
                    padding: '0.55rem 1.35rem',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'linear-gradient(135deg, #7c6df2, #5a49d7)',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: '0.88rem',
                    cursor: uploadLoading ? 'not-allowed' : 'pointer',
                    boxShadow: '0 4px 14px rgba(124, 109, 242, 0.4)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    opacity: uploadLoading ? 0.7 : 1,
                  }}
                >
                  {uploadLoading ? (
                    <>
                      <Sparkles size={14} />
                      <span>Đang xử lý tài liệu...</span>
                    </>
                  ) : (
                    <>
                      <Check size={14} />
                      <span>Thêm vào tài liệu môn học</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* Quiz Analysis Diagnosis Modal */}
      <QuizAnalysisModal
        isOpen={analysisModalOpen}
        onClose={() => {
          if (analysisLoading) {
            handleStopQuizAnalysis();
          } else {
            setAnalysisError(null);
          }
          setAnalysisModalOpen(false);
        }}
        onStop={handleStopQuizAnalysis}
        analysis={currentAnalysis}
        loading={analysisLoading}
        loadingStage={analysisLoadingStage}
        examName={selectedExamResult?.name || currentAnalysis?.quizName}
        courseName={selectedExamResult?.courseName || currentAnalysis?.courseName || activeCourse?.name}
        error={analysisError}
        onRetry={() => selectedExamResult && handleAskAiAboutGrade(selectedExamResult, false)}
        onReanalyze={() => selectedExamResult && handleAskAiAboutGrade(selectedExamResult, true)}
        onDelete={async () => {
          if (!currentAnalysis?.id && !currentAnalysis?.attemptId) return;
          const userId = user?.id || 4;
          const attemptIdToDelete = currentAnalysis.attemptId ? Number(currentAnalysis.attemptId) : null;
          const queryParams = new URLSearchParams({
            userId: String(userId),
            artifactType: 'quiz_analysis',
          });
          if (currentAnalysis.id) queryParams.set('id', currentAnalysis.id);
          if (attemptIdToDelete) queryParams.set('attemptId', String(attemptIdToDelete));

          const response = await fetch(`/api/learning-artifacts?${queryParams.toString()}`, {
            method: 'DELETE',
          });
          const data = (await response.json()) as { error?: string };
          if (!response.ok) throw new Error(data.error || 'Không thể xóa bản phân tích.');

          if (attemptIdToDelete) {
            removeStoredAnalysis(attemptIdToDelete);
            setAnalyzedAttemptIds(prev => {
              const next = new Set(prev);
              next.delete(attemptIdToDelete);
              return next;
            });
          }
          setCurrentAnalysis(null);
          setSelectedExamResult(null);
          setAnalysisModalOpen(false);
        }}
        onStartRemediation={topics => {
          setAnalysisModalOpen(false);
          setQuizInitialMode('targeted');
          setQuizInitialTopics(topics);
          setTool('Trắc nghiệm');
          notify(`Đã chuyển sang Lò ấp trắc nghiệm: Khắc phục ${topics.length} điểm mù`);
        }}
        onAskTutor={analysisData => {
          setAnalysisModalOpen(false);
          if (selectedExamResult) {
            setSelectedStrategies(['roadmap']);
            setHideStrategyBar(false);
            const prompt = buildGradePrompt(
              selectedExamResult,
              ['roadmap'],
              answerStyle,
              analysisData || currentAnalysis
            );
            setShowGradeHistory(false);
            setTool('Chat');
            setInput(prompt);
            notify('Đã nạp câu lệnh vào ô chat. Bạn có thể kiểm tra và chỉnh sửa trước khi gửi.');
          }
        }}
      />
    </main>
  );
}

/* ── Course Page Root with Suspense ──────────────────────── */

export default function CoursePage() {
  return (
    <Suspense
      fallback={
        <div className="workspace-page fade-in" style={{ padding: '2rem' }}>
          <div className="artifact artifact-loading">
            <span className="bot-avatar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={16} />
            </span>
            <h3>Đang tải không gian môn học…</h3>
          </div>
        </div>
      }
    >
      <CourseDetailContent />
    </Suspense>
  );
}