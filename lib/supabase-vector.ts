import { supabaseAdmin } from '@/lib/supabase';
import { extractDocumentTOC } from '@/lib/document-parser';
import {
  generateEmbeddings,
  chunkDocument,
  cosineSimilarity,
  type DocumentChunk,
  type DocumentMetadata,
  type RetrievalOptions,
} from '@/lib/rag';
import { invalidateCourseCache } from '@/lib/semantic-cache';
import {
  saveMoodleDocumentParent,
  getMoodleDocumentParent,
  deleteMoodleDocumentParent,
} from '@/lib/firebase-data';

export interface DocumentEmbeddingRow {
  id?: string;
  moodle_course_id: number;
  moodle_file_id: number;
  document_title: string;
  page_number?: number | null;
  chunk_text: string;
  embedding?: number[] | string | null;
  created_at?: string;
}

/**
 * Detects whether a knowledge source is a Web link, URL, HTML article, or ephemeral personal upload.
 * Under Enterprise RAG rules, these sources MUST NEVER be stored in Supabase pgvector (0MB footprint).
 * They must always use On-the-Fly In-Memory RAG and Cohere Rerank.
 */
export function isWebOrTransientSource(src: {
  id?: string;
  type?: string;
  url?: string;
  name?: string;
  isStudentUpload?: boolean;
}): boolean {
  if (src.isStudentUpload) return true;

  const idStr = String(src.id || '').toLowerCase();
  if (
    idStr.startsWith('mat-') ||
    idStr.startsWith('upload-') ||
    idStr.startsWith('url-') ||
    idStr.startsWith('note-') ||
    idStr.startsWith('web-')
  ) {
    return true;
  }

  const typeStr = String(src.type || '').toUpperCase();
  if (
    typeStr === 'LINK' ||
    typeStr === 'URL' ||
    typeStr === 'WEB' ||
    typeStr === 'WEBLINK' ||
    typeStr === 'HTML'
  ) {
    return true;
  }

  if (src.url) {
    const rawUrl = src.url.split('?')[0].toLowerCase();
    const isDocFile = /\.(pdf|docx?|pptx?|txt|xlsx?|csv)$/i.test(rawUrl);
    // If it does not point to a document file extension and is a web URL, it's a web source!
    if (!isDocFile && (src.url.startsWith('http://') || src.url.startsWith('https://'))) {
      return true;
    }
  }

  return false;
}

/**
 * Parses vector string "[0.01, 0.02, ...]" or array into number[]
 */
export function parseEmbeddingVector(val: unknown): number[] | null {
  if (!val) return null;
  if (Array.isArray(val)) return val.map(Number);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      // try comma separated
      const cleaned = val.replace(/^\[|\]$/g, '').trim();
      if (!cleaned) return null;
      return cleaned.split(',').map(s => Number(s.trim()));
    }
  }
  return null;
}

/**
 * Retrieves all stored vector chunks for a specific Moodle course from Supabase pgvector table.
 * Zero Gemini embedding quota is consumed when reading from this table.
 */
export async function getStoredCourseEmbeddings(
  moodleCourseId: number,
  options: { fileIds?: number[]; docTitles?: string[] } = {}
): Promise<DocumentChunk[]> {
  if (!supabaseAdmin || !moodleCourseId) return [];

  try {
    let query = supabaseAdmin
      .from('document_embeddings')
      .select('id, moodle_course_id, moodle_file_id, document_title, page_number, chunk_text, embedding')
      .eq('moodle_course_id', moodleCourseId);

    if (options.fileIds && options.fileIds.length > 0) {
      query = query.in('moodle_file_id', options.fileIds);
    }

    if (options.docTitles && options.docTitles.length > 0) {
      query = query.in('document_title', options.docTitles);
    }

    const { data, error } = await query;
    if (error || !data) {
      console.warn('[pgvector] getStoredCourseEmbeddings warning:', error?.message);
      return [];
    }

    return data.map((row: any, idx: number) => ({
      id: row.id || `db_${row.moodle_file_id}_${idx}`,
      docTitle: row.document_title,
      text: row.chunk_text,
      chunkIndex: row.page_number ?? idx,
      totalChunks: data.length,
      embedding: parseEmbeddingVector(row.embedding) || undefined,
      metadata: {
        courseId: row.moodle_course_id,
        docId: String(row.moodle_file_id),
        pageNumber: row.page_number,
      },
    }));
  } catch (err) {
    console.warn('[pgvector] getStoredCourseEmbeddings exception:', err);
    return [];
  }
}

