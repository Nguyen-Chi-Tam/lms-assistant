import { getGeminiClient, executeWithGeminiPool } from '@/models/gemini';
import { isProviderBlocked, blockProviderUntilTomorrow, isQuotaExhaustedError } from '@/models/registry';
import { generateCloudflareEmbeddings, isCloudflareAvailable } from '@/models/cloudflare';
import { reformulateQueryWithGroq, cleanQueryRuleBased, type QueryReformulationResult } from './query-reformulation';

export interface DocumentMetadata {
  sectionId?: string | number;
  sectionName?: string;
  chapter?: string | number;
  topic?: string;
  docId?: string;
  courseId?: string | number;
  courseCode?: string;
}

export interface DocumentChunk {
  id: string;
  docTitle: string;
  text: string;
  chunkIndex: number;
  totalChunks: number;
  embedding?: number[];
  similarityScore?: number;
  rerankScore?: number;
  metadata?: DocumentMetadata;
}

export interface RawDocument {
  title: string;
  text: string;
  metadata?: DocumentMetadata;
}

export interface RetrievalOptions {
  topK?: number;
  maxTotalChars?: number;
  minSimilarity?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  // Metadata Filtering options
  filterSectionId?: string | number;
  filterSectionName?: string;
  filterChapter?: string | number;
  filterDocTitles?: string[];
  // Dynamic Top-K options
  dynamicTopK?: boolean;
  highConfidenceThreshold?: number;
  // Query Reformulation / Intent Extraction options
  searchQuery?: string;
  reformulatedQuery?: string;
  autoReformulate?: boolean;
}

export { reformulateQueryWithGroq, cleanQueryRuleBased, type QueryReformulationResult } from './query-reformulation';

// In-memory document chunk & embedding cache: hash -> DocumentChunk[]
const MAX_CACHED_DOCS = 50;
const documentIndexCache = new Map<string, DocumentChunk[]>();

/**
 * Clears document chunks & vector embeddings from RAM.
 * If docTitleOrPattern is given, only clears matching documents.
 * Otherwise, purges the entire in-memory vector cache.
 */
