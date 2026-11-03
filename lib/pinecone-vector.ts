import { extractDocumentTOC } from '@/lib/document-parser';
import { getPineconeIndex } from '@/lib/pinecone';
import {
  generateEmbeddings,
  chunkDocument,
  cosineSimilarity,
  type DocumentChunk,
  type DocumentMetadata,
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

const namespace = () => process.env.PINECONE_NAMESPACE || 'default';
const documentTextField = () => process.env.PINECONE_DOCUMENT_TEXT_FIELD || 'chunk_text';

function compactMetadata(metadata: Record<string, string | number | boolean | undefined>) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  ) as Record<string, string | number | boolean>;
}

async function fetchStoredDocuments(filter: Record<string, unknown>) {
  const documents: Record<string, Record<string, unknown>> = {};
  let paginationToken: string | undefined;

  do {
    const response = await getPineconeIndex().namespace(namespace()).documents.fetch({
      filter,
      ...(paginationToken ? { paginationToken } : {}),
    });
    Object.assign(documents, response.documents || {});
    paginationToken = response.pagination?.next;
  } while (paginationToken);

  return documents;
}

function documentToChunk(document: Record<string, unknown>, idx: number): DocumentChunk {
  const text = String(document[documentTextField()] || document.text || '');
  return {
    id: String(document._id || `pinecone_${idx}`),
    docTitle: String(document.documentTitle || ''),
    text,
    chunkIndex: Number(document.pageNumber ?? idx),
    totalChunks: 0,
    metadata: {
      courseId: Number(document.courseId),
      docId: String(document.fileId),
      pageNumber: Number(document.pageNumber),
      sectionId: document.sectionId === undefined ? undefined : Number(document.sectionId),
      sectionName: document.sectionName ? String(document.sectionName) : undefined,
      chapter: typeof document.chapter === 'string' || typeof document.chapter === 'number' ? document.chapter : undefined,
      courseCode: document.courseCode ? String(document.courseCode) : undefined,
    },
  };
}

/**
 * Detects whether a knowledge source is a Web link, URL, HTML article, or ephemeral personal upload.
 * Under Enterprise RAG rules, these sources MUST NEVER be stored persistently.
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
 * Retrieves all stored vector chunks for a specific Moodle course from Pinecone.
 * Zero Gemini embedding quota is consumed when reading from this table.
 */
export async function getStoredCourseEmbeddings(
  moodleCourseId: number,
  options: { fileIds?: number[]; docTitles?: string[] } = {}
): Promise<DocumentChunk[]> {
  if (!moodleCourseId) return [];

  try {
    const filter: Record<string, unknown> = { courseId: { $eq: moodleCourseId } };
    if (options.fileIds?.length) filter.fileId = { $in: options.fileIds };
    let chunks = Object.values(await fetchStoredDocuments(filter)).map(documentToChunk);
    if (options.docTitles?.length) {
      const normalize = (s: string) => s.toLowerCase().replace(/\.(pdf|docx?|pptx?|txt|xlsx?|csv)$/i, '').replace(/[_\-\s]+/g, ' ').trim();
      const targets = options.docTitles.map(normalize);
      const matched = chunks.filter(chunk => targets.some(target => {
        const title = normalize(chunk.docTitle);
        return title === target || title.includes(target) || target.includes(title);
      }));
      if (matched.length) chunks = matched;
    }
    return chunks.map(chunk => ({ ...chunk, totalChunks: chunks.length, embedding: undefined }));
  } catch (err) {
    console.warn('[Pinecone] getStoredCourseEmbeddings exception:', err);
    return [];
  }
}

/**
 * Checks which Moodle file IDs already have embeddings stored in Supabase.
 */
