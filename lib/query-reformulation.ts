import { getGroqClient, executeWithGroqPool, GROQ_MODEL, GROQ_BACKUP_MODELS } from '@/models/groq';
import { isProviderBlocked, blockProviderUntilTomorrow, isQuotaExhaustedError } from '@/models/registry';

export interface QueryReformulationResult {
  originalQuery: string;
  reformulatedQuery: string;
  isReformulated: boolean;
  topics?: string[];
  source: 'groq' | 'rule_based' | 'passthrough';
  latencyMs?: number;
}

// In-memory LRU cache for query reformulation (prevents duplicate Groq calls)
const MAX_REFORMULATION_CACHE = 300;
const reformulationCache = new Map<string, QueryReformulationResult>();

/**
 * Regex patterns to strip common conversational fluff, pleasantries,
 * student emotional venting, and filler words in Vietnamese/English.
 */
const FLUFF_PREFIX_REGEX =
  /^(thầy\s+ơi|cô\s+ơi|dạ\s+thầy|dạ\s+cô|anh\s+ơi|chị\s+ơi|bạn\s+ơi|cho\s+(em|mình)\s+hỏi(\s+với|\s+xíu|\s+chút)?|em\s+muốn\s+hỏi(\s+về|\s+rằng)?|làm\s+ơn\s+cho\s+em\s+hỏi|nhờ\s+thầy\s+giúp|cứu\s+em\s+với|phiền\s+thầy|thưa\s+thầy|thưa\s+cô|em\s+chào\s+thầy|chào\s+thầy|xin\s+chào|hi\s+teacher|hello|please\s+help|i\s+want\s+to\s+ask)\b[:,\s-]*/gi;

const FLUFF_SUFFIX_REGEX =
  /([,\s-]+(ạ|nha|nhé|nhe|với\s+ạ|được\s+không\s+ạ|giúp\s+em\s+với\s+ạ|không\s+ạ|em\s+cảm\s+ơn|thanks|cảm\s+ơn\s+thầy|em\s+tìm\s+mãi\s+không\s+ra|gấp\s+lắm\s+ạ|em\s+đang\s+cần\s+gấp|từ\s+tối\s+tới\s+giờ))*[\.?!]*$/gi;

const STUDENT_RAMBLING_PATTERNS = [
  /em\s+làm\s+bài\s+tập(\s+lớn|\s+lab|\s+này)?\s+(cả\s+đêm|từ\s+tối|suốt\s+ngày|mấy\s+hôm)?\s*(qua)?/gi,
  /(cứ\s+bị\s+lỗi|bị\s+crash|bị\s+sai|không\s+chạy\s+được|không\s+hiểu\s+sao)\s*(trỏ\s+lung\s+tung|hoài|mãi)?/gi,
  /(có\s+tài\s+liệu\s+nào|có\s+giáo\s+trình\s+nào|có\s+bài\s+giảng\s+nào)\s*(nói\s+về|viết\s+về|liệt\s+kê|hướng\s+dẫn)?/gi,
  /(thầy\s+chỉ\s+em\s+với|giải\s+thích\s+giúp\s+em|hướng\s+dẫn\s+em)/gi,
];

/**
 * Fast rule-based query cleaning when Groq is offline or as a zero-latency fallback.
 */