export function clearRagCache(docTitleOrPattern?: string): number {
  if (!docTitleOrPattern) {
    const count = documentIndexCache.size;
    documentIndexCache.clear();
    return count;
  }

  const lower = docTitleOrPattern.toLowerCase();
  let deletedCount = 0;

  for (const [key, chunks] of documentIndexCache.entries()) {
    const matchesKey = key.toLowerCase().includes(lower);
    const matchesDoc = chunks.some(c => c.docTitle.toLowerCase().includes(lower));
    if (matchesKey || matchesDoc) {
      documentIndexCache.delete(key);
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * Ensures memory usage remains bounded by evicting oldest documents if threshold is reached.
 */
function evictOldestIfNeeded(): void {
  if (documentIndexCache.size >= MAX_CACHED_DOCS) {
    const firstKey = documentIndexCache.keys().next().value;
    if (firstKey) {
      documentIndexCache.delete(firstKey);
    }
  }
}

/**
 * Generates a simple hash string for document title + content
 */
function hashDocument(title: string, text: string): string {
  let hash = 0;
  const str = `${title}:::${text.length}:::${text.slice(0, 200)}:::${text.slice(-200)}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `doc_${Math.abs(hash)}`;
}

/**
 * Extracts chapter or section number from title or text (e.g. "Chương 3", "Bài 2", "Chapter 4")
 */
export function extractChapterNumber(text: string): string | null {
  if (!text) return null;
  const match = text.match(/(?:chương|chuong|bài|bai|chapter|section|ch)\s*([0-9]+|[ivxlcdm]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function removeDiacritics(str: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Metadata Filtering ("Judge the book by its cover"):
 * Pre-filters candidate sources by matching prompt keywords against document titles,
 * URL slugs, section names, and chapter numbers BEFORE full-text fetching, chunking,
 * or requesting embeddings from Gemini.
 *
 * This saves 80-90% of Gemini embedding quota by skipping irrelevant documents
 * (e.g., when asked about "Python framework", immediately skips HTML/CSS slides and keeps
 * only the web link or guide discussing Python frameworks).
 */
export function filterSourcesByPromptMetadata<T extends {
  name: string;
  url?: string;
  sectionName?: string;
  chapter?: string | number;
}>(
  sources: T[],
  prompt: string
): T[] {
  if (!sources || sources.length <= 1 || !prompt || !prompt.trim()) {
    return sources;
  }

  const cleanPrompt = prompt.toLowerCase().trim();

  // 1. Overview / Meta queries bypass filtering (need all sources)
  const isDocOverviewQuery =
    cleanPrompt.includes('mục lục') ||
    cleanPrompt.includes('tóm tắt') ||
    cleanPrompt.includes('tổng hợp') ||
    cleanPrompt.includes('tổng quan') ||
    cleanPrompt.includes('tất cả tài liệu') ||
    cleanPrompt.includes('tài liệu trên') ||
    cleanPrompt.includes('tài liệu này') ||
    cleanPrompt.includes('bao nhiêu chương') ||
    cleanPrompt.includes('các chương') ||
    cleanPrompt.includes('nội dung của tài liệu') ||
    cleanPrompt.includes('gồm những gì') ||
    cleanPrompt.includes('table of contents') ||
    cleanPrompt.includes('overview') ||
    cleanPrompt.includes('outline');

  if (isDocOverviewQuery) {
    return sources;
  }

  // 2. Extract technical and conceptual keywords from prompt
  const stopWords = new Set([
    'ưu', 'nhược', 'điểm', 'của', 'loại', 'là', 'gì', 'như', 'thế', 'nào',
    'hãy', 'cho', 'biết', 'tại', 'sao', 'so', 'sánh', 'và', 'các', 'những',
    'một', 'có', 'không', 'được', 'trong', 'về', 'với', 'khi', 'ai', 'làm',
    'phân', 'tích', 'giải', 'thích', 'trình', 'bày', 'chi', 'tiết', 'đánh', 'giá',
    'giúp', 'tôi', 'em', 'mình', 'bạn', 'thầy', 'cô', 'xin', 'cần', 'muốn'
  ]);

  const rawTokens = tokenize(cleanPrompt);
  const keywords = rawTokens.filter(t => t.length > 1 && !stopWords.has(t));

  if (keywords.length === 0) {
    return sources;
  }

  const promptUnaccented = removeDiacritics(cleanPrompt);
  const unaccentedKeywords = keywords.map(k => removeDiacritics(k));

  // 3. Score each source by its "Cover" (name, URL slug, chapter, sectionName)
  const scoredSources: Array<{ source: T; score: number; matchReasons: string[] }> = [];

  for (const src of sources) {
    let score = 0;
    const matchReasons: string[] = [];

    const cleanName = (src.name || '').toLowerCase().replace(/\.(pdf|docx?|pptx?|html?|txt)$/i, '');
    let cleanUrlSlug = '';
    if (src.url) {
      try {
        const u = new URL(src.url);
        cleanUrlSlug = decodeURIComponent(u.pathname)
          .toLowerCase()
          .replace(/[-_+/.]/g, ' ');
      } catch {
        cleanUrlSlug = (src.url || '').toLowerCase();
      }
    }
    const cleanSection = (src.sectionName || '').toLowerCase();
    const cleanChapter = String(src.chapter || '').toLowerCase();

    const accentedCover = `${cleanName} ${cleanUrlSlug} ${cleanSection} ${cleanChapter}`;
    const unaccentedCover = removeDiacritics(accentedCover);

    // Exact keyword hits
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      const ukw = unaccentedKeywords[i];

      if (accentedCover.includes(kw) || unaccentedCover.includes(ukw)) {
        score += 3;
        matchReasons.push(kw);
      }
    }

    // Multi-word phrase hits
    for (let i = 0; i < keywords.length - 1; i++) {
      const phrase = `${keywords[i]} ${keywords[i + 1]}`;
      const uPhrase = `${unaccentedKeywords[i]} ${unaccentedKeywords[i + 1]}`;
      if (accentedCover.includes(phrase) || unaccentedCover.includes(uPhrase)) {
        score += 6;
        matchReasons.push(phrase);
      }
    }

    // Specific chapter hit if mentioned in prompt
    const promptChapter = extractChapterNumber(cleanPrompt);
    if (promptChapter && cleanChapter === promptChapter) {
      score += 10;
      matchReasons.push(`Chương ${promptChapter}`);
    }

    if (score > 0) {
      scoredSources.push({ source: src, score, matchReasons });
    }
  }

  // If any source matches the prompt keywords on its cover
  if (scoredSources.length > 0) {
    scoredSources.sort((a, b) => b.score - a.score);

    // If top match has a distinctively high score, keep top relevant sources
    const maxScore = scoredSources[0].score;
    const filtered = scoredSources
      .filter(s => s.score >= Math.max(3, maxScore * 0.35))
      .map(s => s.source);

    console.log(
      `[Metadata Filtering] "Judging book by cover": Prompt "${prompt.slice(0, 40)}..." matched ${filtered.length}/${sources.length} sources (saving ${(1 - filtered.length / sources.length) * 100}% Gemini calls): ` +
      scoredSources.map(s => `"${s.source.name}" (score: ${s.score}, hits: ${s.matchReasons.join(', ')})`).join('; ')
    );
    return filtered;
  }

  // If no source had a distinctive match on its cover, fall back to all sources
  return sources;
}

/**
 * Splits document text into overlapping chunks, respecting paragraph and sentence boundaries.
 */
export function chunkDocument(
  text: string,
  docTitle: string,
  options: { chunkSize?: number; chunkOverlap?: number; metadata?: DocumentMetadata } = {}
): DocumentChunk[] {
  const chunkSize = options.chunkSize || 650;
  const chunkOverlap = options.chunkOverlap || 120;

  const meta: DocumentMetadata = {
    ...options.metadata,
    chapter: options.metadata?.chapter || extractChapterNumber(docTitle) || undefined,
  };

  const cleanText = text.replace(/\r\n/g, '\n').trim();
  if (!cleanText) return [];

  // If text is smaller than chunk size, return as a single chunk
  if (cleanText.length <= chunkSize) {
    return [
      {
        id: `${docTitle}_chunk_0`,
        docTitle,
        text: cleanText,
        chunkIndex: 0,
        totalChunks: 1,
        metadata: meta,
      },
    ];
  }

  // Split by double newlines (paragraphs), then lines, then sentences
  const paragraphs = cleanText.split(/\n\s*\n/);
  const rawSegments: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length <= chunkSize) {
      rawSegments.push(trimmed);
    } else {
      // Split large paragraph by single newline or sentence punctuation (. ! ? ;)
      const sentences = trimmed.split(/(?<=[.!?;\n])\s+/);
      let currentBuf = '';
      for (const sent of sentences) {
        if (!sent) continue;
        if ((currentBuf + ' ' + sent).length > chunkSize && currentBuf) {
          rawSegments.push(currentBuf.trim());
          currentBuf = sent;
        } else {
          currentBuf = currentBuf ? `${currentBuf} ${sent}` : sent;
        }
      }
      if (currentBuf.trim()) {
        rawSegments.push(currentBuf.trim());
      }
    }
  }

  // Combine raw segments into target chunk size with overlap
  const chunks: string[] = [];
  let currentChunk = '';

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    if (!currentChunk) {
      currentChunk = seg;
    } else if ((currentChunk + '\n\n' + seg).length <= chunkSize) {
      currentChunk = `${currentChunk}\n\n${seg}`;
    } else {
      chunks.push(currentChunk);
      // Create overlap from the end of currentChunk
      const words = currentChunk.split(/\s+/);
      const overlapWords = words.slice(-Math.min(words.length, Math.floor(chunkOverlap / 6))).join(' ');
      currentChunk = overlapWords ? `${overlapWords}\n\n${seg}` : seg;
    }
  }

  if (currentChunk.trim() && !chunks.includes(currentChunk)) {
    chunks.push(currentChunk.trim());
  }

  return chunks.map((chunkText, idx) => ({
    id: `${docTitle}_chunk_${idx}`,
    docTitle,
    text: chunkText,
    chunkIndex: idx,
    totalChunks: chunks.length,
    metadata: meta,
  }));
}

/**
 * Computes Cosine Similarity between two numeric vectors.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Tokenizes text for BM25/TF-IDF similarity fallback
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * In-memory BM25 / TF-IDF keyword vector similarity fallback
 */
function computeBM25Score(queryTokens: string[], chunkText: string): number {
  if (queryTokens.length === 0) return 0;
  const chunkTokens = tokenize(chunkText);
  if (chunkTokens.length === 0) return 0;

  const chunkFreqMap = new Map<string, number>();
  for (const token of chunkTokens) {
    chunkFreqMap.set(token, (chunkFreqMap.get(token) || 0) + 1);
  }

  let score = 0;
  const k1 = 1.2;
  const b = 0.75;
  const avgDocLen = 80;
  const docLen = chunkTokens.length;

  for (const qToken of queryTokens) {
    const tf = chunkFreqMap.get(qToken) || 0;
    if (tf > 0) {
      // BM25 term weighting
      const idf = Math.log(1 + 10 / 1); // standard boost for present query terms
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
      score += idf * (numerator / denominator);
    }
  }

  // Normalize score between 0 and 1
  return Math.min(1, score / (queryTokens.length * 2.5));
}

/**
 * Generates vector embeddings for a list of texts using Gemini, OpenAI, or falls back to BM25.
 */
// In-memory text embedding cache to prevent re-embedding identical text fragments
const textEmbeddingCache = new Map<string, number[]>();
let geminiEmbeddingCooldownUntil = 0;

/**
 * Generates vector embeddings for a list of texts using Gemini, or falls back to BM25.
 */
export async function generateEmbeddings(texts: string[]): Promise<Array<number[] | null>> {
  if (!texts || texts.length === 0) return [];

  const results: Array<number[] | null> = new Array(texts.length).fill(null);
  const uncachedIndices: number[] = [];

  // 1. Resolve from in-memory cache first
  texts.forEach((text, idx) => {
    const trimmed = text.slice(0, 1000).trim();
    if (trimmed && textEmbeddingCache.has(trimmed)) {
      results[idx] = textEmbeddingCache.get(trimmed)!;
    } else {
      uncachedIndices.push(idx);
    }
  });

  if (uncachedIndices.length === 0) {
    return results;
  }

  // 2. Try Gemini embedding if not in temporary embedding cooldown
  const now = Date.now();
  if (now >= geminiEmbeddingCooldownUntil && !isProviderBlocked('gemini')) {
    try {
      // Process in small batches of 6 with gentle pacing to respect free-tier 100 RPM quota
      for (let i = 0; i < uncachedIndices.length; i += 6) {
        const batchIndices = uncachedIndices.slice(i, i + 6);
        const batchTexts = batchIndices.map(idx => texts[idx]);

        const batchRes = await executeWithGeminiPool(async (client) => {
          const batchPromises = batchTexts.map(async text => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const res = await (client.models as any).embedContent({
                model: 'gemini-embedding-001',
                contents: text.slice(0, 2048),
                config: {
                  outputDimensionality: 768,
                },
              });
              const vec = res.embeddings?.[0]?.values || res.embedding?.values || null;
              return (vec as number[]) || null;
            } catch (innerErr) {
              if (isQuotaExhaustedError(innerErr)) {
                throw innerErr; // trigger key rotation in executeWithGeminiPool
              }
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const fbRes = await (client.models as any).embedContent({
                  model: 'text-embedding-004',
                  contents: text.slice(0, 2048),
                });
                const vec = fbRes.embeddings?.[0]?.values || fbRes.embedding?.values || null;
                return (vec as number[]) || null;
              } catch {
                return null;
              }
            }
          });
          return await Promise.all(batchPromises);
        });

        batchRes.forEach((vec, bIdx) => {
          const originalIdx = batchIndices[bIdx];
          if (vec) {
            results[originalIdx] = vec;
            const cacheKey = texts[originalIdx].slice(0, 1000).trim();
            if (cacheKey) textEmbeddingCache.set(cacheKey, vec);
          }
        });

        // Small 80ms breathing room between batches to prevent quota burst
        if (i + 6 < uncachedIndices.length) {
          await new Promise(r => setTimeout(r, 80));
        }
      }

      if (results.some(r => r !== null)) {
        return results;
      }
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        geminiEmbeddingCooldownUntil = Date.now() + 25000;
        console.warn('[Gemini Embedding] Embedding quota exceeded. Pausing Gemini embeddings for 25s (Chat generation remains active).');
      } else {
        console.warn('Gemini embedding failed, trying Cloudflare AI:', err);
      }
    }
  }

  // 3. Fallback to Cloudflare Workers AI embeddings (@cf/baai/bge-m3) if Gemini is rate-limited or unavailable
  const remainingIndices = uncachedIndices.filter(idx => results[idx] === null);
  if (remainingIndices.length > 0 && isCloudflareAvailable()) {
    try {
      const cfTexts = remainingIndices.map(idx => texts[idx].slice(0, 2048));
      const cfVectors = await generateCloudflareEmbeddings(cfTexts);
      if (cfVectors && cfVectors.length === cfTexts.length) {
        console.log(`[Cloudflare AI Embedding] Generated ${cfVectors.length} vector embedding(s) via @cf/baai/bge-m3`);
        cfVectors.forEach((vec, i) => {
          if (vec && Array.isArray(vec)) {
            const originalIdx = remainingIndices[i];
            results[originalIdx] = vec;
            const cacheKey = texts[originalIdx].slice(0, 1000).trim();
            if (cacheKey) textEmbeddingCache.set(cacheKey, vec);
          }
        });
        if (results.some(r => r !== null)) {
          return results;
        }
      }
    } catch (cfErr) {
      console.warn('[Cloudflare AI Embedding] Failed, falling back to BM25:', cfErr);
    }
  }

  // If embedding API is unreachable, return array of nulls (retrieval will seamlessly use BM25)
  return results;
}

/**
 * Indexes documents into memory chunks and calculates vector embeddings.
 */
/**
 * Indexes documents into memory chunks and calculates vector embeddings.
 */
export async function indexDocuments(rawDocs: RawDocument[], options: RetrievalOptions = {}): Promise<DocumentChunk[]> {
  const allChunks: DocumentChunk[] = [];
  const chunksToEmbed: DocumentChunk[] = [];

  for (const doc of rawDocs) {
    if (!doc.text || !doc.text.trim()) continue;
    const docHash = hashDocument(doc.title, doc.text);

    if (documentIndexCache.has(docHash)) {
      const cached = documentIndexCache.get(docHash)!;
      if (doc.metadata) {
        cached.forEach(c => {
          c.metadata = { ...c.metadata, ...doc.metadata };
        });
      }
      allChunks.push(...cached);
    } else {
      evictOldestIfNeeded();
      const chunks = chunkDocument(doc.text, doc.title, {
        chunkSize: options.chunkSize || 650,
        chunkOverlap: options.chunkOverlap || 120,
        metadata: doc.metadata,
      });
      documentIndexCache.set(docHash, chunks);
      allChunks.push(...chunks);
      chunksToEmbed.push(...chunks);
    }
  }

  // Generate embeddings for newly created chunks
  if (chunksToEmbed.length > 0) {
    try {
      const texts = chunksToEmbed.map(c => `${c.docTitle}\n${c.text}`);
      const embeddings = await generateEmbeddings(texts);
      for (let i = 0; i < chunksToEmbed.length; i++) {
        if (embeddings[i]) {
          chunksToEmbed[i].embedding = embeddings[i]!;
        }
      }
    } catch (err) {
      console.warn('Batch embedding index warning:', err);
    }
  }

  return allChunks;
}

/**
 * Performs Semantic + BM25 Hybrid Similarity Search with Metadata Filtering
 * and Dynamic Top-K Cutoff Thresholding.
 */
export async function retrieveRelevantChunks(
  query: string,
  rawDocs: RawDocument[],
  options: RetrievalOptions = {}
): Promise<DocumentChunk[]> {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery || rawDocs.length === 0) return [];

  const maxTotalChars = options.maxTotalChars || 12000;

  // 1. Index and get all chunks
  const allChunks = await indexDocuments(rawDocs, options);
  if (allChunks.length === 0) return [];

  // 1b. Intent Extraction / Query Reformulation:
  // Use compact canonical keywords if provided, or auto-reformulate if query is noisy/long
  let effectiveSearchQuery = (options.searchQuery || options.reformulatedQuery || '').trim();
  if (!effectiveSearchQuery) {
    if (options.autoReformulate !== false && cleanQuery.length > 30) {
      try {
        const reformulation = await reformulateQueryWithGroq(cleanQuery);
        effectiveSearchQuery = reformulation.reformulatedQuery;
      } catch {
        effectiveSearchQuery = cleanQuery;
      }
    } else {
      effectiveSearchQuery = cleanQuery;
    }
  }

  // 2. Metadata Filtering (Phân vùng tìm kiếm theo Chapter / Section / Topic)
  let candidateChunks = allChunks;
  const targetSectionId = options.filterSectionId;
  const targetSectionName = options.filterSectionName?.toLowerCase();
  const queryChapter = extractChapterNumber(effectiveSearchQuery) || extractChapterNumber(cleanQuery);
  const targetChapter = options.filterChapter ? String(options.filterChapter).toLowerCase() : queryChapter;

  if (
    targetSectionId !== undefined ||
    targetSectionName ||
    targetChapter ||
    (options.filterDocTitles && options.filterDocTitles.length > 0)
  ) {
    const filtered = allChunks.filter(chunk => {
      const meta = chunk.metadata;
      // Filter by doc titles if provided
      if (options.filterDocTitles && options.filterDocTitles.length > 0) {
        const matchesDoc = options.filterDocTitles.some(dt =>
          chunk.docTitle.toLowerCase().includes(dt.toLowerCase())
        );
        if (!matchesDoc) return false;
      }
      // Filter by sectionId
      if (targetSectionId !== undefined && meta?.sectionId !== undefined) {
        if (String(meta.sectionId) === String(targetSectionId)) return true;
      }
      // Filter by chapter
      if (targetChapter) {
        const chunkChap = meta?.chapter ? String(meta.chapter).toLowerCase() : null;
        if (chunkChap === targetChapter) return true;
        const lowerTitle = chunk.docTitle.toLowerCase();
        if (
          lowerTitle.includes(`chương ${targetChapter}`) ||
          lowerTitle.includes(`chuong ${targetChapter}`) ||
          lowerTitle.includes(`chapter ${targetChapter}`) ||
          lowerTitle.includes(`bài ${targetChapter}`) ||
          lowerTitle.includes(`bai ${targetChapter}`)
        ) {
          return true;
        }
      }
      // Filter by sectionName
      if (targetSectionName && meta?.sectionName) {
        if (meta.sectionName.toLowerCase().includes(targetSectionName)) return true;
      }
      return false;
    });

    if (filtered.length > 0) {
      console.log(
        `[RAG Metadata Filter] Restricted vector search from ${allChunks.length} down to ${filtered.length} chunks (Target: ${
          targetChapter ? `Chương ${targetChapter}` : targetSectionName || targetSectionId
        })`
      );
      candidateChunks = filtered;
    }
  }

  // 3. Generate embedding for user query (clean canonical keywords)
  let queryEmbedding: number[] | null = null;
  try {
    const [qEmb] = await generateEmbeddings([effectiveSearchQuery]);
    queryEmbedding = qEmb;
  } catch {
    queryEmbedding = null;
  }

  return scoreAndSelectChunks(candidateChunks, effectiveSearchQuery, options, queryEmbedding);
}

/**
 * Scores candidate chunks (Hybrid Semantic + BM25) and selects the best matching chunks
 * using Dynamic Top-K cut-off thresholding.
 *
 * Fix: Enforces minimum 3 chunks and minimum 500 chars to prevent the "Perfect Score Trap"
 * where a single high-scoring but tiny chunk (e.g., a heading) causes [OUT_OF_CONTEXT].
 */
export function scoreAndSelectChunks(
  candidateChunks: DocumentChunk[],
  query: string,
  options: RetrievalOptions = {},
  queryEmbedding?: number[] | null
): DocumentChunk[] {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery || candidateChunks.length === 0) return [];

  const maxTotalChars = options.maxTotalChars || 12000;
  const minChunks = 3;         // Never send fewer than 3 chunks to AI
  const minTotalChars = 500;   // Ensure AI gets at least 500 chars of context
  const queryTokens = tokenize(cleanQuery);

  // Score candidate chunks (Hybrid Semantic + BM25)
  const scoredChunks: DocumentChunk[] = candidateChunks.map(chunk => {
    let semanticScore = 0;
    if (queryEmbedding && chunk.embedding) {
      semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
    }

    const bm25Score = computeBM25Score(queryTokens, `${chunk.docTitle} ${chunk.text}`);

    // If semantic embedding exists, 75% vector similarity + 25% keyword match
    const finalScore = queryEmbedding && chunk.embedding
      ? semanticScore * 0.75 + bm25Score * 0.25
      : bm25Score;

    return {
      ...chunk,
      similarityScore: Math.round(finalScore * 1000) / 1000,
    };
  });

  // Sort by score descending
  scoredChunks.sort((a, b) => (b.similarityScore || 0) - (a.similarityScore || 0));

  const topScore = scoredChunks[0]?.similarityScore || 0;

  // Dynamic Top-K Decision (with minimum floor of 3 chunks):
  // The old algorithm allowed 1 chunk at topScore >= 0.88, but a single high-scoring chunk
  // can be a tiny heading/title fragment (198 chars) with no actual content.
  // Fix: Always require at least minChunks (3) to guarantee surrounding context.
  let dynamicK = options.topK || 5;
  if (options.dynamicTopK !== false) {
    if (topScore >= 0.88) {
      dynamicK = Math.max(minChunks, 3);
      console.log(`[Dynamic Top-K] High precision: topScore = ${topScore} >= 0.88 -> Selected top ${dynamicK} chunks (min ${minChunks} enforced)`);
    } else if (topScore >= 0.80) {
      dynamicK = Math.max(minChunks, 3);
      console.log(`[Dynamic Top-K] High confidence: topScore = ${topScore} >= 0.80 -> Selected top ${dynamicK} chunks`);
    } else if (topScore >= 0.65) {
      dynamicK = Math.max(minChunks, 4);
    } else {
      dynamicK = Math.min(dynamicK, 5);
    }
  }

  const cutoffThreshold = options.minSimilarity ?? (queryEmbedding ? 0.75 : 0.30);
  const selected: DocumentChunk[] = [];
  let accumulatedChars = 0;

  for (const chunk of scoredChunks) {
    if (selected.length >= dynamicK) break;
    const score = chunk.similarityScore || 0;

    // Strict Cutoff Rule:
    // If topScore >= 0.80, only accept chunks that are also high confidence (>= 0.75 and within 15% of topScore)
    // Otherwise, accept if score >= cutoffThreshold or pick the single best chunk if below
    // Exception: if we haven't hit minChunks or minTotalChars yet, relax the cutoff
    const needsMore = selected.length < minChunks || accumulatedChars < minTotalChars;
    const passes = needsMore
      ? score >= 0.25 // Relaxed threshold when we need more context
      : topScore >= 0.80
        ? score >= 0.75 && score >= topScore * 0.85
        : score >= cutoffThreshold || (selected.length === 0 && score >= 0.25);

    if (passes) {
      if (accumulatedChars + chunk.text.length <= maxTotalChars) {
        selected.push(chunk);
        accumulatedChars += chunk.text.length;
      }
    }
  }

  // Surrounding Context: if top chunk is very high scoring but short (<300 chars),
  // pull in adjacent chunks (chunkIndex ± 1) from the same document to include the
  // content that follows a heading. This prevents the "Fragmented Chunk" problem.
  if (selected.length > 0 && selected[0].text.length < 300 && candidateChunks.length > 1) {
    const topChunk = selected[0];
    const adjacentChunks = candidateChunks
      .filter(c =>
        c.docTitle === topChunk.docTitle &&
        c.id !== topChunk.id &&
        Math.abs(c.chunkIndex - topChunk.chunkIndex) <= 2 &&
        !selected.some(s => s.id === c.id)
      )
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .slice(0, 3);

    for (const adj of adjacentChunks) {
      if (accumulatedChars + adj.text.length <= maxTotalChars) {
        selected.push(adj);
        accumulatedChars += adj.text.length;
      }
    }

    // Re-sort by chunkIndex for natural reading order within same document
    selected.sort((a, b) => {
      if (a.docTitle !== b.docTitle) return 0;
      return a.chunkIndex - b.chunkIndex;
    });
  }

  // Safety fallback: if nothing qualified, take the top minChunks chunks
  if (selected.length === 0 && scoredChunks.length > 0) {
    const fallbackCount = Math.min(minChunks, scoredChunks.length);
    for (let i = 0; i < fallbackCount; i++) {
      selected.push(scoredChunks[i]);
      accumulatedChars += scoredChunks[i].text.length;
    }
  }

  console.log(
    `[RAG Result] Query: "${cleanQuery.slice(0, 35)}..." -> Yielded ${selected.length} chunk(s) (topScore: ${topScore}, totalChars: ${accumulatedChars})`
  );
  return selected;
}

/**
 * Formats retrieved chunks into a clean, structured context string for LLM prompts.
 */
export function formatChunksForPrompt(chunks: DocumentChunk[]): string {
  if (!chunks || chunks.length === 0) return '';

  return chunks
    .filter(chunk => chunk.text && chunk.text.trim().length > 20)
    .map(
      (chunk, idx) =>
        `[ĐOẠN TRÍCH TÀI LIỆU ${idx + 1}: "${chunk.docTitle}"]\n${chunk.text.trim()}`
    )
    .join('\n\n');
}

