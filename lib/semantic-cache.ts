import { generateEmbeddings, cosineSimilarity } from './rag';
import { supabaseAdmin } from './supabase';
import { stripFluff, isPollutedResponse } from './anti-fluff';

export interface CachedQaItem {
  id: string;
  courseId?: string | number;
  question: string;
  canonicalQuestion?: string;
  normalizedQuestion: string;
  normalizedCanonical?: string;
  answer: string;
  embedding?: number[];
  createdAt: number;
  hitCount: number;
  lastAccessedAt?: number;
}

export interface CacheMatchResult {
  id?: string;
  answer: string;
  matchedQuestion: string;
  similarity: number;
  isExact: boolean;
  hitCount: number;
}

const MAX_CACHE_ENTRIES = 500;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days TTL

// In-memory LRU cache for 0ms sub-millisecond lookups
const qaMemoryCache = new Map<string, CachedQaItem>();
let totalCacheHits = 0;
let totalCacheQueries = 0;

export const CACHE_REJECTION_BLACKLIST = [
  'yêu cầu cụ thể',
  'yeu cau cu the',
  'không có thông tin',
  'khong co thong tin',
  'chưa có thông tin',
  'chua co thong tin',
  'không thể trả lời',
  'khong the tra loi',
  'không tìm thấy',
  'khong tim thay',
  'không đề cập',
  'khong de cap',
  'vui lòng cung cấp thêm',
  'vui long cung cap them',
  'ngoài phạm vi',
  'ngoai pham vi',
  'tôi không biết',
  'toi khong biet',
  'tài liệu bạn đã tích chọn không',
  'tai lieu ban da tich chon khong',
  'không có trong tài liệu',
  'khong co trong tai lieu',
  'chưa đủ thông tin',
  'chua du thong tin',
  'bạn có thể cung cấp thêm',
  'ban co the cung cap them',
  'không thể kết nối',
  'quota exceeded',
  'rate limit',
  '[out_of_context]',
  // Chặn cache thông báo lỗi hệ thống/model
  'báo cáo lỗi hoạt động của model',
  'bao cao loi hoat dong cua model',
  'chế độ kiểm thử giảng viên',
  'che do kiem thu giang vien',
  'không thể kết nối api ai',
  'khong the ket noi api ai',
  'vui lòng kiểm tra lại api key',
  'vui long kiem tra lai api key',
];

function removeDiacritics(str: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Trạm kiểm dịch (Quarantine Station):
 * Luật 1: Bắt lỗi chuỗi rỗng hoặc quá ngắn (< 50 ký tự).
 * Luật 2: Kiểm duyệt từ chối / lảng tránh (Rejection Blacklist).
 * Luật 3: Chặn tuyệt đối cache các thông báo báo lỗi model / API.
 */
export function isCacheableAnswer(answer: string): boolean {
  if (!answer) return false;
  const trimmed = answer.trim();

  // Luật 1: Dưới 50 ký tự -> Từ chối (chặn "Tôi không biết", "Yêu cầu của bạn là gì?")
  if (trimmed.length < 50) {
    return false;
  }

  // Luật 2: Quét blacklist các cụm từ từ chối, thiếu thông tin và báo lỗi giảng viên
  const lower = trimmed.toLowerCase();
  const unaccented = removeDiacritics(lower);
  for (const phrase of CACHE_REJECTION_BLACKLIST) {
    if (lower.includes(phrase) || unaccented.includes(phrase)) {
      return false;
    }
  }

  return true;
}

/**
 * Bộ lọc ranh giới (Rule-based Pre-filtering cho câu hỏi):
 * 1. Cấm Cache chế độ Creative: Bỏ qua câu hỏi có tiền tố [mode:creative] hoặc mode === 'creative'.
 * 2. Cấm Cache câu hỏi quá ngắn hoặc quá dài: [10, 500] ký tự.
 * 3. Cấm Cache câu hỏi cá nhân: Điểm số cá nhân, bài làm của em, v.v.
 */
export function isCacheableQuery(query: string): boolean {
  if (!query) return false;
  const trimmed = query.trim();

  // 1. Cấm cache chế độ Creative (người dùng muốn ý tưởng mới mỗi lần)
  if (trimmed.toLowerCase().includes('[mode:creative]')) {
    return false;
  }

  // Bóc tách tiền tố [mode:...] nếu có để kiểm tra độ dài thực tế của câu hỏi
  const actualQuery = trimmed.replace(/^\[mode:[^\]]+\]\s*/i, '').trim();

  // 2. Cấm cache câu hỏi quá ngắn (< 10 ký tự) hoặc quá dài (> 500 ký tự)
  if (actualQuery.length < 10 || actualQuery.length > 500) {
    return false;
  }

  // 3. Cấm câu hỏi mang tính cá nhân
  if (isPersonalQuery(actualQuery)) {
    return false;
  }

  return true;
}