export function cleanQueryRuleBased(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(FLUFF_PREFIX_REGEX, '').trim();
  cleaned = cleaned.replace(FLUFF_SUFFIX_REGEX, '').trim();

  for (const pattern of STUDENT_RAMBLING_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ').trim();
  }

  // Condense spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Checks whether a prompt needs reformulation.
 * Very short queries (e.g. "thư viện Java", "chương 2", "OOP") don't need Groq.
 */
function isAlreadyConcise(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.length <= 4 && text.length <= 30;
}

/**
 * Reformulates a noisy, conversational student prompt into a high-precision,
 * canonical search query using Groq (Llama 3 / fast OSS model) as a silent interceptor.
 *
 * Pipeline Stage 1: Intent Extraction (Rút trích ý định)
 * - Tốc độ: ~800 tokens/s (độ trễ ~80-150ms)
 * - Loại bỏ hoàn toàn nhiễu, lời kể lể, cảm xúc
 * - Bảo toàn thuật ngữ chuyên môn và số chương/bài
 */
export interface HistoryMessage {
  role: 'user' | 'assistant' | 'model' | 'ai';
  content?: string;
  text?: string;
}

const COREFERENCE_PRONOUNS_REGEX =
  /\b(chúng|chúng nó|nó|cái này|phần này|những cái này|chúng được|nó được|chúng nó được|ở đâu|tại sao|như thế nào|thế còn|còn gì nữa|được áp dụng|áp dụng cho|they|them|it|these|those)\b/i;

export function resolveCoreferenceRuleBased(query: string, history?: HistoryMessage[]): string {
  if (!history || history.length === 0) return query;
  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return query;
  const lastText = (lastUserMsg.content || lastUserMsg.text || '').trim();
  if (!lastText) return query;

  // Clean conversational prefixes from previous prompt
  const cleanLast = lastText
    .replace(/^(kể tên|hãy cho biết|cho tôi biết|cho em hỏi|liệt kê|giải thích|trình bày|so sánh)\s+/i, '')
    .trim();

  // If query starts with "chúng", "nó", "chúng được"
  const pronounMatch = query.match(/^(chúng|chúng nó|nó|cái này|những cái này)\s+(được\s+)?/i);
  if (pronounMatch) {
    const verbPart = pronounMatch[2] ? 'được ' : '';
    const rest = query.slice(pronounMatch[0].length).trim();
    return `${cleanLast} ${verbPart}${rest}`.trim();
  }

  if (COREFERENCE_PRONOUNS_REGEX.test(query)) {
    return `${cleanLast} ${query}`.trim();
  }

  return query;
}

export async function reformulateQueryWithGroq(
  rawQuery: string,
  options: {
    timeoutMs?: number;
    courseContext?: string;
    history?: HistoryMessage[];
  } = {}
): Promise<QueryReformulationResult> {
  const cleanRaw = (rawQuery || '').trim();
  if (!cleanRaw) {
    return {
      originalQuery: '',
      reformulatedQuery: '',
      isReformulated: false,
      source: 'passthrough',
      latencyMs: 0,
    };
  }

  const hasHistory = Boolean(options.history && options.history.length > 0);
  const hasCoreference = hasHistory && COREFERENCE_PRONOUNS_REGEX.test(cleanRaw);

  // 1. Pass-through for standalone queries that are already concise keywords without dangling pronouns
  if (isAlreadyConcise(cleanRaw) && !hasCoreference) {
    return {
      originalQuery: cleanRaw,
      reformulatedQuery: cleanRaw,
      isReformulated: false,
      source: 'passthrough',
      latencyMs: 0,
    };
  }

  // 2. Check in-memory cache
  const cacheKey = hasCoreference
    ? `${cleanRaw.toLowerCase()}::hist:${options.history?.slice(-2).map(h => (h.content || h.text || '').slice(0, 40)).join('|')}`
    : cleanRaw.toLowerCase();
  const cached = reformulationCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      latencyMs: 0,
    };
  }

  const startTime = Date.now();

  // 3. Check if Groq client is available
  const groqClient = getGroqClient();
  const isGroqBlocked = isProviderBlocked('groq');

  if (!groqClient || isGroqBlocked) {
    const corefResolved = hasCoreference ? resolveCoreferenceRuleBased(cleanRaw, options.history) : cleanRaw;
    const fallbackCleaned = cleanQueryRuleBased(corefResolved);
    const result: QueryReformulationResult = {
      originalQuery: cleanRaw,
      reformulatedQuery: fallbackCleaned || corefResolved,
      isReformulated: (fallbackCleaned || corefResolved) !== cleanRaw,
      source: 'rule_based',
      latencyMs: Date.now() - startTime,
    };
    saveToReformulationCache(cacheKey, result);
    return result;
  }

  // 4. Call Groq with ultra-compact intent extraction instructions
  const modelsToTry = [GROQ_MODEL, ...GROQ_BACKUP_MODELS];
  const systemPrompt = `Bạn là bộ lọc ngầm (Silent Intent Extractor & Query Reformulator) cho hệ thống RAG học tập LMS.
Nhiệm vụ: Chuyển câu hỏi của người dùng thành 1 CỤM TỪ KHÓA TÌM KIẾM CỐT LÕI (Standalone Canonical Keywords) để đối chiếu tài liệu giáo trình.

ĐẶC BIỆT KHI CÂU HỎI LÀ CÂU TIẾP NỐI TRONG HỘI THOẠI (chứa đại từ "chúng", "nó", "những cái này", "loại nào"):
- BẮT BUỘC phải thay thế các đại từ đó bằng ĐỐI TƯỢNG CỤ THỂ đang được nhắc đến trong lượt hội thoại trước đó.
- Ví dụ:
  Hội thoại trước: "Kể tên 2 loại RAG được sử dụng trong dự án"
  Câu hiện tại: "Chúng được áp dụng cho loại tài liệu nào?"
  -> 2 loại RAG áp dụng cho loại tài liệu nào

QUY TẮC BẮT BUỘC:
1. Loại bỏ 100% lời chào hỏi, thưa gửi, hoàn cảnh, cảm xúc (vd: "thầy ơi", "cho em hỏi").
2. Giữ trọn vẹn thuật ngữ kỹ thuật, tên công nghệ, khái niệm chuyên môn cốt lõi.
3. Nếu có thông tin chương/bài (vd: "chương 3", "lab 2"), hãy giữ lại trong cụm từ khóa.
4. CHỈ xuất cụm từ khóa (tối đa 5-10 từ). TUYỆT ĐỐI KHÔNG giải thích, KHÔNG thêm dấu ngoặc kép, KHÔNG viết câu hoàn chỉnh.
5. BẢO TOÀN NGÔN NGỮ: Giữ nguyên ngôn ngữ gốc của câu hỏi.`;

  let userPromptContent = `Câu hỏi của người dùng: ${cleanRaw}`;
  if (hasHistory) {
    const recentHist = options.history!
      .slice(-4)
      .map(m => `${m.role === 'user' ? 'Người dùng' : 'AI'}: ${(m.content || m.text || '').slice(0, 200)}`)
      .join('\n');
    userPromptContent = `Ngữ cảnh hội thoại trước đó:\n${recentHist}\n\nCâu hỏi hiện tại cần trích xuất cụm từ khóa tìm kiếm: ${cleanRaw}`;
  }
  if (options.courseContext) {
    userPromptContent = `Môn học: ${options.courseContext}\n\n${userPromptContent}`;
  }

  for (const modelId of modelsToTry) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 2500);

      const completion = await executeWithGroqPool(async (client) => {
        return client.chat.completions.create({
          model: modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: userPromptContent,
            },
          ],
          temperature: 0.1,
          max_tokens: 35,
        });
      }, controller.signal);

      clearTimeout(timeoutId);

      let extracted = completion.choices[0]?.message?.content?.trim() || '';
      // Strip any accidental markdown formatting or surrounding quotes
      extracted = extracted
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/^Output:\s*/i, '')
        .replace(/^Từ khóa:\s*/i, '')
        .replace(/[\r\n][\s\S]*/, '') // keep only the first line
        .trim();

      // Sanity checks: must not be empty and must be noticeably cleaner/shorter than raw query
      if (extracted && extracted.length >= 2 && extracted.length <= cleanRaw.length * 1.2) {
        const result: QueryReformulationResult = {
          originalQuery: cleanRaw,
          reformulatedQuery: extracted,
          isReformulated: extracted.toLowerCase() !== cleanRaw.toLowerCase(),
          source: 'groq',
          latencyMs: Date.now() - startTime,
        };

        console.log(
          `[Query Reformulation - Groq] "${cleanRaw.slice(0, 45)}..." -> "${extracted}" (${result.latencyMs}ms)`
        );

        saveToReformulationCache(cacheKey, result);
        return result;
      }
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        blockProviderUntilTomorrow('groq', String(err));
        break; // stop trying groq if quota exhausted
      }
      console.warn(`[Query Reformulation] Groq model ${modelId} attempt note:`, err);
    }
  }

  // 5. Fallback: Rule-based regex extraction
  const fallbackCleaned = cleanQueryRuleBased(cleanRaw);
  const fallbackResult: QueryReformulationResult = {
    originalQuery: cleanRaw,
    reformulatedQuery: fallbackCleaned || cleanRaw,
    isReformulated: fallbackCleaned !== cleanRaw,
    source: 'rule_based',
    latencyMs: Date.now() - startTime,
  };

  saveToReformulationCache(cacheKey, fallbackResult);
  return fallbackResult;
}

function saveToReformulationCache(key: string, result: QueryReformulationResult): void {
  if (reformulationCache.size >= MAX_REFORMULATION_CACHE) {
    const firstKey = reformulationCache.keys().next().value;
    if (firstKey) reformulationCache.delete(firstKey);
  }
  reformulationCache.set(key, result);
}
