import type { QuizQuestion } from '@/app/types';

export type QuickTestType = 'multiple_choice' | 'true_false';

export type QuickTestQuestion = Omit<QuizQuestion, 'type' | 'choices' | 'answer'> & {
  type: QuickTestType;
  choices: string[];
  /** 0-based index of the single correct option. */
  answer: number;
};

export type StoredQuickTestQuestion = {
  q: string;
  type: QuickTestType;
  choices: string[];
  answer: number;
  explanation?: string;
};

export type StoredCorrectAnswer = {
  questionIndex: number;
  label: string;
  text: string;
};

export type StoredWrongQuestion = {
  q: string;
  type: QuickTestType;
  choices?: string[];
  answer?: number | string;
  userAnswer: string;
  correctAnswer?: string;
  explanation?: string;
};

export type StoredQuickTestSession = {
  courseName: string;
  savedAt: string;
  status: 'in_progress' | 'completed';
  questions: StoredQuickTestQuestion[];
  correctAnswers: StoredCorrectAnswer[];
  answers?: Record<number, string>;
  score?: number;
  total?: number;
  feedback?: string;
  recommendation?: string;
  completedAt?: string;
  wrongQuestions?: StoredWrongQuestion[];
};

export const QUICK_TEST_QUESTION_COUNT = 3;
export const QUICK_TEST_SESSION_PREFIX = 'quick-test:session:';

export function questionKey(value: string) {
  return value.trim().toLowerCase();
}

function isTrueFalseChoice(value: string) {
  const normalized = value.trim().toLowerCase();
  return ['đúng', 'sai', 'true', 'false'].includes(normalized);
}

/**
 * True/False questions must be a statement. Models sometimes emit
 * "Câu nào dưới đây là đúng...?" with Đúng/Sai choices, which is unanswerable.
 */
function isChoiceQuestionPrompt(value: string) {
  const q = value.trim();
  return (
    /^(câu|điều|lựa chọn|phát biểu|nhận định|mệnh đề|đáp án|cái)\s+nào\b/i.test(q) ||
    /^(đâu|điều gì|cái gì)\b/i.test(q)
  );
}

/** Resolves True/False answers from booleans, indexes, or Vietnamese/English labels. */
export function getTrueFalseIndex(value: unknown): number | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'false' || raw === 'sai') return 1;
  if (raw === '0' || raw === 'true' || raw === 'đúng') return 0;
  return null;
}

/**
 * Resolves the correct option index from the formats models like to emit:
 * numeric index, "2", letter "B", "B) ...", or the full choice text.
 */
export function getCorrectIndex(
  question: Pick<QuizQuestion, 'type' | 'answer' | 'choices'>,
): number | null {
  if (question.type === 'true_false') return getTrueFalseIndex(question.answer);

  const choices = (question.choices || []).map(choice => String(choice).trim());
  const raw = question.answer;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw < choices.length ? raw : null;
  }
  if (typeof raw !== 'string') return null;

  let trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip labels models often add, e.g. "Đáp án B", "Answer: C".
  trimmed = trimmed.replace(/^(?:đáp án|answer|lựa chọn|option)\s*[:\-.]?\s*/i, '').trim();
  if (!trimmed) return null;

  // Plain numeric index, e.g. "2".
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed);
    return index >= 0 && index < choices.length ? index : null;
  }

  // Letter with separator, e.g. "B", "B.", "B) ...".
  const letterMatch = trimmed.match(/^([A-Za-z])[.)]?\s*(.*)$/);
  if (letterMatch) {
    const letterIndex = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
    if (letterIndex >= 0 && letterIndex < choices.length) {
      const rest = letterMatch[2].trim().toLowerCase();
      if (!rest || choices[letterIndex].toLowerCase().includes(rest) || rest.includes(choices[letterIndex].toLowerCase())) {
        return letterIndex;
      }
    }
  }

  // Exact or contained choice text, e.g. "TCP" or "Đáp án B: TCP".
  const lower = trimmed.toLowerCase();
  const exact = choices.findIndex(choice => choice.toLowerCase() === lower);
  if (exact >= 0) return exact;
  const contained = choices.findIndex(choice => choice.toLowerCase().length > 1 && lower.includes(choice.toLowerCase()));
  return contained >= 0 ? contained : null;
}

/**
 * Keeps only single-answer questions. Classification follows punctuation:
 * a prompt ending in "?" must be a 4-choice A/B/C/D question, while a prompt
 * without "?" must be a True/False statement. Anything multi-select, matching,
 * short answer, malformed, or contradictory is dropped.
 */
