import type { Course, CourseSourceItem, LibraryFile, QuizQuestion } from './types';

/* ── Navigation ─────────────────────────────────────────── */

export const nav = [
  ['⌂', 'Tổng quan'],
  ['✦', 'Gia sư AI'],
  ['▤', 'Khóa học'],
  ['◫', 'Thư viện'],
  ['◎', 'Luyện tập'],
];

/* ── Courses (Empty by default, loaded live from Moodle) ── */

export const baseCourses: Course[] = [];

export const courseInstructors: string[] = [];
export const courseDocCounts: number[] = [];
export const coursePracticeCounts: number[] = [];

/* ── Deadlines ───────────────────────────────────────────── */

export const fallbackDeadlines: Array<{ id: number; name: string; courseName: string; offsetMs: number }> = [];

export function makeFallbackDeadlines() {
  return [];
}

/* ── Library / Files ────────────────────────────────────── */

export const seedFiles: LibraryFile[] = [];

/* ── Course Knowledge Sources ────────────────────────────── */

export const courseSourcesMap: Record<string, CourseSourceItem[]> = {};

export function getCourseSources(courseCodeOrName: string): CourseSourceItem[] {
  return [];
}

export const tutorSources: string[] = [];
export const tutorSourcePageCounts: number[] = [];

/* ── Activity chart ─────────────────────────────────────── */

export const weeklyActivity = [42, 65, 45, 82, 60, 92, 32];
export const weekDayLabels = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

/* ── Quiz ───────────────────────────────────────────────── */

export const defaultQuiz: QuizQuestion[] = [
  {
    q: 'Trong thuật toán Minimax, nút MAX có mục tiêu gì?',
    choices: ['Chọn giá trị nhỏ nhất', 'Chọn giá trị lớn nhất', 'Chọn ngẫu nhiên', 'Cắt tỉa toàn bộ cây'],
    answer: 1,
    explanation: 'MAX chọn nước đi có giá trị tiện ích lớn nhất.',
  },
  {
    q: 'Alpha–Beta pruning giúp cải thiện điều gì?',
    choices: ['Độ chính xác', 'Kích thước trạng thái', 'Tốc độ tìm kiếm', 'Hàm heuristic'],
    answer: 2,
    explanation: 'Cắt tỉa giảm số nút cần đánh giá mà không đổi kết quả.',
  },
  {
    q: 'Điều kiện dừng thường gặp của Minimax là gì?',
    choices: ['Đạt nút lá hoặc độ sâu giới hạn', 'Hàng đợi rỗng', 'Alpha bằng 0', 'Beta bằng 1'],
    answer: 0,
    explanation: 'Minimax đánh giá tại trạng thái kết thúc hoặc giới hạn độ sâu.',
  },
];

/* ── Inspirational Quotes ───────────────────────────────── */

export const inspirationalQuotes = [
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
  { text: 'Great things are done by a series of small things brought together.', author: 'Vincent van Gogh' },
  { text: 'Success is the sum of small efforts, repeated day in and day out.', author: 'Robert Collier' },
  { text: 'The future depends on what you do today.', author: 'Mahatma Gandhi' },
  { text: 'Believe you can and you are halfway there.', author: 'Theodore Roosevelt' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'Success is a lousy teacher. It seduces smart people into thinking they cannot lose.', author: 'Bill Gates' },
  { text: 'The secret of change is to focus all of your energy on building the new.', author: 'Socrates' },
  { text: 'A person who never made a mistake never tried anything new.', author: 'Albert Einstein' },
  { text: 'Muốn ngồi ở vị trí không ai ngồi được, thì phải chịu những cảm giác không ai chịu được.', author: 'Sơn Tùng M-TP' },
  { text: 'Học, học nữa, học mãi', author: 'V.I Lenin' },
  { text: 'Có tài mà không có đức là người vô dụng, có đức mà không có tài thì làm việc gì cũng khó.', author: 'Hồ Chí Minh' },
  { text: 'Học hỏi là một việc phải tiếp tục suốt đời. Không ai có thể tự cho mình đã biết đủ rồi, biết hết rồi.', author: 'Hồ Chí Minh' },
  { text: 'Vì lợi ích mười năm thì phải trồng cây, vì lợi ích trăm năm thì phải trồng người', author: 'Hồ Chí Minh' },
  { text: 'Tiên học lễ, hậu học văn', author: 'Khổng Tử' },
  { text: 'Talent without working hard is nothing.', author: 'Cristiano Ronaldo' },
  { text: 'Success is no accident. It is hard work, perseverance, learning, studying, sacrifice and most of all, love of what you are doing or learning to do', author: 'Pelé' },
];