/**
 * Checks which Moodle file IDs already have embeddings stored in Supabase.
 */
export async function getExistingCourseFileIds(moodleCourseId: number): Promise<Set<number>> {
  const existingSet = new Set<number>();
  if (!supabaseAdmin || !moodleCourseId) return existingSet;

  try {
    const { data, error } = await supabaseAdmin
      .from('document_embeddings')
      .select('moodle_file_id, embedding')
      .eq('moodle_course_id', moodleCourseId)
      .not('embedding', 'is', null);

    if (!error && data) {
      data.forEach((r: { moodle_file_id: number; embedding: any }) => {
        if (r.moodle_file_id !== undefined && r.moodle_file_id !== null && r.embedding !== null) {
          existingSet.add(Number(r.moodle_file_id));
        }
      });
    }
  } catch (err) {
    console.warn('[pgvector] getExistingCourseFileIds error:', err);
  }

  return existingSet;
}

/**
 * Parent-Child Retrieval Hydration:
 * Given a list of retrieved DocumentChunks (from Supabase or Cohere),
 * fetches the corresponding 100% full uncompressed text from Firebase Firestore collection `moodle_document_parents`.
 * If parent full text exists, updates chunk.text to the complete text.
 */
export async function hydrateChunksWithParentText(
  chunks: DocumentChunk[]
): Promise<DocumentChunk[]> {
  if (!chunks || chunks.length === 0) return chunks;

  const hydrated = await Promise.all(
    chunks.map(async chunk => {
      const courseId = Number(chunk.metadata?.courseId);
      const fileId = Number(chunk.metadata?.docId);
      const pageNumber = chunk.chunkIndex;

      if (courseId && fileId && pageNumber !== undefined && pageNumber >= 0) {
        try {
          const parentFullText = await getMoodleDocumentParent(courseId, fileId, pageNumber);
          if (parentFullText && parentFullText.length > chunk.text.length) {
            return {
              ...chunk,
              text: parentFullText,
            };
          }
        } catch {
          // Gracefully fallback to existing chunk.text
        }
      }
      return chunk;
    })
  );

  return hydrated;
}

/**
 * Saves chunks and their 768-dimensional embeddings to Supabase `document_embeddings`.
 * Only writes once per file. If file is already vectorized, skips to save resources.
 */
