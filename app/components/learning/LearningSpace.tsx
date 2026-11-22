'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Bug,
  Fingerprint,
  LayoutGrid,
  RefreshCw,
  Shuffle,
  Target,
  X,
} from 'lucide-react';
import type { CourseSourceItem, RagMode } from '@/app/types';
import { getDailyPlayable, type DailyPlayableRecord, type PlayableType } from '@/app/lib/playable-limit';
import { QuizComponent } from '@/app/components/learning/QuizComponent';
import { SpeedMatchingGame } from '@/app/components/playable/SpeedMatchingGame';
import { SpotTheBugGame } from '@/app/components/playable/SpotTheBugGame';
import { RapidSwipeGame } from '@/app/components/playable/RapidSwipeGame';
import { CrosswordGame } from '@/app/components/playable/CrosswordGame';
import { BingoGame } from '@/app/components/playable/BingoGame';
import { MysteryConceptGame } from '@/app/components/playable/MysteryConceptGame';
import { PlayableArtwork } from '@/app/components/playable/PlayableArtwork';
import { PuterSignInPromptModal } from '@/app/components/learning/PuterSignInPromptModal';
import { checkIsPuterSignedIn, hasDismissedPuterPromptToday } from '@/app/lib/puter-client';

interface LearningSpaceProps {
  courseId: number | string | undefined;
  courseCode?: string;
  courseName: string;
  userId: number | string | undefined;
  sources?: CourseSourceItem[];
  open: boolean;
  onClose: () => void;
  ragMode?: RagMode;
  allowExternalSource?: boolean;
  selectedModel?: string;
  hasLmsGrades?: boolean;
  notify?: (msg: string) => void;
  /** Sync Puter sign-in status back to parent course page when user signs in from the prompt. */
  onPuterSignInChange?: (signedIn: boolean) => void;
  /** Open the space with the full quiz already active (remediation / deep links). */
  startWithQuiz?: boolean;
  initialQuizMode?: 'comprehensive' | 'targeted';
  initialQuizWeakTopics?: string[];
}

type Activity = 'quiz' | 'mystery' | 'speed' | 'bug' | 'swipe' | 'crossword' | 'bingo';
// The full quiz test is unlimited, so it has no daily playable record.
type LimitedActivity = Exclude<Activity, 'quiz'>;

const ACTIVITY_MAP: Record<LimitedActivity, PlayableType> = {
  mystery: 'mystery_concept',
  speed: 'speed_matching',
  bug: 'spot_the_bug',
  swipe: 'rapid_swipe',
  crossword: 'crossword',
  bingo: 'concept_bingo',
};

const ACTIVITIES: Array<{
  id: Activity;
  label: string;
  desc: string
  meta: string;
  /** RGB triplet used for the tile accent (icon, glow, illustration). */
  accent: string;
  icon: React.ElementType;
}> = [
  {
    id: 'quiz',
    label: 'Trắc nghiệm',
    desc: 'Luyện đề trắc nghiệm kèm chấm điểm và giải thích',
    meta: '',
    accent: '185, 43, 71',
    icon: Target,
  },
  {
    id: 'mystery',
    label: 'Đoán thuật ngữ',
    desc: 'Tìm thuật ngữ dựa trên các gợi ý mở dần',
    meta: '10 gợi ý',
    accent: '139, 92, 246',
    icon: Fingerprint,
  },
  {
    id: 'speed',
    label: 'Nối cặp',
    desc: 'Ghép thuật ngữ với định nghĩa tương ứng',
    meta: '45 giây · 8 cặp',
    accent: '56, 189, 248',
    icon: Shuffle,
  },
  {
    id: 'bug',
    label: 'Tìm lỗi sai',
    desc: 'Xác định lỗi sai trong câu hoặc đoạn mã',
    meta: '5 câu',
    accent: '244, 63, 94',
    icon: Bug,
  },
  {
    id: 'swipe',
    label: 'Đúng / Sai',
    desc: 'Phân loại nhanh các nhận định kiến thức',
    meta: '30 giây · 12 câu',
    accent: '245, 158, 11',
    icon: RefreshCw,
  },
  {
    id: 'crossword',
    label: 'Ô chữ',
    desc: 'Giải ô chữ từ các khái niệm trọng tâm',
    meta: '6–9 từ khóa',
    accent: '16, 185, 129',
    icon: LayoutGrid,
  },
  {
    id: 'bingo',
    label: 'Phân loại Bingo',
    desc: 'Ghép khái niệm vào đúng nhóm danh mục',
    meta: '12 danh mục',
    accent: '249, 115, 22',
    icon: BookOpen,
  },
];

