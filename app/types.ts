export type Course = {
  id?: number;
  code: string;
  name: string;
  progress: number;
  color: string;
  icon: string;
  next: string;
  role?: string;
  isTeacher?: boolean;
  startdate?: number;
  lastaccess?: number;
};

export type LibraryFile = {
  id?: string;
  name: string;
  size: string;
  sizeBytes?: number;
  type: string;
  source: string;
  status: string;
};

export type CourseSourceItem = {
  id?: string;
  name: string;
  type: 'PDF' | 'DOCX' | 'PPTX' | 'LINK' | 'TXT' | string;
  sizeOrPages?: string;
  url?: string;
  content?: string;
  courseCode?: string;
  courseId?: number;
  fileId?: number;
  moduleId?: number;
  sectionId?: number;
  sectionName?: string;
  chapter?: string | number;
  isStudentUpload?: boolean;
};

export type RagMode = 'strict' | 'hybrid' | 'creative';

export type CitationSource = {
  name: string;
  isExternal?: boolean;
  type?: 'course_material' | 'external_web' | 'extended_knowledge' | string;
  url?: string;
  chapter?: string | number;
  isFallback?: boolean;
  score?: number;
};

export type ChatMessage = {
  role: 'user' | 'ai';
  text: string;
  sources?: Array<string | CitationSource>;
  model?: string;
  provider?: string;
  ragMode?: RagMode;
  isFallback?: boolean;
  finishReason?: string;
};

export type MatchingPair = {
  left: string;
  right: string;
};

export type QuizQuestion = {
  id?: string;
  q: string;
  type?: 'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer';
  choices?: string[];
  answer?: number | string;
  answers?: number[] | string[];
  pairs?: MatchingPair[];
  explanation?: string;
};

export type MoodleResource = {
  courseId?: number;
  courseCode?: string;
  courseName?: string;
  module?: string;
  moduleId?: number;
  fileId?: number;
  sectionId?: number;
  sectionName?: string;
  type?: string;
  name: string;
  url: string;
};

export type ExamResult = {
  id: number;
  courseId: number;
  courseName: string;
  courseCode?: string;
  name: string;
  itemModule?: string;
  quizId?: number;
  cmid?: number;
  attemptId?: number;
  score: number;
  maxScore: number;
  minScore?: number;
  percentage?: string;
  gradedAt?: number | null;
  feedback?: string;
  passed?: boolean;
  url?: string;
};

export type QuestionAnalysisItem = {
  slot: number;
  questionText: string;
  studentAnswer: string;
  rightAnswer: string;
  status: string; // 'Incorrect' | 'Partially correct' | string
  mark: string;
  maxmark: number;
  feedback?: string;
  explanation?: string;
  diagnosedReason?: string;
};

export type QuizAnalysisData = {
  id?: string;
  attemptId: number;
  quizId?: number;
  quizName: string;
  courseId: number;
  courseName: string;
  score: number;
  maxScore: number;
  percentage: string;
  totalQuestions: number;
  wrongCount: number;
  partialCount: number;
  weakTopics: string[];
  recommendations: string[];
  overview: string;
  questionsAnalysis: QuestionAnalysisItem[];
  analyzedAt: string;
  cached?: boolean;
};


export type MoodleData = {
  mode: 'demo' | 'live';
  courses: Array<{
    id: number;
    shortname: string;
    fullname: string;
    progress?: number;
    role?: string;
    isTeacher?: boolean;
    startdate?: number;
    lastaccess?: number;
  }>;
  deadlines: Array<{
    id: number;
    name: string;
    courseName: string;
    timestamp: number;
    url?: string;
    description?: string;
    modulename?: string;
    eventtype?: string;
  }>;
  resources: MoodleResource[];
  examResults?: ExamResult[];
  latestResult?: ExamResult | null;
  syncedAt: string;
  message?: string;
  user?: { id: number; name: string; username?: string; avatarUrl?: string | null; role?: string };
  moodleUrl?: string;
};

export type MoodleUser = {
  id: number;
  fullname: string;
  username: string;
  avatarUrl?: string | null;
  role?: string;
};

export type ErrorResponse = {
  error?: string;
};

export type TutorResponse = ErrorResponse & {
  answer?: string;
  sources?: Array<string | CitationSource>;
  finishReason?: string;
};

export type StudyToolResponse = ErrorResponse & {
  data?: unknown;
  artifactId?: string | null;
};

export type LibraryResponse = ErrorResponse & {
  documents?: Array<{
    id: string;
    name: string;
    size: number;
    contentType: string;
    source: string;
    status: string;
  }>;
  storageUsed?: number;
};

export type UploadResponse = ErrorResponse & {
  id?: string;
};

export type QuizResponse = ErrorResponse & {
  questions?: QuizQuestion[];
  mode?: string;
};

export type ManualEventItem = {
  id: string;
  moodleEventId?: number | null;
  moodleCourseId?: number | null;
  courseName?: string | null;
  eventType: string;
  title: string;
  deliverTime: string;
  timestamp: number;
  sentReminders: number[];
  eventDetails?: string | null;
  createdAt?: string;
};

