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
export async function reformulateQueryWithGroq(
  rawQuery: string,
  options: {
    timeoutMs?: number;
    courseContext?: string;
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

  // 1. Pass-through for queries that are already concise keywords
  if (isAlreadyConcise(cleanRaw)) {
    return {
      originalQuery: cleanRaw,
      reformulatedQuery: cleanRaw,
      isReformulated: false,
      source: 'passthrough',
      latencyMs: 0,
    };
  }

  // 2. Check in-memory cache
  const cacheKey = cleanRaw.toLowerCase();
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
    const fallbackCleaned = cleanQueryRuleBased(cleanRaw);
    const result: QueryReformulationResult = {
      originalQuery: cleanRaw,
      reformulatedQuery: fallbackCleaned || cleanRaw,
      isReformulated: fallbackCleaned !== cleanRaw,
      source: 'rule_based',
      latencyMs: Date.now() - startTime,
    };
    saveToReformulationCache(cacheKey, result);
    return result;
  }

  // 4. Call Groq with ultra-compact intent extraction instructions
  const modelsToTry = [GROQ_MODEL, ...GROQ_BACKUP_MODELS];
  const systemPrompt = `Bạn là bộ lọc ngầm (Silent Intent Extractor & Query Reformulator) cho hệ thống RAG học tập LMS.
Nhiệm vụ: Chuyển câu hỏi dài dòng, vòng vo, kể lể của sinh viên thành 1 CỤM TỪ KHÓA TÌM KIẾM CỐT LÕI (Canonical Keywords) ngắn gọn để đối chiếu tài liệu giáo trình.

QUY TẮC BẮT BUỘC:
1. Loại bỏ 100% lời chào hỏi, thưa gửi, hoàn cảnh, cảm xúc (vd: "thầy ơi", "em làm cả đêm", "bị lỗi", "gấp lắm", "cho em hỏi").
2. Giữ trọn vẹn thuật ngữ kỹ thuật, tên công nghệ, khái niệm chuyên môn cốt lõi (vd: "các thư viện Java", "con trỏ mảng động C++", "thuật toán Dijkstra").
3. Nếu có thông tin chương/bài (vd: "chương 3", "lab 2"), hãy giữ lại trong cụm từ khóa.
4. CHỈ xuất cụm từ khóa (tối đa 4-8 từ). TUYỆT ĐỐI KHÔNG giải thích, KHÔNG thêm dấu ngoặc kép, KHÔNG viết câu hoàn chỉnh.
5. BẢO TOÀN NGÔN NGỮ: Giữ nguyên ngôn ngữ gốc của câu hỏi (nếu câu hỏi bằng tiếng Anh -> xuất từ khóa bằng tiếng Anh, tiếng Tây Ban Nha -> tiếng Tây Ban Nha, mặc định luôn là tiếng Việt).

Ví dụ mẫu:
- "Thầy ơi em làm bài tập cả đêm qua mà mảng động cứ bị lỗi trỏ lung tung, có tài liệu nào về các thư viện Java không ạ" -> các thư viện Java
- "Cho em hỏi trong môn này chương 3 về lập trình hướng đối tượng có những tính chất nào quan trọng vậy ạ" -> tính chất lập trình hướng đối tượng chương 3
- "Em bị crash code phần cây nhị phân tìm kiếm, bài giảng tuần 4 có nói về phép quay AVL không thầy" -> cây nhị phân tìm kiếm phép quay AVL tuần 4
- "Could you please explain how Dijkstra algorithm works in chapter 5?" -> Dijkstra algorithm chapter 5`;

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
              content: options.courseContext
                ? `Môn học: ${options.courseContext}\nCâu hỏi của sinh viên: ${cleanRaw}`
                : `Câu hỏi của sinh viên: ${cleanRaw}`,
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