export async function saveCourseDocumentChunks(params: {
  moodleCourseId: number;
  moodleFileId: number;
  documentTitle: string;
  chunks: DocumentChunk[];
}): Promise<number> {
  const { moodleCourseId, moodleFileId, documentTitle, chunks } = params;
  if (!supabaseAdmin || !moodleCourseId || !moodleFileId || chunks.length === 0) return 0;

  try {
    // Check if already stored with valid embeddings
    const { data: existing, error: checkErr } = await supabaseAdmin
      .from('document_embeddings')
      .select('id, embedding')
      .eq('moodle_course_id', moodleCourseId)
      .eq('moodle_file_id', moodleFileId);

    if (!checkErr && existing && existing.length > 0) {
      const hasValidEmbedding = existing.some((r: any) => r.embedding !== null);
      if (hasValidEmbedding) {
        return existing.length;
      }
      // If existing rows have NULL embedding, purge them to re-ingest with genuine vectors
      await supabaseAdmin
        .from('document_embeddings')
        .delete()
        .eq('moodle_course_id', moodleCourseId)
        .eq('moodle_file_id', moodleFileId);
    }

    // Ensure all chunks have embeddings
    const missingIndices: number[] = [];
    chunks.forEach((c, idx) => {
      if (!c.embedding || c.embedding.length === 0) {
        missingIndices.push(idx);
      }
    });

    if (missingIndices.length > 0) {
      const textsToEmbed = missingIndices.map(idx => `${chunks[idx].docTitle}\n${chunks[idx].text}`);
      const computedEmbeddings = await generateEmbeddings(textsToEmbed);
      missingIndices.forEach((chunkIdx, listIdx) => {
        if (computedEmbeddings[listIdx]) {
          chunks[chunkIdx].embedding = computedEmbeddings[listIdx]!;
        }
      });
    }

    // 1. Parent-Child: Persist full parent text to Firebase Firestore collection `moodle_document_parents`
    Promise.allSettled(
      chunks.map((chunk, idx) =>
        saveMoodleDocumentParent({
          moodleCourseId,
          moodleFileId,
          documentTitle,
          pageNumber: chunk.chunkIndex ?? idx + 1,
          fullText: chunk.text,
        })
      )
    ).catch(fbErr => {
      console.warn('[Parent-Child Firestore] Warning saving parent full texts:', fbErr);
    });

    // 2. Prepare rows for Supabase insertion:
    // Store condensed child text (max 250 chars) in Supabase to save 60-70% storage,
    // while keeping full semantic embedding. The full text is retrieved from Firebase on demand.
    const rows: DocumentEmbeddingRow[] = chunks.map((chunk, idx) => ({
      moodle_course_id: moodleCourseId,
      moodle_file_id: moodleFileId,
      document_title: documentTitle,
      page_number: chunk.chunkIndex ?? idx + 1,
      chunk_text:
        chunk.text.length > 250
          ? `${chunk.text.slice(0, 240)}...`
          : chunk.text,
      embedding: chunk.embedding || null,
    }));

    // Batch insert in groups of 40 to avoid payload limits
    let insertedCount = 0;
    const batchSize = 40;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error: insertError } = await supabaseAdmin
        .from('document_embeddings')
        .insert(batch);

      if (insertError) {
        console.error('[pgvector] Failed inserting document_embeddings batch:', insertError.message);
        break;
      }
      insertedCount += batch.length;
    }

    console.log(
      `[pgvector] Successfully stored ${insertedCount} chunks into Supabase for "${documentTitle}" (Course: ${moodleCourseId}, File: ${moodleFileId})`
    );
    return insertedCount;
  } catch (err) {
    console.error('[pgvector] saveCourseDocumentChunks exception:', err);
    return 0;
  }
}

/**
 * Vectorizes a raw LMS course document and persists it into Supabase document_embeddings.
 */
export async function vectorizeAndStoreLmsSource(params: {
  moodleCourseId: number;
  moodleFileId: number;
  documentTitle: string;
  text: string;
  metadata?: DocumentMetadata;
}): Promise<DocumentChunk[]> {
  const { moodleCourseId, moodleFileId, documentTitle, text, metadata } = params;
  if (!text || text.trim().length < 20) return [];

  // Chunk the document
  const chunks = chunkDocument(text, documentTitle, {
    chunkSize: 650,
    chunkOverlap: 120,
    metadata,
  });

  if (chunks.length === 0) return [];

  // Rule (Enterprise RAG): Web links must NEVER be stored into Supabase pgvector (0MB footprint)
  if (
    isWebOrTransientSource({
      name: documentTitle,
      type: metadata?.sectionName,
    }) ||
    documentTitle.toLowerCase().startsWith('http') ||
    metadata?.sectionName?.toLowerCase()?.includes('liên kết web')
  ) {
    console.log(`[pgvector] Bypassing persistent storage for web source "${documentTitle}" (On-the-fly RAG only)`);
    return chunks;
  }

  // Save to Supabase (generates Gemini embeddings once and stores permanently)
  await saveCourseDocumentChunks({
    moodleCourseId,
    moodleFileId,
    documentTitle,
    chunks,
  });

  // Extract and store TOC/structural overview as a special chunk (page_number = -1)
  // This enables complete TOC retrieval for overview queries without chunking limitations
  saveDocumentTOC({ moodleCourseId, moodleFileId, documentTitle, fullText: text }).catch(err => {
    console.warn('[pgvector TOC] Background TOC extraction warning:', err);
  });

  // Purge any existing semantic query cache for this course to prevent serving stale answers
  invalidateCourseCache(moodleCourseId).catch(err => {
    console.warn('[Semantic Cache] Cache invalidation warning on vectorize:', err);
  });

  return chunks;
}

/**
 * Sweep & Garbage Collection Algorithm (as defined in database_rag.txt):
 * Compares current active file IDs on Moodle with stored vectors on Supabase.
 * Any vectors belonging to files that no longer exist on Moodle are automatically purged.
 */