export function normalizeQuickTestQuestions(
  raw: QuizQuestion[],
  limit = QUICK_TEST_QUESTION_COUNT,
): QuickTestQuestion[] {
  const normalized: QuickTestQuestion[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item.q !== 'string' || !item.q.trim()) continue;

    const key = questionKey(item.q);
    if (seen.has(key)) continue;

    const prompt = item.q.trim();
    const rawChoices = (item.choices || []).map(choice => String(choice).trim()).filter(Boolean);
    const declaredType = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    // Quy tắc phân loại: câu kết thúc bằng dấu "?" là câu hỏi trắc nghiệm A/B/C/D;
    // nội dung không có dấu "?" là mệnh đề để chọn Đúng/Sai.
    const endsWithQuestionMark = /[?？]\s*$/.test(prompt);

    if (endsWithQuestionMark) {
      // Câu hỏi bắt buộc phải có đúng 4 lựa chọn phân biệt. Một câu hỏi chỉ có
      // Đúng/Sai là dữ liệu lỗi, không được hiển thị thành câu True/False.
      if (['multiple_select', 'matching', 'short_answer'].includes(declaredType)) continue;
      if (rawChoices.length !== 4) continue;
      if (new Set(rawChoices.map(choice => choice.toLowerCase())).size !== 4) continue;

      const answer = getCorrectIndex({
        type: 'multiple_choice',
        choices: rawChoices,
        answer: item.answer,
      });
      if (answer === null) continue;

      seen.add(key);
      normalized.push({
        ...item,
        type: 'multiple_choice',
        q: prompt,
        choices: rawChoices,
        answer,
      });
      continue;
    }

    // Không có dấu "?" => chỉ chấp nhận mệnh đề Đúng/Sai.
    const looksTrueFalse =
      declaredType === 'true_false' ||
      (rawChoices.length === 2 && rawChoices.every(isTrueFalseChoice));

    // Reject "Câu nào ... đúng" statements masquerading as True/False.
    if (!looksTrueFalse || isChoiceQuestionPrompt(prompt)) continue;

    const answer = getTrueFalseIndex(item.answer);
    if (answer === null) continue;

    seen.add(key);
    normalized.push({
      ...item,
      type: 'true_false',
      q: prompt,
      choices: ['Đúng', 'Sai'],
      answer,
    });
  }

  return normalized.slice(0, limit);
}

export function isCorrect(question: QuickTestQuestion, answer: string) {
  if (!answer) return false;
  const expected = Number(question.answer);
  const given = Number(answer);
  if (Number.isFinite(given)) return given === expected;
  if (question.type === 'multiple_choice') {
    const letterIndex = answer.trim().toUpperCase().charCodeAt(0) - 65;
    return letterIndex >= 0 && letterIndex < 4 && letterIndex === expected;
  }
  const normalized = answer.trim().toLowerCase();
  return (normalized === 'đúng' && expected === 0) || (normalized === 'sai' && expected === 1);
}

/** Human-readable answer ("B. ...", "Đúng", "Sai") for feedback payloads. */
export function answerLabel(question: QuickTestQuestion, answer: string | undefined): string {
  if (answer === undefined || answer === '') return '(chưa trả lời)';
  const index = Number(answer);
  if (question.type === 'true_false') {
    if (index === 0) return 'Đúng';
    if (index === 1) return 'Sai';
    return answer;
  }
  if (Number.isInteger(index) && index >= 0 && index < question.choices.length) {
    return `${String.fromCharCode(65 + index)}. ${question.choices[index]}`;
  }
  return answer;
}

/** Correct answer in the same human-readable shape as answerLabel(). */
export function correctAnswerLabel(question: QuickTestQuestion): string {
  if (question.type === 'true_false') return question.answer === 0 ? 'Đúng' : 'Sai';
  return answerLabel(question, String(question.answer));
}

export function toStoredQuestion(question: QuickTestQuestion): StoredQuickTestQuestion {
  return {
    q: question.q,
    type: question.type,
    choices: question.choices,
    answer: question.answer,
    explanation: question.explanation,
  };
}

export function toStoredCorrectAnswers(questions: QuickTestQuestion[]): StoredCorrectAnswer[] {
  return questions.map((question, index) => ({
    questionIndex: index,
    label: correctAnswerLabel(question),
    text:
      question.type === 'true_false'
        ? question.answer === 0
          ? 'Đúng'
          : 'Sai'
        : String(question.choices[question.answer] ?? ''),
  }));
}

export function writeQuickTestSession(key: string, payload: StoredQuickTestSession) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore storage failures
  }
}
