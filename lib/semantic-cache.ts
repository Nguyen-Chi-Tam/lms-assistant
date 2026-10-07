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
}

export interface CacheMatchResult {
  answer: string;
  matchedQuestion: string;
  similarity: number;
  isExact: boolean;
  hitCount: number;
}

const MAX_CACHE_ENTRIES = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory LRU cache for 0ms sub-millisecond lookups
const qaMemoryCache = new Map<string, CachedQaItem>();
let totalCacheHits = 0;
let totalCacheQueries = 0;

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
      item.hitCount++;
      totalCacheHits++;
      console.log(
        `[Semantic Cache] Exact match hit for: "${rawClean.slice(0, 45)}"${
          matchesCanonical ? ` (via canonical: "${canonicalClean}")` : ''
        } (0 tokens used, 0ms)`
      );
      const cleanAnswer = stripFluff(item.answer);
      item.answer = cleanAnswer;
      return {
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
      item.hitCount++;
      totalCacheHits++;
      console.log(
        `[Semantic Cache] High token similarity (${(maxTokenSim * 100).toFixed(1)}%) hit for: "${rawClean.slice(0, 45)}"${
          tokenSimCanonical > tokenSimRaw ? ` (via canonical: "${canonicalClean}")` : ''
        }`
      );
      const cleanAnswer = stripFluff(item.answer);
      item.answer = cleanAnswer;
      return {
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
            const sim = Number(hit.similarity) || threshold;
            totalCacheHits++;
            console.log(
              `[Semantic Cache RPC Hit] "${rawClean.slice(0, 45)}" -> match ${(sim * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}% (course: ${targetCourseId})`
            );

            const cleanAnswer = stripFluff(hit.ai_response);
            // Save to memory cache for 0ms subsequent lookups
            saveToMemoryCache({
              question: rawClean,
              canonicalQuestion: canonicalClean || undefined,
              answer: cleanAnswer,
              courseId: targetCourseId,
              embedding: queryEmbed,
            });

            return {
              answer: cleanAnswer,
              matchedQuestion: rawClean,
              similarity: sim,
              isExact: sim >= 0.999,
              hitCount: 1,
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
          bestMatch.hitCount++;
          totalCacheHits++;
          console.log(
            `[Semantic Cache Memory Hit] (${(maxSim * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}%) for: "${rawClean.slice(0, 45)}" -> "${bestMatch.question.slice(0, 45)}"`
          );
          const cleanAnswer = stripFluff(bestMatch.answer);
          bestMatch.answer = cleanAnswer;
          return {
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
  question: string;
  canonicalQuestion?: string;
  normalizedQuestion?: string;
  normalizedCanonical?: string;
  answer: string;
  courseId?: string | number;
  embedding?: number[];
}): CachedQaItem {
  // Evict oldest if full
  if (qaMemoryCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = qaMemoryCache.keys().next().value;
    if (firstKey) qaMemoryCache.delete(firstKey);
  }

  const id = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
    hitCount: 0,
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

  // Do not cache personal queries
  if (isPersonalQuery(question)) return;

  // Do not cache polluted responses (internal scratchpads / word counts)
  if (isPollutedResponse(cleanAnswer)) return;

  // Check if answer indicates an error, out of context, or fallback to avoid caching invalid answers
  if (
    cleanAnswer.includes('⚠️ **Không thể kết nối API AI**') ||
    cleanAnswer.includes('Quota exceeded') ||
    cleanAnswer.includes('Rate limit') ||
    cleanAnswer.includes('[OUT_OF_CONTEXT]') ||
    cleanAnswer.includes('Tài liệu bạn đã tích chọn không đề cập') ||
    cleanAnswer.includes('không có trong tài liệu được cung cấp')
  ) {
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
      const { error } = await supabaseAdmin.from('semantic_query_cache').insert({
        course_id: targetCourseId,
        query_text: question.trim(),
        query_embedding: queryEmbedding,
        ai_response: cleanAnswer.trim(),
      });

      if (error) {
        console.warn('[Semantic Cache] Supabase insert error:', error.message);
      } else {
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
 * Purges cached query items older than the specified retention period (default: 30 days).
 * Keeps the semantic cache bounded to current active study queries and saves Supabase DB space.
 */
export async function purgeExpiredSemanticCache(retentionDays: number = 30): Promise<number> {
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffTime).toISOString();

  // 1. Purge from in-memory cache
  for (const [key, item] of qaMemoryCache.entries()) {
    if (item.createdAt < cutoffTime) {
      qaMemoryCache.delete(key);
    }
  }

  // 2. Purge from Supabase semantic_query_cache
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('semantic_query_cache')
        .delete()
        .lt('created_at', cutoffIso)
        .select('id');

      if (error) {
        console.warn('[Semantic Cache TTL] Purge error:', error.message);
        return 0;
      }

      const count = data?.length || 0;
      if (count > 0) {
        console.log(`[Semantic Cache TTL] Purged ${count} expired query cache rows older than ${retentionDays} days.`);
      }
      return count;
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