export function LearningSpace({
  courseId,
  courseCode,
  courseName,
  userId,
  sources,
  open,
  onClose,
  ragMode,
  allowExternalSource,
  selectedModel,
  hasLmsGrades,
  notify,
  onPuterSignInChange,
  startWithQuiz,
  initialQuizMode,
  initialQuizWeakTopics,
}: LearningSpaceProps) {
  const hasSources = Boolean(sources && sources.length > 0);
  const [active, setActive] = useState<Activity | null>(startWithQuiz && hasSources ? 'quiz' : null);
  const [showPuterPrompt, setShowPuterPrompt] = useState(false);
  const [records, setRecords] = useState<Record<Activity, DailyPlayableRecord | null>>({
    quiz: null,
    mystery: null,
    speed: null,
    bug: null,
    swipe: null,
    crossword: null,
    bingo: null,
  });

  const refreshRecords = useCallback(() => {
    const next: Record<Activity, DailyPlayableRecord | null> = {
      quiz: null,
      mystery: null,
      speed: null,
      bug: null,
      swipe: null,
      crossword: null,
      bingo: null,
    };
    for (const a of ACTIVITIES) {
      // The full quiz test is unlimited: no daily attempt is consumed or shown.
      if (a.id === 'quiz') continue;
      const type = ACTIVITY_MAP[a.id as LimitedActivity];
      next[a.id] = getDailyPlayable(userId, courseId, type);
    }
    setRecords(next);
  }, [courseId, userId]);

  useEffect(() => {
    if (open) {
      refreshRecords();
    }
  }, [open, refreshRecords]);

  // Gợi ý đăng nhập Puter 1 lần/ngày khi vào Không gian học tập mà chưa đăng nhập Puter.
  useEffect(() => {
    if (!open) {
      setShowPuterPrompt(false);
      return;
    }
    if (hasDismissedPuterPromptToday(userId)) {
      return;
    }

    let cancelled = false;
    void checkIsPuterSignedIn(2500).then((signedIn) => {
      if (cancelled) return;
      if (signedIn) {
        onPuterSignInChange?.(true);
        return;
      }
      setShowPuterPrompt(true);
    });

    return () => {
      cancelled = true;
    };
  }, [open, userId, onPuterSignInChange]);

  if (!open) return null;

  const goBack = () => {
    setActive(null);
    refreshRecords();
  };

  const titleLabel = active ? ACTIVITIES.find((a) => a.id === active)?.label : 'Luyện tập';

  return (
    <div className="learning-space-panel">
      <PuterSignInPromptModal
        open={showPuterPrompt}
        userId={userId}
        onSignedIn={() => {
          setShowPuterPrompt(false);
          onPuterSignInChange?.(true);
          notify?.('Đã đăng nhập tài khoản Puter thành công!');
        }}
        onContinueWithoutPuter={() => {
          setShowPuterPrompt(false);
        }}
      />
      <div className="learning-space-header">
        {active ? (
          <button
            type="button"
            className="learning-space-back"
            onClick={goBack}
            title="Quay lại danh mục trò chơi"
          >
            <ArrowLeft size={16} />
            <span>{titleLabel}</span>
          </button>
        ) : (
          <div className="learning-space-title">
            <LayoutGrid size={18} />
            <span>{titleLabel}</span>
          </div>
        )}
        <button type="button" className="learning-space-close" onClick={onClose} aria-label="Đóng">
          <X size={14} />
        </button>
      </div>

      <div className="learning-space-body">
        {/* Banner cảnh báo nếu chưa chọn nguồn tài liệu nào ở sidebar bên trái */}
        {!hasSources && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 14px',
              borderRadius: '10px',
              background: 'rgba(244,63,94,0.12)',
              border: '1px solid rgba(244,63,94,0.3)',
              color: '#fda4af',
              fontSize: '12px',
            }}
          >
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>Vui lòng chọn ít nhất 1 nguồn tài liệu bên trái để tạo câu hỏi trò chơi ôn tập.</span>
          </div>
        )}

        {active ? (
          <div className="activity-view">
            {active === 'quiz' ? (
              <QuizComponent
                key={`learning-space-quiz-${courseId}-${courseCode || ''}-${sources?.length ?? 0}`}
                courseTitle={courseName}
                courseCode={courseCode}
                courseId={courseId}
                selectedSources={
                  (sources || []).map(s => ({ name: s.name, url: s.url, type: s.type }))
                }
                allowExternalSource={allowExternalSource}
                ragMode={ragMode}
                selectedModel={selectedModel}
                hasLmsGrades={hasLmsGrades}
                userId={userId}
                initialMode={initialQuizMode}
                initialWeakTopics={initialQuizWeakTopics}
                notify={notify || (() => {})}
              />
            ) : active === 'mystery' ? (
              <MysteryConceptGame
                courseId={courseId}
                courseName={courseName}
                userId={userId}
                sources={sources}
              />
            ) : active === 'speed' ? (
              <SpeedMatchingGame
                courseId={courseId}
                courseName={courseName}
                userId={userId}
                sources={sources}
              />
            ) : active === 'bug' ? (
              <SpotTheBugGame
                courseId={courseId}
                courseName={courseName}
                userId={userId}
                sources={sources}
              />
            ) : active === 'swipe' ? (
              <RapidSwipeGame
                courseId={courseId}
                courseName={courseName}
                userId={userId}
                sources={sources}
              />
            ) : active === 'crossword' ? (
              <CrosswordGame
                courseId={courseId}
                courseName={courseName}
                userId={userId}
                sources={sources}
              />
            ) : (
              <BingoGame
                courseId={courseId}
                courseName={courseName}
                userId={userId}
                sources={sources}
              />
            )}
          </div>
        ) : (
          <div className="activity-grid">
            {ACTIVITIES.map((a, i) => {
              const Icon = a.icon;
              const rec = records[a.id];
              const isCompleted = rec?.status === 'completed';
              const isInProgress = rec?.status === 'in_progress';
              const isQuiz = a.id === 'quiz';

              return (
                <button
                  key={a.id}
                  type="button"
                  className={`activity-tile${isQuiz ? ' featured' : ''}`}
                  onClick={() => hasSources && setActive(a.id)}
                  title={hasSources ? a.desc : 'Vui lòng chọn ít nhất 1 tài liệu bên trái'}
                  style={{
                    opacity: hasSources ? 1 : 0.6,
                    cursor: hasSources ? 'pointer' : 'not-allowed',
                    '--tile-accent': a.accent,
                  } as React.CSSProperties}
                >
                  <PlayableArtwork id={a.id} className="activity-tile-art" />

                  {!isQuiz && (
                    <span className="activity-tile-index" aria-hidden="true">
                      {String(i).padStart(2, '0')}
                    </span>
                  )}

                  <div className="activity-tile-main">
                    <div className="activity-tile-icon">
                      <Icon size={isQuiz ? 26 : 19} />
                    </div>
                    <div className="activity-tile-text">
                      <span className="activity-tile-label">{a.label}</span>
                      <span className="activity-tile-desc">{a.desc}</span>
                      <span className="activity-tile-meta">{a.meta}</span>
                    </div>
                  </div>

                  <div className="activity-tile-foot">
                    {isQuiz ? (
                      <>
                        <span className="activity-tile-cta">
                          Bắt đầu
                          <span aria-hidden="true">→</span>
                        </span>
                      </>
                    ) : isCompleted ? (
                      <span className="activity-tile-badge completed">
                        Đã xong {rec?.score !== undefined ? `(${rec.score}/${rec.maxScore ?? '?'})` : 'hôm nay'}
                      </span>
                    ) : isInProgress ? (
                      <span className="activity-tile-badge in-progress">Tiếp tục ván dở</span>
                    ) : (
                      <span className="activity-tile-badge available">1 lượt hôm nay</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