export async function sweepOrphanedCourseEmbeddings(
  moodleCourseId: number,
  activeFileIds: number[]
): Promise<number> {
  if (!supabaseAdmin || !moodleCourseId || !Array.isArray(activeFileIds) || activeFileIds.length === 0) {
    return 0;
  }

  try {
    // 1. Fetch distinct moodle_file_id currently stored in Supabase for this course
    const { data: storedRows, error } = await supabaseAdmin
      .from('document_embeddings')
      .select('moodle_file_id')
      .eq('moodle_course_id', moodleCourseId);

    if (error || !storedRows || storedRows.length === 0) {
      return 0;
    }

    const storedIds = Array.from(new Set(storedRows.map((r: { moodle_file_id: number }) => Number(r.moodle_file_id))));
    const activeSet = new Set(activeFileIds.map(Number));

    // 2. Identify orphaned files (in DB but missing from Moodle active list)
    const orphanedFileIds = storedIds.filter(id => !activeSet.has(id));

    if (orphanedFileIds.length === 0) {
      return 0;
    }

    console.log(
      `[pgvector Sweep] Found ${orphanedFileIds.length} orphaned file(s) for course ${moodleCourseId}: [${orphanedFileIds.join(', ')}]. Cleaning up...`
    );

    // 3. Delete orphaned vectors
    const { error: deleteError } = await supabaseAdmin
      .from('document_embeddings')
      .delete()
      .eq('moodle_course_id', moodleCourseId)
      .in('moodle_file_id', orphanedFileIds);

    if (deleteError) {
      console.warn('[pgvector Sweep] Delete error:', deleteError.message);
      return 0;
    }

    console.log(
      `[pgvector Sweep] Cleaned up ${orphanedFileIds.length} orphaned files successfully from Supabase.`
    );

    // Purge semantic cache when course files are deleted or orphaned
    invalidateCourseCache(moodleCourseId).catch(err => {
      console.warn('[Semantic Cache] Cache invalidation warning on sweep:', err);
    });

    // Parent-Child: Clean up parent documents from Firebase Firestore for purged files
    for (const fid of orphanedFileIds) {
      for (let p = 1; p <= 50; p++) {
        deleteMoodleDocumentParent(moodleCourseId, fid, p).catch(() => {});
      }
    }

    return orphanedFileIds.length;
  } catch (err) {
    console.warn('[pgvector Sweep] Exception during garbage collection:', err);
    return 0;
  }
}

/**
 * Searches stored course vectors using Cosine Similarity.
 * Supports native match_document_embeddings RPC if present, or in-memory vector comparison fallback.
 */
export async function queryCourseEmbeddings(params: {
  moodleCourseId: number;
  query: string;
  queryEmbedding?: number[] | null;
  docTitles?: string[];
  topK?: number;
  minSimilarity?: number;
}): Promise<DocumentChunk[]> {
  const { moodleCourseId, query, docTitles, topK = 5, minSimilarity = 0.75 } = params;
  if (!supabaseAdmin || !moodleCourseId) return [];

  // Generate query embedding if not provided
  let qEmb = params.queryEmbedding || null;
  if (!qEmb) {
    try {
      const [emb] = await generateEmbeddings([query]);
      qEmb = emb;
    } catch {
      qEmb = null;
    }
  }

  // 1. Try native Supabase RPC match_document_embeddings if available
  if (qEmb) {
    try {
      const { data: rpcResults, error: rpcError } = await supabaseAdmin.rpc('match_document_embeddings', {
        query_embedding: qEmb,
        match_threshold: minSimilarity,
        match_count: topK,
        filter_course_id: moodleCourseId,
      });

      if (!rpcError && Array.isArray(rpcResults) && rpcResults.length > 0) {
        console.log(`[pgvector RPC] match_document_embeddings matched ${rpcResults.length} chunks via PostgreSQL`);
        const mappedChunks = rpcResults.map((r: any, idx: number) => ({
          id: r.id || `rpc_${r.moodle_file_id}_${idx}`,
          docTitle: r.document_title,
          text: r.chunk_text,
          chunkIndex: r.page_number || idx,
          totalChunks: rpcResults.length,
          similarityScore: Math.round((Number(r.similarity) || 0) * 1000) / 1000,
          metadata: {
            courseId: r.moodle_course_id,
            docId: String(r.moodle_file_id),
          },
        }));
        return hydrateChunksWithParentText(mappedChunks);
      }
    } catch {
      // RPC might not exist, fall through to query fallback
    }
  }

  // 2. Fallback: Read stored course chunks and score in JS
  const allStoredChunks = await getStoredCourseEmbeddings(moodleCourseId, { docTitles });
  if (allStoredChunks.length === 0) return [];

  if (!qEmb) {
    return allStoredChunks.slice(0, topK);
  }

  // Score using cosine similarity
  const scored = allStoredChunks
    .map(c => {
      const sim = c.embedding ? cosineSimilarity(qEmb!, c.embedding) : 0;
      return {
        ...c,
        similarityScore: Math.round(sim * 1000) / 1000,
      };
    })
    .filter(c => (c.similarityScore || 0) >= minSimilarity)
    .sort((a, b) => (b.similarityScore || 0) - (a.similarityScore || 0));

  return hydrateChunksWithParentText(scored.slice(0, topK));
}