export async function getExistingCourseFileIds(moodleCourseId: number): Promise<Set<number>> {
  const existingSet = new Set<number>();
  if (!moodleCourseId) return existingSet;

  try {
    const documents = await fetchStoredDocuments({
      courseId: { $eq: moodleCourseId },
    });
    for (const document of Object.values(documents)) {
      const fileId = document.fileId;
      if (fileId !== undefined) existingSet.add(Number(fileId));
    }
  } catch (err) {
    console.warn('[Pinecone] getExistingCourseFileIds error:', err);
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
 * Saves chunks and their embeddings to Pinecone.
 * Only writes once per file. If file is already vectorized, skips to save resources.
 */
export async function saveCourseDocumentChunks(params: {
  moodleCourseId: number;
  moodleFileId: number;
  documentTitle: string;
  chunks: DocumentChunk[];
}): Promise<number> {
  const { moodleCourseId, moodleFileId, documentTitle, chunks } = params;
  if (!moodleCourseId || !moodleFileId || chunks.length === 0) return 0;

  try {
    const existing = await getStoredCourseEmbeddings(moodleCourseId, { fileIds: [moodleFileId] });
    if (existing.length > 0) {
      return existing.length;
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
    // Await the writes: the same request retrieves and hydrates these chunks immediately
    // afterwards, so background writes would cause spurious 404 reads.
    const parentWriteResults = await Promise.allSettled(
      chunks.map((chunk, idx) =>
        saveMoodleDocumentParent({
          moodleCourseId,
          moodleFileId,
          documentTitle,
          pageNumber: chunk.chunkIndex ?? idx + 1,
          fullText: chunk.text,
        })
      )
    );
    const failedParentWrites = parentWriteResults.filter(result => result.status === 'rejected').length;
    if (failedParentWrites > 0) {
      console.warn(
        `[Parent-Child Firestore] ${failedParentWrites}/${parentWriteResults.length} parent writes failed for "${documentTitle}".`
      );
    }

    const documents = chunks
      .filter(chunk => chunk.embedding?.length)
      .map((chunk, idx) => ({
        _id: `${moodleFileId}-chunk-${chunk.chunkIndex ?? idx}`,
        [documentTextField()]: chunk.text,
        ...compactMetadata({
          documentTitle,
          courseId: moodleCourseId,
          fileId: moodleFileId,
          pageNumber: chunk.chunkIndex ?? idx + 1,
          sectionId: chunk.metadata?.sectionId === undefined ? undefined : Number(chunk.metadata.sectionId),
          sectionName: chunk.metadata?.sectionName,
          chapter: chunk.metadata?.chapter,
          courseCode: chunk.metadata?.courseCode,
        }),
      }));
    if (!documents.length) return 0;
    const batchSize = 96;
    for (let i = 0; i < documents.length; i += batchSize) {
      await getPineconeIndex().namespace(namespace()).documents.upsert({
        documents: documents.slice(i, i + batchSize),
      });
    }
    console.log(`[Pinecone] Stored ${documents.length} chunks for "${documentTitle}" (Course: ${moodleCourseId}, File: ${moodleFileId})`);
    return documents.length;
  } catch (err) {
    console.error('[Pinecone] saveCourseDocumentChunks exception:', err);
    return 0;
  }
}

/**
 * Vectorizes a raw LMS course document and persists it into Pinecone.
 */
export async function vectorizeAndStoreLmsSource(params: {
  moodleCourseId: number;
  moodleFileId: number;
  documentTitle: string;
  text: string;
  metadata?: DocumentMetadata;
}): Promise<DocumentChunk[]> {
  const { moodleCourseId, moodleFileId, documentTitle, text, metadata } = params;
  const meaningfulText = (text || '').replace(/\[Trang\s+\d+\]|\[Slide\s+\d+\]/gi, '').trim();
  if (meaningfulText.length < 25) {
    console.warn(`[Pinecone] Bypassing vectorization for "${documentTitle}" because text has no genuine content (${meaningfulText.length} chars).`);
    return [];
  }

  // Chunk the document
  const chunks = chunkDocument(text, documentTitle, {
    chunkSize: 650,
    chunkOverlap: 120,
    metadata,
  });

  if (chunks.length === 0) return [];

  // Rule (Enterprise RAG): Web links are transient and are never stored persistently.
  if (
    isWebOrTransientSource({
      name: documentTitle,
      type: metadata?.sectionName,
    }) ||
    documentTitle.toLowerCase().startsWith('http') ||
    metadata?.sectionName?.toLowerCase()?.includes('liên kết web')
  ) {
    console.log(`[Pinecone] Bypassing persistent storage for web source "${documentTitle}" (On-the-fly RAG only)`);
    return chunks;
  }

  // Save to Pinecone (generates embeddings once and stores permanently)
  await saveCourseDocumentChunks({
    moodleCourseId,
    moodleFileId,
    documentTitle,
    chunks,
  });

  // Extract and store TOC/structural overview as a special chunk (page_number = -1)
  // This enables complete TOC retrieval for overview queries without chunking limitations
  saveDocumentTOC({ moodleCourseId, moodleFileId, documentTitle, fullText: text }).catch(err => {
    console.warn('[Pinecone TOC] Background TOC extraction warning:', err);
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
  if (!moodleCourseId || !Array.isArray(activeFileIds) || activeFileIds.length === 0) {
    return 0;
  }

  try {
    const storedChunks = await getStoredCourseEmbeddings(moodleCourseId);
    if (!storedChunks.length) {
      return 0;
    }

    const storedIds = Array.from(new Set(storedChunks.map(chunk => Number(chunk.metadata?.docId))));
    const activeSet = new Set(activeFileIds.map(Number));

    // 2. Identify orphaned files (in DB but missing from Moodle active list)
    const orphanedFileIds = storedIds.filter(id => !activeSet.has(id));

    if (orphanedFileIds.length === 0) {
      return 0;
    }

    console.log(
      `[Pinecone Sweep] Found ${orphanedFileIds.length} orphaned file(s) for course ${moodleCourseId}: [${orphanedFileIds.join(', ')}]. Cleaning up...`
    );

    await getPineconeIndex().namespace(namespace()).documents.delete({
      filter: { courseId: { $eq: moodleCourseId }, fileId: { $in: orphanedFileIds } },
    });

    console.log(
      `[Pinecone Sweep] Cleaned up ${orphanedFileIds.length} orphaned files successfully.`
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
    console.warn('[Pinecone Sweep] Exception during garbage collection:', err);
    return 0;
  }
}

/**
 * Searches stored course vectors using Cosine Similarity.
 * Uses Pinecone similarity search with an in-memory fallback when embeddings are unavailable.
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
  if (!moodleCourseId) return [];

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

  if (qEmb) {
    try {
      const response = await getPineconeIndex().namespace(namespace()).documents.search({
        scoreBy: [{ type: 'embed', field: documentTextField(), query }],
        topK,
        filter: { courseId: { $eq: moodleCourseId } },
        includeFields: ['*'],
      });
      const matches = (response.matches || []).filter(match => (match._score || 0) >= minSimilarity);
      let chunks = matches.map((match, idx) => ({
        ...documentToChunk({ ...match, _id: match._id }, idx),
        similarityScore: match._score === null ? undefined : match._score,
      }));
      if (docTitles?.length) chunks = chunks.filter(chunk => docTitles.some(title => chunk.docTitle.toLowerCase().includes(title.toLowerCase())));
      return hydrateChunksWithParentText(chunks);
    } catch (err) {
      console.warn('[Pinecone] queryCourseEmbeddings query failed:', err);
    }
  }

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
  if (!fullText || fullText.trim().length < 50) return false;

  try {
    const existing = await getPineconeIndex().namespace(namespace()).documents.fetch({
      ids: [`${moodleFileId}-toc`],
    });
    if (existing.documents?.[`${moodleFileId}-toc`]) return true;

    // Extract TOC using heuristic parser
    const tocText = extractDocumentTOC(fullText);
    if (!tocText || tocText.trim().length < 30) return false;

    // Generate embedding for the TOC chunk
    await getPineconeIndex().namespace(namespace()).documents.upsert({ documents: [{
      _id: `${moodleFileId}-toc`,
      [documentTextField()]: tocText,
      ...compactMetadata({
        documentTitle: documentTitle,
        courseId: moodleCourseId,
        fileId: moodleFileId,
        pageNumber: -1,
        isToc: true,
      }),
    }] });

    console.log(`[Pinecone TOC] Stored TOC for "${documentTitle}" (Course: ${moodleCourseId}, File: ${moodleFileId}, Length: ${tocText.length} chars)`);
    return true;
  } catch (err) {
    console.warn('[Pinecone TOC] saveDocumentTOC exception:', err);
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
  if (!moodleCourseId) return [];

  try {
    const filter: Record<string, unknown> = {
      courseId: { $eq: moodleCourseId },
      isToc: { $eq: true },
    };
    if (options.fileIds?.length) filter.fileId = { $in: options.fileIds };
    const response = await fetchStoredDocuments(filter);
    let records = Object.values(response).map(document => ({
      docTitle: String(document.documentTitle || ''),
      tocText: String(document[documentTextField()] || document.text || ''),
      moodleFileId: Number(document.fileId),
    }));
    if (options.docTitles?.length) {
      records = records.filter(record => options.docTitles!.includes(record.docTitle));
    }
    return records;
  } catch (err) {
    console.warn('[Pinecone] getDocumentTOC exception:', err);
    return [];
  }
}