/**
 * Detects whether a question is personal (e.g. personal code reviews, grade checks, individual submissions).
 * Personal queries must bypass the cache as they are student-specific and not reusable across learners.
 */
export function isPersonalQuery(text: string): boolean {
  if (!text) return false;
  const personalRegex =
    /\b(của\s+(em|tôi|mình)|bài\s+làm(\s+này|\s+của)?|chấm\s+điểm|điểm\s+của|xem\s+điểm|sửa\s+(code|bài)|xem\s+(giúp|hộ)|check\s+giúp|chữa\s+bài|bài\s+tập\s+của|bài\s+này\s+em\s+làm|code\s+của\s+em)\b/i;
  return personalRegex.test(text);
}

/**
 * Normalizes question string for fast exact-match lookup:
 * Lowercases, strips punctuation, normalizes unicode, handles Vietnamese đ/Đ, removes extra spaces.
 */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics for broad matching
    .replace(/[đĐ]/g, 'd')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes word-level Sorensen-Dice similarity between two normalized strings.
 * Dice coefficient: 2 * |A ∩ B| / (|A| + |B|)
 */
function computeTokenSimilarity(strA: string, strB: string): number {
  const setA = new Set(strA.split(/\s+/).filter(w => w.length > 1));
  const setB = new Set(strB.split(/\s+/).filter(w => w.length > 1));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * Checks in-memory cache and Supabase semantic_query_cache via RPC `match_cached_queries`.
 * Returns the cached answer if exact match or semantic similarity >= threshold (default 0.92).
 */
export async function findCachedAnswer(options: {
  question: string;
  canonicalQuery?: string;
  courseId?: string | number;
  threshold?: number;
}): Promise<CacheMatchResult | null> {
  totalCacheQueries++;
  const { question, canonicalQuery, courseId, threshold = 0.92 } = options;
  const rawClean = question.trim();
  if (!rawClean) return null;

  // Bypass cache if query is student-personal
  if (isPersonalQuery(rawClean)) {
    return null;
  }

  const normalized = normalizeQuestion(rawClean);
  const canonicalClean = (canonicalQuery || '').trim();
  const normalizedCanonical = canonicalClean ? normalizeQuestion(canonicalClean) : '';
  const targetCourseId = String(courseId ?? 'global');
  const now = Date.now();

  // 1. Fast Path: Exact or normalized string match in memory cache (0ms)
  for (const item of qaMemoryCache.values()) {
    if (courseId !== undefined && item.courseId !== undefined && String(item.courseId) !== targetCourseId) {
      continue;
    }

    if (now - item.createdAt > CACHE_TTL_MS) {
      qaMemoryCache.delete(item.id);
      continue;
    }

    const matchesRaw = item.normalizedQuestion === normalized;
    const matchesCanonical =
      Boolean(normalizedCanonical) &&
      (item.normalizedQuestion === normalizedCanonical || item.normalizedCanonical === normalizedCanonical);

    if (matchesRaw || matchesCanonical) {
      const cleanAnswer = stripFluff(item.answer);
      if (!isCacheableAnswer(cleanAnswer)) {
        console.log(`[Semantic Cache Quarantine] Purged invalid in-memory item for: "${rawClean.slice(0, 40)}"`);
        qaMemoryCache.delete(item.id);
        continue;
      }

      item.hitCount++;
      item.lastAccessedAt = Date.now();
      totalCacheHits++;
      console.log(
        `[Semantic Cache] Exact match hit (Count: ${item.hitCount}) for: "${rawClean.slice(0, 45)}"${
          matchesCanonical ? ` (via canonical: "${canonicalClean}")` : ''
        } (0 tokens used, 0ms)`
      );

      // Async increment hit_count & update last_accessed_at in Supabase
      if (item.id && !item.id.startsWith('qa_') && supabaseAdmin) {
        Promise.resolve(
          supabaseAdmin
            .from('semantic_query_cache')
            .update({
              hit_count: item.hitCount,
              last_accessed_at: new Date().toISOString(),
            })
            .eq('id', item.id)
        ).catch(() => {});
      }

      item.answer = cleanAnswer;
      return {
        id: item.id,
        answer: cleanAnswer,
        matchedQuestion: item.question,
        similarity: 1.0,
        isExact: true,
        hitCount: item.hitCount,
      };
    }
  }

  // 2. Fast Path: High token similarity (>= threshold or >= 0.92) in memory cache
  for (const item of qaMemoryCache.values()) {
    if (courseId !== undefined && item.courseId !== undefined && String(item.courseId) !== targetCourseId) {
      continue;
    }

    const tokenSimRaw = computeTokenSimilarity(item.normalizedQuestion, normalized);
    const tokenSimCanonical =
      normalizedCanonical
        ? computeTokenSimilarity(item.normalizedCanonical || item.normalizedQuestion, normalizedCanonical)
        : 0;
    const maxTokenSim = Math.max(tokenSimRaw, tokenSimCanonical);

    if (maxTokenSim >= Math.min(threshold, 0.92)) {
      const cleanAnswer = stripFluff(item.answer);
      if (!isCacheableAnswer(cleanAnswer)) {
        console.log(`[Semantic Cache Quarantine] Purged invalid in-memory item for: "${rawClean.slice(0, 40)}"`);
        qaMemoryCache.delete(item.id);
        continue;
      }

      item.hitCount++;
      item.lastAccessedAt = Date.now();
      totalCacheHits++;
      console.log(
        `[Semantic Cache] High token similarity (${(maxTokenSim * 100).toFixed(1)}%, Count: ${item.hitCount}) hit for: "${rawClean.slice(0, 45)}"${
          tokenSimCanonical > tokenSimRaw ? ` (via canonical: "${canonicalClean}")` : ''
        }`
      );

      // Async increment hit_count & update last_accessed_at in Supabase
      if (item.id && !item.id.startsWith('qa_') && supabaseAdmin) {
        Promise.resolve(
          supabaseAdmin
            .from('semantic_query_cache')
            .update({
              hit_count: item.hitCount,
              last_accessed_at: new Date().toISOString(),
            })
            .eq('id', item.id)
        ).catch(() => {});
      }

      item.answer = cleanAnswer;
      return {
        id: item.id,
        answer: cleanAnswer,
        matchedQuestion: item.question,
        similarity: maxTokenSim,
        isExact: false,
        hitCount: item.hitCount,
      };
    }
  }

  // 3. Semantic Path: Vector search on Supabase via match_cached_queries RPC
  // Use canonical query if available for clean, noise-free vector representation
  const textToEmbed = canonicalClean && canonicalClean.length >= 3 ? canonicalClean : rawClean;

  try {
    const [queryEmbed] = await generateEmbeddings([textToEmbed]);
    if (queryEmbed && queryEmbed.length > 0) {
      if (supabaseAdmin) {
        try {
          const { data, error } = await supabaseAdmin.rpc('match_cached_queries', {
            query_vec: queryEmbed,
            target_course_id: targetCourseId,
            match_threshold: threshold,
          });

          if (!error && Array.isArray(data) && data.length > 0) {
            const hit = data[0];
            const cleanAnswer = stripFluff(hit.ai_response);

            // Quarantine Check: purge polluted old answers from DB on detection
            if (!isCacheableAnswer(cleanAnswer)) {
              console.log(
                `[Semantic Cache Quarantine] Purged polluted DB hit (id: ${hit.id}, len: ${cleanAnswer.length}) for: "${rawClean.slice(0, 40)}"`
              );
              if (hit.id) {
                Promise.resolve(supabaseAdmin.from('semantic_query_cache').delete().eq('id', hit.id)).catch(() => {});
              }
              // Treat as cache miss
              return null;
            }

            const sim = Number(hit.similarity) || threshold;
            totalCacheHits++;

            // Lookup full record to get id and current hit_count for accurate LRU tracking
            let hitId = hit.id as string | undefined;
            let currentHitCount = typeof hit.hit_count === 'number' ? hit.hit_count : 0;

            try {
              const { data: fullRow } = await supabaseAdmin
                .from('semantic_query_cache')
                .select('id, hit_count')
                .eq('course_id', targetCourseId)
                .eq('ai_response', hit.ai_response)
                .limit(1)
                .maybeSingle();

              if (fullRow) {
                hitId = fullRow.id;
                currentHitCount = Number(fullRow.hit_count) || 0;
              }
            } catch {
              // Best effort fallback
            }

            const nextHitCount = currentHitCount + 1;
            console.log(
              `[Semantic Cache RPC Hit] "${rawClean.slice(0, 45)}" -> match ${(sim * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}% (course: ${targetCourseId}, Count: ${nextHitCount})`
            );

            // Update hit_count and last_accessed_at in Supabase
            if (hitId) {
              Promise.resolve(
                supabaseAdmin
                  .from('semantic_query_cache')
                  .update({
                    hit_count: nextHitCount,
                    last_accessed_at: new Date().toISOString(),
                  })
                  .eq('id', hitId)
              ).catch(err => console.warn('[Semantic Cache] Hit count update warning:', err));
            }

            // Save to memory cache for 0ms subsequent lookups
            saveToMemoryCache({
              id: hitId,
              question: rawClean,
              canonicalQuestion: canonicalClean || undefined,
              answer: cleanAnswer,
              courseId: targetCourseId,
              embedding: queryEmbed,
              hitCount: nextHitCount,
            });

            return {
              id: hitId,
              answer: cleanAnswer,
              matchedQuestion: rawClean,
              similarity: sim,
              isExact: sim >= 0.999,
              hitCount: nextHitCount,
            };
          }
        } catch (rpcErr) {
          console.warn('[Semantic Cache] match_cached_queries RPC call warning:', rpcErr);
        }
      }

      // 4. In-memory vector cosine fallback (if DB RPC unavailable or offline dev)
      const candidatesWithEmbedding = Array.from(qaMemoryCache.values()).filter(
        item =>
          item.embedding &&
          item.embedding.length > 0 &&
          (courseId === undefined || item.courseId === undefined || String(item.courseId) === targetCourseId)
      );

      if (candidatesWithEmbedding.length > 0) {
        let bestMatch: CachedQaItem | null = null;
        let maxSim = 0;

        for (const candidate of candidatesWithEmbedding) {
          if (!candidate.embedding) continue;
          const sim = cosineSimilarity(queryEmbed, candidate.embedding);
          if (sim > maxSim) {
            maxSim = sim;
            bestMatch = candidate;
          }
        }

        if (bestMatch && maxSim >= threshold) {
          const cleanAnswer = stripFluff(bestMatch.answer);
          if (!isCacheableAnswer(cleanAnswer)) {
            console.log(`[Semantic Cache Quarantine] Purged invalid in-memory fallback item for: "${rawClean.slice(0, 40)}"`);
            qaMemoryCache.delete(bestMatch.id);
            return null;
          }

          bestMatch.hitCount++;
          bestMatch.lastAccessedAt = Date.now();
          totalCacheHits++;
          console.log(
            `[Semantic Cache Memory Hit] (${(maxSim * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}%, Count: ${bestMatch.hitCount}) for: "${rawClean.slice(0, 45)}" -> "${bestMatch.question.slice(0, 45)}"`
          );

          if (bestMatch.id && !bestMatch.id.startsWith('qa_') && supabaseAdmin) {
            Promise.resolve(
              supabaseAdmin
                .from('semantic_query_cache')
                .update({
                  hit_count: bestMatch.hitCount,
                  last_accessed_at: new Date().toISOString(),
                })
                .eq('id', bestMatch.id)
            ).catch(() => {});
          }

          bestMatch.answer = cleanAnswer;
          return {
            id: bestMatch.id,
            answer: cleanAnswer,
            matchedQuestion: bestMatch.question,
            similarity: maxSim,
            isExact: false,
            hitCount: bestMatch.hitCount,
          };
        }
      }
    }
  } catch (err) {
    console.warn('[Semantic Cache] Embedding comparison error:', err);
  }

  return null;
}

function saveToMemoryCache(params: {
  id?: string;
  question: string;
  canonicalQuestion?: string;
  normalizedQuestion?: string;
  normalizedCanonical?: string;
  answer: string;
  courseId?: string | number;
  embedding?: number[];
  hitCount?: number;
}): CachedQaItem {
  // Evict oldest if full
  if (qaMemoryCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = qaMemoryCache.keys().next().value;
    if (firstKey) qaMemoryCache.delete(firstKey);
  }

  const id = params.id || `qa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const item: CachedQaItem = {
    id,
    courseId: params.courseId,
    question: params.question,
    canonicalQuestion: params.canonicalQuestion,
    normalizedQuestion: params.normalizedQuestion || normalizeQuestion(params.question),
    normalizedCanonical:
      params.normalizedCanonical ||
      (params.canonicalQuestion ? normalizeQuestion(params.canonicalQuestion) : undefined),
    answer: params.answer,
    embedding: params.embedding,
    createdAt: Date.now(),
    hitCount: params.hitCount ?? 0,
    lastAccessedAt: Date.now(),
  };

  qaMemoryCache.set(id, item);
  return item;
}

/**
 * Stores a question-answer pair into memory cache and persists it into Supabase `semantic_query_cache`.
 */
export async function storeCachedAnswer(params: {
  question: string;
  canonicalQuery?: string;
  answer: string;
  courseId?: string | number;
  embedding?: number[];
}): Promise<void> {
  const { question, canonicalQuery, answer, courseId, embedding } = params;
  const cleanAnswer = stripFluff(answer);
  if (!question.trim() || !cleanAnswer.trim()) return;

  // ── Bộ lọc ranh giới (Rule-based Pre-filtering) ──
  // 1. Chặn câu hỏi có [mode:creative], câu hỏi ngắn < 10 ký tự hoặc dài > 500 ký tự
  // 2. Chặn câu hỏi cá nhân
  if (!isCacheableQuery(question)) {
    return;
  }

  // Do not cache polluted responses (internal scratchpads / word counts)
  if (isPollutedResponse(cleanAnswer)) return;

  // ── Trạm kiểm dịch (Quarantine Station) ──
  // Luật 1: Bắt lỗi chuỗi rỗng / ngắn (< 50 ký tự)
  // Luật 2: Kiểm duyệt nội dung từ chối / lảng tránh (Blacklist)
  // Luật 3: Chặn tuyệt đối cache các câu báo lỗi model / API giảng viên
  if (!isCacheableAnswer(cleanAnswer)) {
    console.log(
      `[Semantic Cache Quarantine] Refused caching invalid, error or deflection answer (${cleanAnswer.length} chars) for "${question.slice(0, 40)}": "${cleanAnswer.slice(0, 60)}..."`
    );
    return;
  }

  const targetCourseId = String(courseId ?? 'global');
  const normalizedQuestion = normalizeQuestion(question);
  const canonicalClean = (canonicalQuery || '').trim();
  const normalizedCanonical = canonicalClean ? normalizeQuestion(canonicalClean) : undefined;

  // 1. Save to in-memory cache
  saveToMemoryCache({
    question,
    canonicalQuestion: canonicalClean || undefined,
    normalizedQuestion,
    normalizedCanonical,
    answer: cleanAnswer,
    courseId: targetCourseId,
    embedding,
  });

  // 2. Generate embedding and persist to Supabase `semantic_query_cache`
  // Embed the canonical query if available to maintain a high-precision, noise-free vector
  const textToEmbed = canonicalClean && canonicalClean.length >= 3 ? canonicalClean : question;

  try {
    let queryEmbedding: number[] | null | undefined = embedding;
    if (!queryEmbedding || queryEmbedding.length === 0) {
      const [generatedEmbed] = await generateEmbeddings([textToEmbed]);
      if (generatedEmbed) {
        queryEmbedding = generatedEmbed;
        // Update in-memory item
        for (const item of qaMemoryCache.values()) {
          if (item.normalizedQuestion === normalizedQuestion) {
            item.embedding = generatedEmbed;
            break;
          }
        }
      }
    }

    if (supabaseAdmin && queryEmbedding && queryEmbedding.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('semantic_query_cache')
        .insert({
          course_id: targetCourseId,
          query_text: question.trim(),
          query_embedding: queryEmbedding,
          ai_response: cleanAnswer.trim(),
          hit_count: 0,
          last_accessed_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (error) {
        console.warn('[Semantic Cache] Supabase insert error:', error.message);
      } else {
        if (data?.id) {
          // Update memory item with real DB UUID
          for (const item of qaMemoryCache.values()) {
            if (item.normalizedQuestion === normalizedQuestion) {
              item.id = data.id;
              break;
            }
          }
        }
        console.log(`[Semantic Cache] Saved new answer to DB for course ${targetCourseId} ("${question.slice(0, 40)}")`);
      }
    }
  } catch (err) {
    console.warn('[Semantic Cache] Background persistence warning:', err);
  }
}

/**
 * Invalidates and purges all cached Q&A entries for a specific course.
 * Trigger this whenever course materials, syllabus, or documents are updated or deleted
 * to prevent serving stale or outdated answers to students.
 */
export async function invalidateCourseCache(courseId: string | number): Promise<void> {
  const targetCourseId = String(courseId);

  // 1. Invalidate in-memory items
  for (const [key, item] of qaMemoryCache.entries()) {
    if (String(item.courseId) === targetCourseId || String(item.courseId).startsWith(`${targetCourseId}::`)) {
      qaMemoryCache.delete(key);
    }
  }

  // 2. Purge from Supabase semantic_query_cache
  if (supabaseAdmin) {
    try {
      const { error } = await supabaseAdmin
        .from('semantic_query_cache')
        .delete()
        .like('course_id', `${targetCourseId}::%`);

      // Older cache entries used the bare course id; scoped entries use the
      // course id prefix plus source/filter fingerprint.
      const { error: legacyError } = await supabaseAdmin
        .from('semantic_query_cache')
        .delete()
        .eq('course_id', targetCourseId);

      if (error || legacyError) {
        console.warn(`[Semantic Cache] Invalidate DB error for course ${targetCourseId}:`, error?.message || legacyError?.message);
      } else {
        console.log(`[Semantic Cache] Successfully purged semantic cache for course ${targetCourseId}`);
      }
    } catch (err) {
      console.warn(`[Semantic Cache] Invalidation exception for course ${targetCourseId}:`, err);
    }
  }
}

/**
 * Vũ khí dọn dẹp & Đào thải tự động (LRU Eviction):
 * 1. Đào thải các câu hỏi chỉ hỏi 1 lần (hit_count = 0) sau 7 ngày:
 *    DELETE FROM semantic_query_cache WHERE hit_count = 0 AND created_at < NOW() - INTERVAL '7 days'
 * 2. Đào thải các câu hỏi cũ chung theo retentionDays (mặc định 30 ngày)
 * 3. Dọn sạch các phản hồi từ chối hoặc lỗi lọt lưới.
 */
export async function purgeExpiredSemanticCache(retentionDays: number = 30): Promise<number> {
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const sevenDaysCutoffTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffTime).toISOString();
  const sevenDaysCutoffIso = new Date(sevenDaysCutoffTime).toISOString();

  // 1. Purge from in-memory cache
  for (const [key, item] of qaMemoryCache.entries()) {
    const isUnpopularSevenDays = (item.hitCount === 0 || !item.hitCount) && item.createdAt < sevenDaysCutoffTime;
    const isOverRetention = item.createdAt < cutoffTime;
    if (isUnpopularSevenDays || isOverRetention || !isCacheableAnswer(item.answer)) {
      qaMemoryCache.delete(key);
    }
  }

  // 2. Purge from Supabase semantic_query_cache
  if (supabaseAdmin) {
    try {
      let totalDeleted = 0;

      // ── Luật 1: Đào thải LRU: Câu hỏi hit_count = 0 tồn tại hơn 7 ngày ──
      const { data: lruData, error: lruError } = await supabaseAdmin
        .from('semantic_query_cache')
        .delete()
        .eq('hit_count', 0)
        .lt('created_at', sevenDaysCutoffIso)
        .select('id');

      if (!lruError && lruData) {
        totalDeleted += lruData.length;
      }

      // ── Luật 2: Đào thải các câu hỏi quá cũ (hết hạn retention chung) ──
      const { data: expiredData } = await supabaseAdmin
        .from('semantic_query_cache')
        .delete()
        .lt('created_at', cutoffIso)
        .select('id');

      if (expiredData) {
        totalDeleted += expiredData.length;
      }

      // ── Luật 3: Quét sạch các câu từ chối hoặc báo lỗi giảng viên ──
      const deflectionPhrases = [
        'yêu cầu cụ thể',
        'không có thông tin',
        'không thể trả lời',
        'không tìm thấy',
        'báo cáo lỗi hoạt động của model',
        'không thể kết nối api ai',
      ];
      for (const phrase of deflectionPhrases) {
        const { data: defData } = await supabaseAdmin
          .from('semantic_query_cache')
          .delete()
          .ilike('ai_response', `%${phrase}%`)
          .select('id');
        totalDeleted += defData?.length || 0;
      }

      // ── Luật 4: Quét sạch các câu sót [mode:creative] ──
      const { data: creativeData } = await supabaseAdmin
        .from('semantic_query_cache')
        .delete()
        .ilike('query_text', '%[mode:creative]%')
        .select('id');
      totalDeleted += creativeData?.length || 0;

      if (totalDeleted > 0) {
        console.log(`[Semantic Cache LRU & TTL] Purged ${totalDeleted} expired/unpopular/invalid query cache rows.`);
      }
      return totalDeleted;
    } catch (err) {
      console.warn('[Semantic Cache TTL] Purge exception:', err);
      return 0;
    }
  }

  return 0;
}

/**
 * Returns statistics about the semantic cache.
 */
export function getSemanticCacheStats() {
  return {
    totalEntries: qaMemoryCache.size,
    totalQueries: totalCacheQueries,
    totalHits: totalCacheHits,
    hitRate: totalCacheQueries > 0 ? (totalCacheHits / totalCacheQueries) * 100 : 0,
  };
}
