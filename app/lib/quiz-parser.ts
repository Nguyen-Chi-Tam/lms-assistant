import { stripFluff } from '@/lib/ai/anti-fluff';

export interface MatchingPair {
  left: string;
  right: string;
}

export type SupportedQuizType =
  | 'multiple_choice'
  | 'true_false'
  | 'multiple_select'
  | 'matching'
  | 'short_answer';

export interface QuizQuestion {
  id?: string;
  q: string;
  type?: SupportedQuizType;
  choices?: string[];
  answer?: number | string; // 0-based index for single / true_false, or string for short answer
  answers?: number[] | string[]; // array of 0-based indices for multiple_select, or acceptable string variants for short_answer
  pairs?: MatchingPair[]; // array of { left, right } pairs for matching
  explanation: string;
}

/**
 * Recovers question objects from a possibly truncated or slightly malformed JSON
 * response. LLMs sometimes emit trailing commas, wrap JSON in markdown fences, or
 * stop mid-array; scanning for balanced `{...}` blocks keeps every question that
 * was fully emitted instead of failing the whole request with an error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function salvageQuizObjects(text: string): any[] {
  const keyMatch = text.match(/"questions"\s*:\s*\[/);
  const start = keyMatch && keyMatch.index !== undefined ? keyMatch.index + keyMatch[0].length : 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objs: any[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(text.slice(objStart, i + 1));
          if (obj && typeof obj === 'object') objs.push(obj);
        } catch {
          // incomplete object, skip
        }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return objs;
}

/**
 * Parses the AI quiz JSON defensively: direct parse, markdown unwrap, brace
 * extraction, trailing-comma repair, then object salvage.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseQuizJson(text: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extractList = (s: string): any[] | null => {
    try {
      const parsed = JSON.parse(s);
      const list = parsed?.questions || parsed?.quiz || (Array.isArray(parsed) ? parsed : []);
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  };

  const raw = text.trim();
  // 1. Direct parse
  let list = extractList(raw);
  if (list) return list;

  // 2. Unwrap ```json ... ``` markdown fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    list = extractList(fenceMatch[1]);
    if (list) return list;
  }

  // 3. Extract outermost object or array braces
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1);
    list = extractList(slice);
    if (list) return list;

    // Repair trailing commas before braces/brackets
    const repaired = slice.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001F]+/g, ' ');
    list = extractList(repaired);
    if (list) return list;
  }

  return salvageQuizObjects(text);
}

/**
 * Normalizes an array of raw question objects from any AI model (Puter, Gemini, Groq, etc.)
 * into strictly typed, valid QuizQuestion objects according to the 5 supported types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeQuizQuestions(
  rawList: any[],
  baseIndex = 0,
  seenQuestions: Set<string> = new Set()
): QuizQuestion[] {
  const result: QuizQuestion[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const qText = String(item.q || item.questionText || item.question || '').trim();
    if (!qText) continue;

    const lowerKey = qText.toLowerCase();
    if (seenQuestions.has(lowerKey)) continue;
    seenQuestions.add(lowerKey);

    const idx = baseIndex + result.length;
    const rawChoices = Array.isArray(item.choices)
      ? item.choices
      : Array.isArray(item.options)
      ? item.options
      : [];

    // 1. Matching
    if (item.type === 'matching' || (Array.isArray(item.pairs) && item.pairs.length >= 2)) {
      const rawPairs = Array.isArray(item.pairs) ? item.pairs : [];
      const validPairs = rawPairs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((p: any) => ({
          left: String(p.left || p.question || p.term || '').trim(),
          right: String(p.right || p.answer || p.definition || '').trim(),
        }))
        .filter((p: { left: string; right: string }) => p.left && p.right);

      if (validPairs.length >= 2) {
        result.push({
          id: `sq-${idx + 1}-${Date.now()}`,
          type: 'matching',
          q: qText || 'Nối các cặp khái niệm tương ứng sau:',
          pairs: validPairs,
          explanation: item.explanation ? stripFluff(String(item.explanation)) : '',
        });
        continue;
      }
    }

    // 2. Short answer
    if (item.type === 'short_answer' || item.type === 'shortanswer' || item.type === 'short_ans') {
      const rawAnswers = Array.isArray(item.answers)
        ? item.answers
        : Array.isArray(item.acceptedAnswers)
        ? item.acceptedAnswers
        : item.answer !== undefined
        ? [String(item.answer)]
        : ['Đáp án'];
      const validAnswers = (rawAnswers as unknown[]).map(s => String(s).trim()).filter(Boolean);

      result.push({
        id: `sq-${idx + 1}-${Date.now()}`,
        type: 'short_answer',
        q: qText,
        answers: validAnswers.length > 0 ? validAnswers : ['Đáp án đúng'],
        answer: validAnswers[0] || 'Đáp án đúng',
        explanation: item.explanation ? stripFluff(String(item.explanation)) : '',
      });
      continue;
    }

    // 3. True / False
    if (
      item.type === 'true_false' ||
      item.type === 'truefalse' ||
      (rawChoices.length === 2 &&
        (rawChoices[0].toLowerCase().includes('đúng') || rawChoices[0].toLowerCase().includes('true')))
    ) {
      let ans = 0;
      if (typeof item.answer === 'number') {
        ans = item.answer === 1 ? 1 : 0;
      } else if (typeof item.answer === 'boolean') {
        ans = item.answer ? 0 : 1;
      } else if (typeof item.answer === 'string') {
        const lower = item.answer.toLowerCase();
        ans = lower.includes('sai') || lower.includes('false') || lower === '1' ? 1 : 0;
      }

      result.push({
        id: `sq-${idx + 1}-${Date.now()}`,
        type: 'true_false',
        q: qText,
        choices: ['Đúng', 'Sai'],
        answer: ans,
        explanation: item.explanation ? stripFluff(String(item.explanation)) : '',
      });
      continue;
    }

    // 4. Multiple select
    if (
      item.type === 'multiple_select' ||
      item.type === 'multiselect' ||
      (Array.isArray(item.answers) && item.answers.length > 1) ||
      (Array.isArray(item.answer) && item.answer.length > 1)
    ) {
      const rawAnswers = Array.isArray(item.answers)
        ? item.answers
        : Array.isArray(item.answer)
        ? item.answer
        : [0, 1];
      const choices =
        rawChoices.length >= 2
          ? rawChoices.map(String)
          : ['Lựa chọn A', 'Lựa chọn B', 'Lựa chọn C', 'Lựa chọn D'];
      let validAnswers = rawAnswers
        .map(Number)
        .filter((n: number) => !isNaN(n) && n >= 0 && n < choices.length);

      if (validAnswers.length <= 1) {
        const remaining = [0, 1, 2, 3].filter(i => i < choices.length && !validAnswers.includes(i));
        validAnswers = [...validAnswers, remaining[0] ?? 1].slice(0, 2);
      } else if (validAnswers.length >= choices.length) {
        validAnswers = validAnswers.slice(0, Math.min(3, choices.length - 1));
      } else if (validAnswers.length > 3) {
        validAnswers = validAnswers.slice(0, 3);
      }

      result.push({
        id: `sq-${idx + 1}-${Date.now()}`,
        type: 'multiple_select',
        q: qText,
        choices,
        answers: validAnswers,
        explanation: item.explanation ? stripFluff(String(item.explanation)) : '',
      });
      continue;
    }

    // 5. Default: Multiple choice (single choice)
    const choices =
      rawChoices.length >= 4
        ? rawChoices.slice(0, 4).map(String)
        : [...rawChoices.map(String), 'Lựa chọn 1', 'Lựa chọn 2'].slice(0, 4);
    const ans = typeof item.answer === 'number' ? item.answer : 0;

    result.push({
      id: `sq-${idx + 1}-${Date.now()}`,
      type: 'multiple_choice',
      q: qText,
      choices,
      answer: Math.min(choices.length - 1, Math.max(0, ans)),
      explanation: item.explanation ? stripFluff(String(item.explanation)) : '',
    });
  }

  return result;
}