/**
 * Extracts and stores a TOC/structural overview for a document as a special chunk (page_number = -1).
 * Uses extractDocumentTOC from document-parser to identify headings, TOC sections, and structure.
 * Skips if a TOC chunk already exists for this file.
 */
export async function saveDocumentTOC(params: {
  moodleCourseId: number;
  moodleFileId: number;
  documentTitle: string;
  fullText: string;
}): Promise<boolean> {
  const { moodleCourseId, moodleFileId, documentTitle, fullText } = params;
  if (!supabaseAdmin || !fullText || fullText.trim().length < 50) return false;

  try {
    // Check if TOC row already exists for this file
    const { data: existing } = await supabaseAdmin
      .from('document_embeddings')
      .select('id')
      .eq('moodle_course_id', moodleCourseId)
      .eq('moodle_file_id', moodleFileId)
      .eq('page_number', -1)
      .limit(1);

    if (existing && existing.length > 0) return true; // Already stored

    // Extract TOC using heuristic parser
    const tocText = extractDocumentTOC(fullText);
    if (!tocText || tocText.trim().length < 30) return false;

    // Generate embedding for the TOC chunk
    let tocEmbedding: number[] | null = null;
    try {
      const [emb] = await generateEmbeddings([`Mục lục và cấu trúc tài liệu: ${documentTitle}\n${tocText.slice(0, 2000)}`]);
      tocEmbedding = emb;
    } catch {
      // Skip embedding — TOC is mainly retrieved by page_number = -1 filter
    }

    const { error } = await supabaseAdmin
      .from('document_embeddings')
      .insert({
        moodle_course_id: moodleCourseId,
        moodle_file_id: moodleFileId,
        document_title: documentTitle,
        page_number: -1, // Special marker: TOC / structural overview chunk
        chunk_text: tocText,
        embedding: tocEmbedding,
      });

    if (error) {
      console.warn('[pgvector TOC] Insert error:', error.message);
      return false;
    }

    console.log(`[pgvector TOC] Stored TOC for "${documentTitle}" (Course: ${moodleCourseId}, File: ${moodleFileId}, Length: ${tocText.length} chars)`);
    return true;
  } catch (err) {
    console.warn('[pgvector TOC] saveDocumentTOC exception:', err);
    return false;
  }
}

/**
 * Retrieves pre-extracted TOC chunks (page_number = -1) for documents in a course.
 * Used to bypass vector search for overview/TOC queries and return complete structural data.
 */
export async function getDocumentTOC(
  moodleCourseId: number,
  options: { fileIds?: number[]; docTitles?: string[] } = {}
): Promise<Array<{ docTitle: string; tocText: string; moodleFileId: number }>> {
  if (!supabaseAdmin || !moodleCourseId) return [];

  try {
    let query = supabaseAdmin
      .from('document_embeddings')
      .select('moodle_file_id, document_title, chunk_text')
      .eq('moodle_course_id', moodleCourseId)
      .eq('page_number', -1);

    if (options.fileIds && options.fileIds.length > 0) {
      query = query.in('moodle_file_id', options.fileIds);
    }

    if (options.docTitles && options.docTitles.length > 0) {
      query = query.in('document_title', options.docTitles);
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) return [];

    return data.map((row: any) => ({
      docTitle: row.document_title,
      tocText: row.chunk_text,
      moodleFileId: row.moodle_file_id,
    }));
  } catch (err) {
    console.warn('[pgvector] getDocumentTOC exception:', err);
    return [];
  }
}
