import { NextResponse } from 'next/server';
import { generateText, generateTextStream, detectTaskCategory } from '@/models/registry';
import { supabaseAdmin } from '@/lib/supabase';
import { parseDocumentFromUrl } from '@/lib/document-parser';
import {
  retrieveRelevantChunks,
  formatChunksForPrompt,
  extractChapterNumber,
  scoreAndSelectChunks,
  indexDocuments,
  filterSourcesByPromptMetadata,
  reformulateQueryWithGroq,
  type RawDocument,
  type DocumentChunk,
} from '@/lib/rag';
import {
  getStoredCourseEmbeddings,
  getExistingCourseFileIds,
  vectorizeAndStoreLmsSource,
  sweepOrphanedCourseEmbeddings,
  getDocumentTOC,
  hydrateChunksWithParentText,
  isWebOrTransientSource,
} from '@/lib/supabase-vector';
import { rerankChunksWithCohere } from '@/models/cohere';
import { getLearningArtifacts } from '@/lib/learning-artifacts';
import { getPersonalMaterials } from '@/lib/firebase-data';
import type { ExamResult, RagMode, CitationSource } from '@/app/types';
import { findCachedAnswer, storeCachedAnswer, isPersonalQuery } from '@/lib/semantic-cache';
import { stripFluff, COMMON_FLUFF_STOP_SEQUENCES } from '@/lib/anti-fluff';
import { getCircuitBreakerNotice, buildUniversalLanguageDirective } from '@/lib/language-detector';

interface ChatHistoryItem {
  role: 'user' | 'ai' | 'model' | 'assistant';
  text: string;
}

interface SourceItem {
  id?: string;
  name: string;
  url?: string;
  type?: string;
  courseId?: string | number;
  moduleId?: number;
  fileId?: number;
  sectionId?: string | number;
  sectionName?: string;
  chapter?: string | number;
  isStudentUpload?: boolean;
}

interface UpcomingDeadlineItem {
  name: string;
  timestamp: number;
  type?: string;
  url?: string;
}

export async function POST(request: Request) {
  try {
    const {
      question = '',
      sourceNames = [],
      sources = [],
      course = '',
      courseCode = '',
      courseId,
      userId,
      userName,
      sessionId,
      gradebook = [],
      upcomingDeadlines = [],
      allowExternalSource = false,
      ragMode: rawRagMode,
      answerStyle = 'concise',
      history = [],
      model = 'auto',
      stream = false,
      sectionId,
      sectionName,
      chapter,
      stop,
      stopSequences,
    } = (await request.json()) as {
      question?: string;
      sourceNames?: string[];
      sources?: SourceItem[];
      course?: string;
      courseCode?: string;
      courseId?: string | number;
      userId?: number;
      userName?: string;
      sessionId?: string;
      gradebook?: ExamResult[];
      upcomingDeadlines?: UpcomingDeadlineItem[];
      allowExternalSource?: boolean;
      ragMode?: RagMode;
      answerStyle?: 'concise' | 'detailed';
      history?: ChatHistoryItem[];
      model?: string;
      stream?: boolean;
      sectionId?: string | number;
      sectionName?: string;
      chapter?: string | number;
      stop?: string[];
      stopSequences?: string[];
    };

    const ragMode: RagMode =
      rawRagMode === 'strict' || rawRagMode === 'hybrid' || rawRagMode === 'creative'
        ? rawRagMode
        : allowExternalSource
          ? 'creative'
          : 'hybrid';
    const isExternalMode = ragMode === 'creative';

    if (!question.trim()) {
      return NextResponse.json({ error: 'Câu hỏi không được để trống.' }, { status: 400 });
    }

    const effectiveSources: SourceItem[] =
      sources.length > 0
        ? sources
        : sourceNames.map(name => ({ name }));

    const effectiveSourceNames = effectiveSources.map(s => s.name);

    // ── RAG Stage 1: Intent Extraction & Query Reformulation via Groq (Silent Gatekeeper) ──
    // Convert verbose, rambling, or emotional student prompts into compact canonical search keywords
    // to dramatically boost Semantic Cache hit rate and vector similarity while saving input tokens.
    const queryReformulation = await reformulateQueryWithGroq(question, {
      courseContext: course ? `${course} (${courseCode})` : undefined,
    });
    const searchQuery = queryReformulation.reformulatedQuery;

    // ── Semantic Cache Interception (0ms / 0 tokens) ──
    // Check if question is personal (contains personal keywords, gradebook queries, or student uploads).
    // If it's a standalone general question and matches a cached answer in this course (similarity >= 0.92),
    // return immediately to avoid burning LLM quota, database vector scans, and Cohere rerank latency.
    const isStudentUpload = effectiveSources.some(s => s.isStudentUpload);
    const hasGradebook = Array.isArray(gradebook) && gradebook.length > 0;
    const isMultiTurn = Array.isArray(history) && history.length > 1;
    const isPersonal = isStudentUpload || hasGradebook || isPersonalQuery(question);
    const baseCourseId =
      courseId !== undefined && courseId !== null && String(courseId).trim() !== ''
        ? String(courseId)
        : 'global';
    // A semantic answer is only reusable when it was generated from the same
    // source selection and retrieval mode.  Course-only cache keys can leak an
    // answer grounded in one chapter into another chapter of the same course.
    const sourceFingerprint = effectiveSources
      .map(s => String(s.fileId || s.moduleId || s.id || s.url || s.name).toLowerCase())
      .sort()
      .join('|') || 'all';
    const retrievalFingerprint = [
      ragMode,
      `section:${sectionId ?? sectionName ?? ''}`,
      `chapter:${chapter ?? extractChapterNumber(searchQuery) ?? extractChapterNumber(question) ?? ''}`,
      `sources:${sourceFingerprint}`,
    ].join('::');
    const effectiveCourseId = `${baseCourseId}::${retrievalFingerprint}`;
    const isStream = Boolean(stream || request.headers.get('accept')?.includes('text/event-stream'));

    if (!isPersonal && !isMultiTurn) {
      try {
        const cachedHit = await findCachedAnswer({
          question,
          canonicalQuery: searchQuery,
          courseId: effectiveCourseId,
          threshold: 0.92,
        });

        if (cachedHit) {
          const citedSources = compileAllSources({
            aiText: cachedHit.answer,
            ragMode,
            relevantChunks: [],
            isParametricFallback: false,
            groundingMetadata: null,
            course,
            question,
          });

          if (isStream) {
            const encoder = new TextEncoder();
            const readableStream = new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta: cachedHit.answer })}\n\n`)
                );
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      done: true,
                      sources: citedSources,
                      model: 'Bộ nhớ đệm (Semantic Cache - 0 token)',
                      modelId: 'cache:semantic',
                      provider: 'cache',
                      cached: true,
                      ragMode,
                      isFallback: false,
                    })}\n\n`
                  )
                );
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            });

            return new Response(readableStream, {
              headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              },
            });
          }

          return NextResponse.json({
            answer: cachedHit.answer,
            sources: citedSources,
            model: 'Bộ nhớ đệm (Semantic Cache - 0 token)',
            provider: 'cache',
            cached: true,
            ragMode,
            isFallback: false,
          });
        }
      } catch (cacheErr) {
        console.warn('[Semantic Cache] Top-level cache interception error:', cacheErr);
      }
    }

    // 1. Retrieve or extract course documents from personal_materials / Moodle
    let documentContext = '';
    let artifactContext = '';
    let gradebookContext = '';
    const relevantDocTitles: string[] = [];
    const docMap = new Map<string, string>();
    const moodleCourseId = Number(courseId) || undefined;

    if (Array.isArray(gradebook) && gradebook.length > 0) {
      gradebookContext = gradebook
        .map((result, index) => {
          const score = `${result.score}/${result.maxScore}`;
          return `--- ĐIỂM LMS [${index + 1}] ---\nBài: ${result.name}\nĐiểm: ${score}${result.percentage ? ` (${result.percentage})` : ''}\nNhận xét: ${result.feedback || 'Chưa có nhận xét'}\nTrạng thái: ${result.passed === false ? 'Chưa đạt' : result.passed === true ? 'Đạt' : 'Chưa xác định'}`;
        })
        .join('\n\n');
    }

    // 1b. Retrieve upcoming assignments & deadlines for this course (LMS Context Harvesting)
    let deadlineContext = '';
    const nowTimestamp = Date.now();
    let courseDeadlines: Array<{ name: string; due: string; type?: string }> = [];

    if (Array.isArray(upcomingDeadlines) && upcomingDeadlines.length > 0) {
      courseDeadlines = upcomingDeadlines
        .filter(d => d.timestamp > nowTimestamp)
        .slice(0, 6)
        .map(d => ({
          name: d.name,
          due: new Date(d.timestamp).toLocaleString('vi-VN', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          }),
          type: d.type,
        }));
    }

    if (courseDeadlines.length === 0 && moodleCourseId) {
      if (supabaseAdmin) {
        try {
          const { data: dbEvts } = await supabaseAdmin
            .from('events')
            .select('title, deliver_time, event_type')
            .eq('moodle_course_id', moodleCourseId)
            .gte('deliver_time', new Date().toISOString())
            .order('deliver_time', { ascending: true })
            .limit(6);

          if (dbEvts && dbEvts.length > 0) {
            courseDeadlines = dbEvts.map(e => ({
              name: e.title,
              due: new Date(e.deliver_time).toLocaleString('vi-VN', {
                hour: '2-digit',
                minute: '2-digit',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              }),
              type: e.event_type,
            }));
          }
        } catch (evtErr) {
          console.warn('Could not query events via Supabase in tutor:', evtErr);
        }
      }
    }

    if (courseDeadlines.length > 0) {
      deadlineContext = courseDeadlines
        .map(
          (d, idx) =>
            `- [${idx + 1}] ${d.name} (Hạn chót: ${d.due}${d.type ? ` | Phân loại: ${d.type}` : ''})`
        )
        .join('\n');
    }

    if (moodleCourseId) {
      try {
        const artifacts = await getLearningArtifacts({
          userId: Number(userId) || 4,
          moodleCourseId,
          limit: 10,
        });
        if (artifacts.length > 0) {
          artifactContext = artifacts
            .slice(0, 5)
            .map((artifact, index) => {
              const title = artifact.title || artifact.artifact_type || 'Học liệu';
              return `- [Học liệu ${index + 1}] ${artifact.artifact_type.toUpperCase()}: "${title}"`;
            })
            .join('\n');
        }
      } catch (artifactErr) {
        console.warn('Could not query learning artifacts in tutor:', artifactErr);
      }
    }

    if (moodleCourseId) {
      try {
        const mats = await getPersonalMaterials({ moodleCourseId, limit: 10 });
        if (mats) {
          for (const mat of mats) {
            if (mat.storage_url && mat.title && !docMap.has(String(mat.title).toLowerCase())) {
              try {
                const text = await parseDocumentFromUrl(String(mat.storage_url), String(mat.title));
                if (text && text.length > 50) docMap.set(String(mat.title).toLowerCase(), text);
              } catch {
                // ignore unavailable material
              }
            }
          }
        }
      } catch (firebaseError) {
        console.warn('Firebase personal_materials query in tutor:', firebaseError);
      }

    }

    // 1c. Prompt-Aware Metadata Filtering ("Judge the book by its cover")
    // Pre-filters candidate sources by matching prompt keywords against document titles,
    // URL slugs, section names, and chapter numbers BEFORE full-text fetching, chunking,
    // or requesting embeddings from Gemini.
    // This saves 80-90% of Gemini embedding quota and keeps Gemini (the team captain) protected from rate limits.
    const preFilteredSources = filterSourcesByPromptMetadata(effectiveSources, question);

    // Separate LMS Course Documents vs On-The-Fly In-Memory Sources (Web Links, Personal Uploads)
    // Rule (Enterprise RAG): Web links, external articles, and student uploads MUST NEVER be stored into Supabase pgvector (0MB footprint).
    // They are parsed and chunked purely in-memory (On-The-Fly RAG) and filtered via Cohere Rerank.
    const studentSources = preFilteredSources.filter(isWebOrTransientSource);
    const lmsSources = preFilteredSources.filter(s => !isWebOrTransientSource(s));

    // A. For LMS sources in Supabase pgvector:
    let storedLmsChunks: DocumentChunk[] = [];
    if (moodleCourseId && lmsSources.length > 0) {
      try {
        const existingLmsFileIds = await getExistingCourseFileIds(moodleCourseId);

        // Files that need extraction & vectorization into Supabase
        const lmsToIngest = lmsSources.filter(src => {
          const fid = Number(src.fileId || src.moduleId);
          return fid && !existingLmsFileIds.has(fid);
        });

        if (lmsToIngest.length > 0) {
          await Promise.allSettled(
            lmsToIngest.map(async src => {
              if (!src.url) return;
              try {
                const extractedText = await parseDocumentFromUrl(src.url, src.name);
                if (extractedText && extractedText.trim().length > 20) {
                  const fid = Number(src.fileId || src.moduleId) || 1;
                  await vectorizeAndStoreLmsSource({
                    moodleCourseId,
                    moodleFileId: fid,
                    documentTitle: src.name,
                    text: extractedText,
                    metadata: {
                      sectionId: src.sectionId,
                      sectionName: src.sectionName,
                      chapter: src.chapter || extractChapterNumber(src.name) || undefined,
                      courseId: moodleCourseId,
                      courseCode,
                    },
                  });
                  docMap.set(src.name.toLowerCase(), extractedText);
                }
              } catch (parseErr) {
                console.warn(`Could not vectorize LMS document ${src.name}:`, parseErr);
              }
            })
          );
        }

        // Garbage collection / Sweep in background: clean up any orphaned Moodle vectors
        const activeLmsFileIds = lmsSources
          .map(s => Number(s.fileId || s.moduleId))
          .filter(id => Boolean(id) && !isNaN(id));
        if (activeLmsFileIds.length > 0) {
          sweepOrphanedCourseEmbeddings(moodleCourseId, activeLmsFileIds).catch(() => {});
        }

        // Retrieve stored LMS vectors from Supabase
        storedLmsChunks = await getStoredCourseEmbeddings(moodleCourseId, {
          docTitles: lmsSources.map(s => s.name),
        });
      } catch (lmsVecErr) {
        console.warn('LMS pgvector retrieval note:', lmsVecErr);
      }
    }

    // B. For Student personal uploads: Traditional in-memory RAG
    const studentUrlsToFetch = studentSources.filter(
      src => src.url && !docMap.has(src.name.toLowerCase())
    );
    if (studentUrlsToFetch.length > 0) {
      await Promise.allSettled(
        studentUrlsToFetch.map(async src => {
          try {
            const extractedText = await parseDocumentFromUrl(src.url!, src.name);
            if (extractedText && extractedText.trim()) {
              docMap.set(src.name.toLowerCase(), extractedText);
            }
          } catch (parseErr) {
            console.warn(`Could not parse student document ${src.name}:`, parseErr);
          }
        })
      );
    }

    // Compile student documents
    const compiledStudentDocs: RawDocument[] = [];
    for (const src of studentSources) {
      const lowerName = src.name.toLowerCase();
      let text = docMap.get(lowerName) || '';
      if (!text) {
        for (const [key, val] of docMap.entries()) {
          if (key.includes(lowerName) || lowerName.includes(key)) {
            text = val;
            break;
          }
        }
      }
      if (text && text.trim() && !compiledStudentDocs.some(d => d.title === src.name)) {
        compiledStudentDocs.push({
          title: src.name,
          text,
          metadata: {
            sectionId: src.sectionId,
            sectionName: src.sectionName,
            chapter: src.chapter || extractChapterNumber(src.name) || undefined,
            courseId: moodleCourseId,
            courseCode,
          },
        });
        relevantDocTitles.push(src.name);
      }
    }

    // If LMS pgvector had 0 chunks (e.g. Supabase table empty or offline fallback), also compile LMS docs to memory
    if (storedLmsChunks.length === 0 && lmsSources.length > 0) {
      const remainingUrls = lmsSources.filter(
        src => src.url && !docMap.has(src.name.toLowerCase())
      );
      if (remainingUrls.length > 0) {
        await Promise.allSettled(
          remainingUrls.map(async src => {
            try {
              const extractedText = await parseDocumentFromUrl(src.url!, src.name);
              if (extractedText && extractedText.trim()) {
                docMap.set(src.name.toLowerCase(), extractedText);
              }
            } catch {}
          })
        );
      }

      for (const src of lmsSources) {
        const lowerName = src.name.toLowerCase();
        let text = docMap.get(lowerName) || '';
        if (!text) {
          for (const [key, val] of docMap.entries()) {
            if (key.includes(lowerName) || lowerName.includes(key)) {
              text = val;
              break;
            }
          }
        }
        if (text && text.trim() && !compiledStudentDocs.some(d => d.title === src.name)) {
          compiledStudentDocs.push({
            title: src.name,
            text,
            metadata: {
              sectionId: src.sectionId,
              sectionName: src.sectionName,
              chapter: src.chapter || extractChapterNumber(src.name) || undefined,
              courseId: moodleCourseId,
              courseCode,
            },
          });
          relevantDocTitles.push(src.name);
        }
      }
    }

    // Index student documents into RAM chunks
    let indexedStudentChunks: DocumentChunk[] = [];
    if (compiledStudentDocs.length > 0) {
      try {
        indexedStudentChunks = await indexDocuments(compiledStudentDocs);
      } catch (idxErr) {
        console.warn('Index student documents error:', idxErr);
      }
    }

    // Combine candidate chunks: Persistent pgvector chunks + In-memory student chunks
    const allCandidateChunks: DocumentChunk[] = [...storedLmsChunks, ...indexedStudentChunks];

    // Detect structural / meta queries about the selected documents (TOC, chapters, overview, summary)
    const lowerQ = question.toLowerCase();
    const isDocOverviewQuery =
      lowerQ.includes('mục lục') ||
      lowerQ.includes('tóm tắt') ||
      lowerQ.includes('tổng hợp') ||
      lowerQ.includes('tổng quan') ||
      lowerQ.includes('tài liệu trên') ||
      lowerQ.includes('tài liệu này') ||
      lowerQ.includes('bao nhiêu chương') ||
      lowerQ.includes('các chương') ||
      lowerQ.includes('nội dung của tài liệu') ||
      lowerQ.includes('gồm những gì') ||
      lowerQ.includes('table of contents') ||
      lowerQ.includes('overview') ||
      lowerQ.includes('outline');

    let ragDocuments: Array<{ id?: string; title?: string; text: string }> = [];
    let relevantChunks: DocumentChunk[] = [];
    let isParametricFallback = false;

    if (allCandidateChunks.length > 0) {
      try {
        if (isDocOverviewQuery) {
          // ── Issue 2 Fix: TOC Metadata Bypass ──
          // Step 1: Check for pre-extracted TOC chunks (page_number = -1) already loaded in candidates
          const tocChunks = allCandidateChunks.filter(c => c.chunkIndex === -1);

          if (tocChunks.length > 0) {
            documentContext = tocChunks
              .map((chunk, idx) => `--- TÀI LIỆU [${idx + 1}]: "${chunk.docTitle}" (Mục lục & Cấu trúc đầy đủ) ---\n${chunk.text}`)
              .join('\n\n');
            ragDocuments = tocChunks.map((c, idx) => ({
              id: `doc_${idx + 1}`,
              title: c.docTitle,
              text: c.text,
            }));
            relevantChunks = tocChunks;
          } else {
            // Step 2: Try fetching TOC directly from Supabase (bypasses RAG vector search)
            const docTitles = Array.from(new Set(allCandidateChunks.map(c => c.docTitle)));
            let tocFetched = false;

            if (moodleCourseId) {
              try {
                const tocResults = await getDocumentTOC(moodleCourseId, { docTitles });
                if (tocResults.length > 0) {
                  documentContext = tocResults
                    .map((toc, idx) => `--- TÀI LIỆU [${idx + 1}]: "${toc.docTitle}" (Mục lục & Cấu trúc đầy đủ) ---\n${toc.tocText}`)
                    .join('\n\n');
                  ragDocuments = tocResults.map((toc, idx) => ({
                    id: `doc_${idx + 1}`,
                    title: toc.docTitle,
                    text: toc.tocText,
                  }));
                  relevantChunks = allCandidateChunks.slice(0, 5);
                  tocFetched = true;
                }
              } catch (tocErr) {
                console.warn('[TOC Bypass] Fetch failed, using fallback:', tocErr);
              }
            }

            // Step 3: Fallback — use lead chunks with generous boundaries (8 chunks, 6000 chars)
            if (!tocFetched) {
              const leadChunks: DocumentChunk[] = [];
              documentContext = docTitles
                .map((title, idx) => {
                  const docChunks = allCandidateChunks
                    .filter(c => c.docTitle === title)
                    .sort((a, b) => a.chunkIndex - b.chunkIndex)
                    .slice(0, 8);
                  leadChunks.push(...docChunks);
                  const previewText = docChunks.map(c => c.text).join('\n').slice(0, 6000);
                  return `--- TÀI LIỆU [${idx + 1}]: "${title}" (Tổng quan & trích đoạn đầu) ---\n${previewText}`;
                })
                .join('\n\n');
              relevantChunks = leadChunks;
              ragDocuments = leadChunks.slice(0, 20).map((c, idx) => ({
                id: `doc_${idx + 1}`,
                title: c.docTitle,
                text: c.text,
              }));
            }
          }
        } else {
          // Metadata Filtering (Chapter / Section)
          let candidateChunks = allCandidateChunks;
          const targetSectionId = sectionId;
          const targetSectionName = sectionName?.toLowerCase();
          const queryChapter = extractChapterNumber(searchQuery) || extractChapterNumber(question);
          const targetChapter = chapter ? String(chapter).toLowerCase() : queryChapter;

          // Only restrict by metadata if NOT in external creative mode
          if (ragMode !== 'creative' && (targetSectionId !== undefined || targetSectionName || targetChapter)) {
            const filtered = allCandidateChunks.filter(chunk => {
              const meta = chunk.metadata;
              if (targetSectionId !== undefined && meta?.sectionId !== undefined) {
                if (String(meta.sectionId) === String(targetSectionId)) return true;
              }
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
              if (targetSectionName && meta?.sectionName) {
                if (meta.sectionName.toLowerCase().includes(targetSectionName)) return true;
              }
              return false;
            });

            if (filtered.length > 0) {
              console.log(
                `[RAG Metadata Filter] Restricted vector search from ${allCandidateChunks.length} down to ${filtered.length} chunks`
              );
              candidateChunks = filtered;
            }
          }

          // ── RAG Stage 2: Sharp Retrieval via Supabase pgvector & Cohere Rerank ──
          // Băm vector & chấm điểm cosine + BM25 trên từ khóa cốt lõi (searchQuery) thay vì prompt nhiễu
          // Stage 1: Broad candidate collection (top 10 candidates)
          const broadCandidates = scoreAndSelectChunks(candidateChunks, searchQuery, {
            topK: 10,
            maxTotalChars: 12000,
            minSimilarity: ragMode === 'creative' ? 0.20 : 0.30, // Generous threshold to feed into reranker
            dynamicTopK: false,
          });

          // Stage 2: Cross-Encoder Scanning via Cohere Rerank API (Dedicated Quota, Zero Chat Quota Burn)
          if (broadCandidates.length > 1) {
            try {
              const reranked = await rerankChunksWithCohere(searchQuery, broadCandidates, {
                topN: 3,
                minScore: ragMode === 'creative' ? 0.0005 : 0.001,
              });
              if (reranked && reranked.length > 0) {
                relevantChunks = reranked;
                console.log(
                  `[IELTS Scanning Gatekeeper] Cohere Reranker selected ${relevantChunks.length} ultra-relevant chunks (Top score: ${relevantChunks[0]?.similarityScore})`
                );
              }
            } catch (rerankErr) {
              console.warn('[IELTS Scanning Gatekeeper] Cohere rerank skipped/error, using vector scoring:', rerankErr);
            }
          }

          // Fallback if Cohere Rerank was unavailable: use Dynamic Top-K vector scoring on searchQuery
          if (relevantChunks.length === 0) {
            relevantChunks = scoreAndSelectChunks(candidateChunks, searchQuery, {
              topK: 5,
              maxTotalChars: 8000,
              minSimilarity: ragMode === 'creative' ? 0.25 : 0.38,
              dynamicTopK: true,
            });
          }

          if (relevantChunks.length > 0) {
            // Parent-Child Hydration: Hydrate selected chunks with 100% full text from Firebase Firestore
            relevantChunks = await hydrateChunksWithParentText(relevantChunks);
            documentContext = formatChunksForPrompt(relevantChunks);
            ragDocuments = relevantChunks.map((c, idx) => ({
              id: `doc_${idx + 1}`,
              title: c.docTitle,
              text: c.text,
            }));
          } else if (ragMode === 'creative') {
            const firstChunk = allCandidateChunks[0];
            if (firstChunk) {
              documentContext = `--- TRÍCH ĐOẠN TỔNG QUAN: "${firstChunk.docTitle}" ---\n${firstChunk.text.slice(0, 1200)}`;
              ragDocuments = [{ id: 'doc_1', title: firstChunk.docTitle, text: firstChunk.text }];
            }
          } else if (ragMode === 'hybrid') {
            // Hybrid Mode Fallback: Chunks empty -> enable parametric pre-trained knowledge with transparency
            isParametricFallback = true;
            documentContext = '';
            ragDocuments = [];
          } else {
            // Strict Mode: When no chunk meets threshold, leave empty to trigger Circuit Breaker
            documentContext = '';
            ragDocuments = [];
          }
        }
      } catch (ragErr) {
        console.warn('Semantic RAG retrieval error, fallback to basic context:', ragErr);
        if (ragMode === 'creative') {
          const firstChunk = allCandidateChunks[0];
          if (firstChunk) {
            documentContext = `--- TRÍCH ĐOẠN: "${firstChunk.docTitle}" ---\n${firstChunk.text.slice(0, 1500)}`;
            ragDocuments = [{ id: 'doc_1', title: firstChunk.docTitle, text: firstChunk.text }];
          }
        } else if (ragMode === 'hybrid') {
          isParametricFallback = true;
          documentContext = '';
          ragDocuments = [];
        }
      }
    }

    if (allCandidateChunks.length === 0 && ragMode === 'hybrid') {
      isParametricFallback = true;
    }

    // ── Circuit Breaker (Ngắt mạch logic từ vòng gửi xe cho Strict RAG) ──
    // Trước khi gọi API của AI, kiểm tra mảng dữ liệu trả về từ Supabase pgvector / Cohere Rerank:
    // Nếu chunks.length === 0 hoặc điểm topScore dưới 0.5, hàm sẽ return luôn chuỗi:
    // "Tài liệu khóa học hiện tại không chứa thông tin này". LLM sẽ không bị gọi, tiết kiệm 100% token.
    const topScore = relevantChunks.length > 0
      ? Math.max(
          relevantChunks[0].similarityScore ?? 0,
          relevantChunks[0].rerankScore ?? 0
        )
      : 0;

    const isStrictCircuitBroken = ragMode === 'strict' && (relevantChunks.length === 0 || topScore < 0.5) && !isDocOverviewQuery;
    const strictCircuitNotice = getCircuitBreakerNotice(question);

    if (isStrictCircuitBroken) {
      if (isStream) {
        const encoder = new TextEncoder();
        const readableStream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ delta: strictCircuitNotice })}\n\n`)
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  done: true,
                  fullText: strictCircuitNotice,
                  sources: [],
                  model: 'Hệ thống LMS (Circuit Breaker)',
                  provider: 'system',
                  ragMode: 'strict',
                  isFallback: false,
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });

        return new Response(readableStream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      return NextResponse.json({
        answer: strictCircuitNotice,
        sources: [],
        model: 'Hệ thống LMS (Circuit Breaker)',
        provider: 'system',
        ragMode: 'strict',
        isFallback: false,
      });
    }

    // 2. Prepare System Prompt with Domain Guardrail & Answer Style
    const subjectName = course || 'môn học hiện tại';
    const selectedTopicsStr = effectiveSourceNames.length > 0
      ? effectiveSourceNames.join('; ')
      : 'Giáo trình và tài liệu môn học';

    let domainGuardrail = '';
    if (ragMode === 'strict') {
      domainGuardrail = `Bạn là công cụ trích xuất văn bản. CHỈ trả lời dựa trên dữ liệu nằm trong thẻ <document>. Tuyệt đối không sử dụng kiến thức bên ngoài. Nếu dữ liệu trong thẻ không đủ để trả lời, bạn BẮT BUỘC phải nói chính xác: 'Không có thông tin trong tài liệu'.
- Trích dẫn chính xác số thứ tự nguồn [1], [2] tương ứng khi trả lời.
- TRIỆT TIÊU VĂN MẪU & TIẾT KIỆM TOKEN: Cấm chào hỏi đầu câu, cấm kết luận thừa thãi cuối câu. Đi thẳng vào nội dung từ ký tự đầu tiên.`;
    } else if (ragMode === 'hybrid') {
      domainGuardrail = `Bạn là trợ lý học tập. Hãy ưu tiên tối đa việc sử dụng thông tin trong thẻ <document> để trả lời. Nếu thẻ <document> trống hoặc thiếu dữ kiện, bạn ĐƯỢC PHÉP dùng kiến thức nền tảng và tri thức chuyên ngành để giải thích đầy đủ, chính xác.
- QUY TẮC ANTI-FLUFF (TUYỆT ĐỐI KHÔNG PERFORMATIVE / KHÔNG MÀU MÈ NÓI VỀ NGUỒN):
  + TUYỆT ĐỐI KHÔNG BAO GIỜ nói các câu như: "Dựa trên các tài liệu bạn cung cấp...", "Dựa trên tài liệu được cung cấp...", "Dựa trên kiến thức mở rộng ngoài khóa học...", "Dựa trên các nguồn bên ngoài tôi tìm được...", "Based on the sources provided...", "Based on the external sources I found...".
  + ĐI THẲNG TRỰC TIẾP VÀO BẢN CHẤT VẤN ĐỀ TỪ TỪ ĐẦU TIÊN (Jump straight to the problem). Tuyệt đối không tạo banner, không tạo callout phân bua về nguồn gốc kiến thức.
- Trích dẫn chuẩn xác số thứ tự nguồn [1], [2] từ tài liệu có sẵn. Cấm chào hỏi xã giao, cấm kết bài thừa thãi.`;
    } else {
      // ragMode === 'creative'
      domainGuardrail = `Bạn là một giảng viên AI uyên bác. Hãy giải thích chi tiết, cặn kẽ và mở rộng vấn đề bằng các ví dụ thực tế, code mẫu hoặc xu hướng công nghệ mới nhất. Bạn được toàn quyền sử dụng kiến thức chuyên môn của mình.
- Dữ liệu trong thẻ <document> (nếu có) đóng vai trò tham khảo nhẹ, bạn không bị giới hạn trong thẻ này.
- TRIỆT TIÊU VĂN MẪU & TIẾT KIỆM TOKEN (ANTI-FLUFF - LỆNH CỨNG BẮT BUỘC): Cấm chào hỏi đầu câu, cấm chúc tụng sáo rỗng cuối câu. Đi thẳng vào nội dung từ từ đầu tiên.`;
    }

    const externalInstruction =
      ragMode === 'creative'
        ? `HƯỚNG DẪN MỞ RỘNG TRI THỨC (CREATIVE MODE - SÁNG TẠO & ANTI-FLUFF):
- Ưu tiên tính sáng tạo, linh hoạt sư phạm và liên hệ thực tiễn mở rộng dựa trên tri thức chuyên môn thực tế và tra cứu hiện đại thay vì bị bó hẹp trong tài liệu.
- CẤM VĂN MẪU GIAO TIẾP: Cấm chào hỏi đầu câu, cấm chúc tụng hay kết luận sáo rỗng cuối câu ("Hy vọng thông tin này giúp ích...", "Hy vọng câu trả lời..."). Đi thẳng vào nội dung chuyên môn ngay từ từ đầu tiên.
- LIÊN KẾT NGUỒN NGOÀI: Khi nhắc đến công cụ, tài liệu học thuật hoặc trang web chính thức, hãy dùng định dạng liên kết Markdown [Tên](https://...).`
        : ragMode === 'hybrid'
          ? `HƯỚNG DẪN CHẾ ĐỘ RAG LAI:
- Phân tích và giải thích dựa trên nội dung tài liệu và các chủ đề chuyên môn của môn học ${subjectName} đã chọn ("${selectedTopicsStr}").
- Bám sát giáo trình đã chọn. Nếu tài liệu có thông tin: Trích dẫn rõ ràng [1], [2].
- Nếu câu hỏi có khía cạnh mở rộng ngoài giáo trình: Minh bạch ranh giới giữa tài liệu học phần và phân tích bổ trợ.`
          : `HƯỚNG DẪN BÁM SÁT TÀI LIỆU (STRICT RAG):
- Phân tích và giải thích nghiêm ngặt dựa trên nội dung tài liệu của môn học ${subjectName} đã chọn ("${selectedTopicsStr}").
- Không suy đoán hay chêm xen kiến thức ngoài phạm vi các đoạn trích.`;

    const factualGuardrail = `QUY TẮC BẢO ĐẢM TÍNH XÁC THỰC LỊCH SỬ & SỰ KIỆN (ANTI-HALLUCINATION & FACTUAL ACCURACY - BẮT BUỘC):
- TUYỆT ĐỐI KHÔNG BỊA ĐẶT hay suy diễn sai lệch về: Mốc thời gian (năm/tháng/ngày), địa điểm tổ chức, nhân vật, số liệu và nội dung các kỳ Đại hội/sự kiện lịch sử (Ví dụ: Đại hội I họp 1935 tại Ma Cao, Đại hội II họp 1951 tại Chiêm Hóa - Tuyên Quang, Đại hội III họp 1960 tại Hà Nội, Đại hội IV họp 1976 tại Hà Nội, Đại hội VI Đổi mới họp 1986 tại Hà Nội, Đại hội XIV họp 1/2026 tại Hà Nội).
- NẾU thông tin chi tiết mốc lịch sử/số liệu không có trong tài liệu được cấp và bạn không chắc chắn 100%, PHẢI NÓI RÕ "Thông tin mốc thời gian/địa điểm này cần đối chiếu thêm theo giáo trình chính thức của môn học", TUYỆT ĐỐI KHÔNG TỰ GHÉP NĂM HOẶC ĐỊA ĐIỂM BỪA BÃI.
- KHÔNG dùng một khuôn mẫu hay khẩu hiệu chung chung sao chép lặp lại cho nhiều kỳ Đại hội hay nhiều sự kiện khác nhau.`;

    const isFeedbackReview = question.toLowerCase().includes('nhận xét') || question.toLowerCase().includes('feedback') || question.toLowerCase().includes('bài thi');
    const feedbackInstruction = isFeedbackReview
      ? `\nĐẶC BIỆT KHI SINH VIÊN HỎI VỀ NHẬN XÉT BÀI THI CỦA GIẢNG VIÊN:
- Phân tích chính xác nhận xét của giáo viên (str_feedback) được đề cập trong câu hỏi. Đi thẳng vào trọng tâm cần cải thiện, không chào hỏi xã giao.
- Đề xuất ngay các phương án hoặc chủ đề cụ thể để bắt đầu ôn tập từng bước nhằm giải quyết dứt điểm lỗ hổng kiến thức đó.\n`
      : '';

    const isQuizRemediation =
      question.toLowerCase().includes('bài kiểm tra') ||
      question.toLowerCase().includes('kết quả bài') ||
      question.toLowerCase().includes('lỗi sai') ||
      question.toLowerCase().includes('điểm mù') ||
      question.toLowerCase().includes('câu hỏi tôi bị') ||
      question.toLowerCase().includes('thực trạng bài thi');

    const remediationInstruction = isQuizRemediation
      ? `\nQUY TẮC PHÂN TÍCH BÀI THI & SỬA LỖI SAI (ADAPTIVE REMEDIATION - BẮT BUỘC):
- Sinh viên đang cần bạn phân tích các lỗi sai cụ thể trong bài kiểm tra để củng cố điểm số.
- BẮT BUỘC tập trung 100% vào các câu hỏi bị trừ điểm, các lựa chọn sai và các chủ đề yếu (weak concepts) được cung cấp trong câu hỏi.
- TUYỆT ĐỐI KHÔNG mở đầu bằng câu: "Hệ thống cần có nội dung cụ thể của câu hỏi" hay "Để phân tích chính xác nhất cần có đề bài". Toàn bộ nội dung câu hỏi và câu trả lời của sinh viên đã được cung cấp trực tiếp!
- TUYỆT ĐỐI KHÔNG giải thích dàn trải, lan man lý thuyết của toàn bộ môn học hoặc liệt kê toàn bộ các framework/chuyên đề không liên quan đến các câu sai.
- Hãy đi thẳng vào từng câu sai cụ thể: Phân tích tại sao đáp án đúng lại là như vậy, bẫy tư duy hoặc ngộ nhận khiến sinh viên chọn sai, và phương pháp nhớ/vận dụng chuẩn xác theo giáo trình môn học.\n`
      : '';

    const studentName = userName?.trim() || 'Sinh viên';
    const studentId = userId || 4;
    const lmsGroundingContext = `NGỮ CẢNH HỌC TẬP & DANH TÍNH SINH VIÊN (LMS GROUNDING):
- Người dùng hiện tại: ${studentName} (Moodle User ID: ${studentId}).
- Môn học đang mở: "${subjectName}"${courseCode ? ` [Mã môn: ${courseCode}]` : ''}${moodleCourseId ? ` [Course ID: ${moodleCourseId}]` : ''}.
${deadlineContext ? `- ÁP LỰC HỌC TẬP & DEADLINE SẮP TỚI CỦA MÔN NÀY:\n${deadlineContext}\n* HƯỚNG DẪN NHẮC NHỞ DEADLINE: Hãy trả lời câu hỏi của sinh viên ngắn gọn, chính xác, bám sát nội dung tài liệu môn học. Khi câu hỏi liên quan đến bài tập, ôn tập, chuẩn bị kiểm tra hoặc kết thúc phần giải thích, hãy khéo léo và tế nhị nhắc nhở sinh viên về hạn nộp bài tập sắp tới để chủ động hoàn thành đúng hạn.` : '- Môn học này hiện không có bài tập hoặc deadline nào sắp đến hạn trong tuần này.'}`;

    const styleInstruction = answerStyle === 'detailed'
      ? `PHONG CÁCH PHẢN HỒI: Chi tiết & Chuyên sâu (Phân tích toàn diện, cặn kẽ nguyên lý, dẫn chứng và ví dụ trực quan).`
      : `PHONG CÁCH PHẢN HỒI: Nhanh & Trọng tâm (Trình bày súc tích trong 1-2 đoạn văn ngắn, đi thẳng vào bản chất và giải pháp then chốt).`;

    const systemInstruction = `Bạn là Trợ lý Học tập AI chuyên trách môn "${subjectName}" trên hệ thống LMS Assistant.

${lmsGroundingContext}

${domainGuardrail}

${factualGuardrail}

${styleInstruction}

${externalInstruction}
${feedbackInstruction}
${remediationInstruction}
QUY TẮC PHONG CÁCH & TRÌNH BÀY HỌC THUẬT (BẮT BUỘC):
1. TRIỆT TIÊU VĂN MẪU, LỜI CHÀO & THÔNG BÁO NGUỒN (ANTI-FLUFF - KHÔNG PERFORMATIVE):
- TUYỆT ĐỐI CẤM MỌI CÂU TỪ CHÀO HỎI VÀ XÃ GIAO ĐẦU CÂU: CẤM nói "Chào bạn", "Chào các bạn", "Chào em", "Xin chào", "Dạ vâng", "Thưa bạn", v.v. Kèm mọi icon chào mừng (như 👋, 😊, 🎓).
- TUYỆT ĐỐI CẤM MỌI CÂU THÔNG BÁO NGUỒN (CẤM: "Dựa trên tài liệu bạn cung cấp...", "Dựa trên kiến thức mở rộng ngoài khóa học...", "Dựa trên các nguồn bên ngoài tôi tìm được...", "Theo tài liệu...", "Based on the sources provided...", "Based on the external sources I found..."). Nguồn tài liệu đã có hệ thống trích dẫn [1], [2] và huy hiệu nguồn tự động hiển thị ở chân trang.
- ĐI THẲNG TRỰC TIẾP VÀO NỘI DUNG VẤN ĐỀ (Jump straight to the problem): Bắt đầu câu trả lời ngay từ từ đầu tiên bằng bản chất chuyên môn hoặc định nghĩa giải pháp (Ví dụ: "ReactJS là thư viện JavaScript...", KHÔNG CÓ bất kỳ chữ chào hay chữ rào đón nguồn nào đứng trước).
- TUYỆT ĐỐI CẤM VĂN MẪU KẾT BÀI THỪA: Cấm các câu như "Hy vọng thông tin này giúp ích cho bạn...", "Chúc bạn học tốt...", "Tóm lại,...", "Kết luận:...". Ngắt bài ngay khi hoàn thành nội dung trọng tâm.
2. ĐỊNH DẠNG CODE & THUẬT NGỮ CHUẨN MỰC:
- Các thuật ngữ chuyên môn, thư viện, tên hàm, API, lệnh (như \`router.push\`, \`router.query\`, \`ReactJS\`, \`Next.js\`, \`useState\`) BẮT BUỘC đặt trong cặp backtick \`code\`. In đậm **từ khóa then chốt** để tăng tính trực quan.
3. CHẶN ĐỨNG TỪ NGỮ ĐIỀN KHUYẾT RẬP KHUÔN (ANTI-PLACEHOLDER):
- TUYỆT ĐỐI KHÔNG xuất các thẻ placeholder giữ chỗ rập khuôn dạng: [Tên sinh viên], [Tên bạn], [Ngày/tháng], [Chèn ví dụ tại đây], [Nội dung...].
- Tự động điền dữ liệu thực tế từ tài liệu môn học hoặc diễn đạt thành câu văn tự nhiên, hoàn chỉnh 100% để sinh viên đọc hiểu ngay mà không cần điền khuyết thủ công.
4. ZERO-SHOT ROLEPLAY (NHẬP VAI GIA SƯ THỰC CHIẾN TỰ NHIÊN):
- Nhập vai Gia Sư AI / Chuyên gia Học thuật Đại học, thấu hiểu khó khăn của người học và giải thích sinh động, truyền cảm hứng.
- Trả lời thực tế, gắn liền ứng dụng và tư duy chuyên môn; tuyệt đối không nói giọng robot hay lý thuyết suông rập khuôn sách giáo khoa lỗi thời.
5. VĂN PHONG CHUẨN MỰC, SƯ PHẠM: Sử dụng ngôn ngữ khoa học, trang trọng, chính xác, khách quan và mạch lạc. Tuyệt đối không dùng phong cách cợt nhả, suồng sã, mỉa mai hay tiếng lóng mạng xã hội.
6. QUY TẮC ĐỒNG BỘ NGÔN NGỮ (LANGUAGE CONFORMANCE - BẮT BUỘC):
- Luôn nhận diện và phản hồi bằng CHÍNH XÁC ngôn ngữ mà sinh viên sử dụng trong câu hỏi (English, Español, Français, Deutsch, 日本語, 中文...).
- TIẾNG VIỆT LUÔN LÀ NGÔN NGỮ MẶC ĐỊNH (Vietnamese is always the default): Nếu câu hỏi bằng tiếng Việt, câu hỏi hỗn hợp hoặc không rõ ngôn ngữ, BẮT BUỘC phản hồi hoàn toàn bằng Tiếng Việt chuẩn mực sư phạm.
- Toàn bộ lời giải thích và phân tích phải đồng nhất theo ngôn ngữ của câu hỏi (trừ thuật ngữ code/API kỹ thuật quốc tế giữ nguyên trong \`code\`).
7. TOÁN HỌC: Sử dụng LaTeX chuẩn dạng $công_thức$ (ví dụ: $O(1)$, $O(N^2)$, $N - 1$). Tuyệt đối KHÔNG gõ lệch thành \\$ hay $\\.
8. BẢNG BIỂU: Khi lập bảng so sánh (Markdown Table), dùng thẻ <br/> để xuống dòng giữa các ý trong cùng một ô. Không đặt code block 3 dấu nháy (\`\`\`) bên trong ô bảng Markdown; hãy đặt code block ở bên ngoài/dưới bảng.
9. LIÊN KẾT NGUỒN NGOÀI: Mọi liên kết URL dẫn nguồn tham khảo bên ngoài phải viết dưới dạng Markdown [Tên trang hoặc tài liệu](https://...). Tuyệt đối không đặt URL trong dấu backtick \`https://...\`.
10. TRÍCH DẪN NGUỒN TÀI LIỆU & HỌC LIỆU (TINH GỌN & CHỐNG SPAM):
- Khi tham khảo từ các đoạn trích giáo trình hoặc học liệu đã lưu được cung cấp, nếu cần ghi nhận nguồn, CHỈ dùng số thứ tự ngắn gọn trong ngoặc vuông dạng [1], [2], [5].
- TUYỆT ĐỐI KHÔNG viết từ ngữ dài dòng như "[trích đoạn 5]", "[đoạn trích 5]", "[HỌC LIỆU ĐÃ LƯU 2]" hay "[học liệu 2]".
- TUYỆT ĐỐI KHÔNG lặp lại mã trích dẫn sau mỗi dấu phẩy, mỗi câu ngắn hay mỗi gạch đầu dòng liên tiếp. Trong cùng một đoạn văn hoặc một bảng, chỉ cần trích dẫn 1 lần duy nhất ở luận điểm trọng tâm nhất để đảm bảo văn bản sạch sẽ, thông suốt và dễ theo dõi.
11. TUYỆT ĐỐI KHÔNG LẶP TIÊU ĐỀ: Tuyệt đối KHÔNG sao chép, trích lại hay lặp lại các tiêu đề trích đoạn dạng "[ĐOẠN TRÍCH TÀI LIỆU ...]" hay "--- NỘI DUNG TỪ TÀI LIỆU ---" vào trong câu trả lời. Hãy đi thẳng vào phân tích, giải thích và trình bày mạch lạc nội dung chuyên môn.`;

    let contextSection = '';
    if (gradebookContext.trim()) {
      contextSection += `=== SỔ ĐIỂM CỦA SINH VIÊN (DỮ LIỆU ĐIỂM SỐ NỘI BỘ, KHÔNG PHẢI NỘI DUNG TÀI LIỆU BÀI GIẢNG) ===\n${gradebookContext}\n\n`;
    }
    if (deadlineContext.trim()) {
      contextSection += `=== LỊCH TRÌNH & HẠN CHÓT SẮP TỚI CỦA MÔN HỌC (DÙNG KHI HỎI VỀ DEADLINE/BÀI TẬP/THI) ===\n${deadlineContext}\n\n`;
    }
    if (artifactContext.trim()) {
      contextSection += `=== HỌC LIỆU ĐÃ TẠO VÀ LƯU CHO MÔN HỌC ===\n${artifactContext}\n\n`;
    }
    contextSection += `=== CÁC TÀI LIỆU BÀI GIẢNG / HỌC TẬP ĐƯỢC CHỌN TỪ CỘT TRÁI ===\n<document>\n`;
    if (documentContext.trim()) {
      contextSection += `${documentContext}\n</document>\n\n`;
    } else {
      contextSection +=
        ragMode === 'creative'
          ? `(Chế độ Sáng tạo đang BẬT: Trả lời tự nhiên dựa trên tri thức chuyên môn và thông tin mở rộng)\n</document>\n\n`
          : isParametricFallback
            ? `(Tài liệu giáo trình chưa có dữ kiện về câu hỏi này: Sử dụng tri thức mở rộng có thông báo minh bạch)\n</document>\n\n`
            : `(Không có tài liệu nào được tích chọn hoặc không tìm thấy thông tin phù hợp trong các tài liệu đã chọn)\n</document>\n\n`;
    }

    // ── Issue 3 Fix: Prompt Anchoring ──
    // Place behavior constraints at the END of the user message (last thing AI reads)
    const promptAnchor = `\n\n[LỆNH BỔ TRỢ BẮT BUỘC - ANTI-FLUFF, ANTI-PLACEHOLDER & TIẾT KIỆM TOKEN]:
1. TUYỆT ĐỐI CẤM CHÀO HỎI VÀ CẤM THÔNG BÁO NGUỒN (CẤM: "Chào bạn", "Dựa trên tài liệu bạn cung cấp...", "Dựa trên kiến thức mở rộng...", "Based on the sources provided..."). ĐI THẲNG TRỰC TIẾP VÀO NỘI DUNG VẤN ĐỀ TỪ TỪ ĐẦU TIÊN (JUMP STRAIGHT TO THE PROBLEM).
2. CẤM KẾT BÀI VĂN MẪU ("Hy vọng...", "Tóm lại...", "Kết luận:...").
3. ANTI-PLACEHOLDER: Tuyệt đối không để lại các thẻ giữ chỗ [Tên bạn], [Chèn ví dụ], [Ngày/tháng]. Diễn đạt câu văn hoàn chỉnh 100%.
4. NGÔN NGỮ: Sử dụng CHÍNH XÁC ngôn ngữ của câu hỏi (English -> English, Español -> Español, Français -> Français...), mặc định luôn là Tiếng Việt nếu câu hỏi bằng tiếng Việt hoặc không rõ ngôn ngữ.
${answerStyle === 'concise' && !isDocOverviewQuery
  ? '5. PHONG CÁCH NHANH / TRỌNG TÂM: Trả lời súc tích, thẳng thắn, trọng tâm trong 1-2 đoạn văn ngắn.\n6. Nếu hỏi về lựa chọn công nghệ/giải pháp: Chọn 1 phương án tối ưu nhất kèm 1-2 lý do then chốt.\n7. CHỈ XUẤT CÂU TRẢ LỜI: Cấm xuất suy nghĩ nội tâm, cấm viết nháp, cấm đếm từ, cấm lặp lại chỉ thị.'
  : '5. PHONG CÁCH CHI TIẾT / CHUYÊN SÂU: Đảm bảo độ dài tối thiểu bằng 1/2 giới hạn token của chế độ nhanh (tối thiểu từ 350 - 450 từ trở lên), phân tích cặn kẽ mọi khía cạnh, nguyên lý, dẫn chứng và ví dụ trực quan.'}`;

    const userPrompt = `Ngữ cảnh:
${contextSection}
---
CÂU HỎI CỦA SINH VIÊN: ${question}${promptAnchor}`;

    // ── Token Limit: Ample headroom to prevent cut-offs mid-sentence ──
    let maxTokensLimit: number | undefined;
    if (isDocOverviewQuery) {
      maxTokensLimit = 1500;
    } else if (answerStyle === 'concise') {
      maxTokensLimit = 800; // Giới hạn token đối với hướng trả lời nhanh
    } else {
      maxTokensLimit = 3000; // Hướng trả lời chi tiết: độ dài tối thiểu bằng 1/2 max_token của hướng nhanh
    }

    // Dynamic Temperature & Top_P by RAG Mode:
    // Strict: temperature = 0.0, top_p = 0.0 (Zero creativity, strictly deterministic facts)
    // Hybrid: temperature = 0.35 (0.30 grounded / 0.40 fallback), top_p = 0.5
    // Creative: temperature = 0.80 (0.7 - 0.9 range), top_p = 0.9
    const effectiveTemperature =
      ragMode === 'strict'
        ? 0.0
        : ragMode === 'hybrid'
          ? (isParametricFallback ? 0.40 : 0.35)
          : (answerStyle === 'concise' ? 0.75 : 0.85);
    const effectiveTopP =
      ragMode === 'strict'
        ? 0.0
        : ragMode === 'hybrid'
          ? 0.5
          : 0.9;
    const effectiveDocuments = ragMode === 'creative' ? undefined : ragDocuments;
    const outOfContextNotice =
      ragMode === 'strict'
        ? `⚠️ **Tài liệu không đề cập nội dung này**\n\nNội dung bạn hỏi không có trong các đoạn trích tài liệu được cấp. Do đang ở **Chế độ Bám sát nghiêm ngặt (Strict RAG)**, câu trả lời bị giới hạn trong phạm vi tài liệu đã chọn.\n\n💡 *Gợi ý:* Hãy chuyển sang chế độ **Lai (Hybrid)** ở thanh công cụ bên dưới để AI giải đáp mở rộng.`
        : `Tài liệu bạn đã tích chọn không đề cập đến nội dung này. Vui lòng tích chọn thêm tài liệu phù hợp ở danh sách bên trái hoặc chuyển sang chế độ **Lai (Hybrid)** / **Sáng tạo** để AI tra cứu mở rộng.`;

    // ── Stop Sequences (Chuỗi dừng): Triệt tiêu văn mẫu kết bài thừa ──
    // Lưu ý: Không dùng '\n\n' làm chuỗi dừng để tránh ngắt họng câu trả lời sau dòng tiêu đề/đoạn đầu tiên.
    let effectiveStopSequences: string[] | undefined = stop || stopSequences;
    if (!effectiveStopSequences || effectiveStopSequences.length === 0) {
      effectiveStopSequences = [...COMMON_FLUFF_STOP_SEQUENCES];
    }

    if (isStream) {
      const encoder = new TextEncoder();
      const readableStream = new ReadableStream({
        async start(controller) {
          let accumulatedText = '';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let streamGroundingMetadata: any = null;

          try {
            const effectiveCategory = detectTaskCategory({
              system: systemInstruction,
              userPrompt,
              history: history.slice(-6).map(msg => ({
                role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
                content: msg.text,
              })),
              documents: effectiveDocuments,
              taskCategory: answerStyle === 'concise' ? 'basic' : undefined,
            });

            const streamResult = await generateTextStream(model, {
              system: systemInstruction,
              userPrompt,
              history: history.slice(-6).map(msg => ({
                role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
                content: msg.text,
              })),
              temperature: effectiveTemperature,
              topP: effectiveTopP,
              maxTokens: maxTokensLimit,
              documents: effectiveDocuments,
              googleSearchGrounding: ragMode === 'creative',
              allowExternalSource: ragMode === 'creative',
              taskCategory: effectiveCategory,
              stop: effectiveStopSequences,
              ragMode,
              onMeta: (meta) => {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      meta: true,
                      model: meta.modelName,
                      modelId: meta.modelId,
                      provider: meta.provider,
                    })}\n\n`
                  )
                );
              },
              onDelta: (delta: string) => {
                accumulatedText += delta;
                // If the generation begins with "[OUT_OF_CONTEXT", buffer and suppress streaming raw tag to UI
                if (accumulatedText.trim().startsWith('[OUT_OF_CONTEXT')) {
                  return;
                }
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)
                );
              },
            });

            if (!accumulatedText && streamResult.text) {
              accumulatedText = streamResult.text;
              if (!accumulatedText.trim().startsWith('[OUT_OF_CONTEXT')) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta: accumulatedText })}\n\n`)
                );
              }
            }
            streamGroundingMetadata = streamResult.groundingMetadata || null;

            const isPedagogicalTask =
              question.toLowerCase().includes('câu hỏi') ||
              question.toLowerCase().includes('thảo luận') ||
              question.toLowerCase().includes('bài tập') ||
              question.toLowerCase().includes('ôn tập') ||
              question.toLowerCase().includes('soạn') ||
              question.toLowerCase().includes('trắc nghiệm') ||
              question.toLowerCase().includes('đề thi');

            const isOutOfContext =
              ragMode === 'strict' &&
              !isPedagogicalTask &&
              (accumulatedText.includes('[OUT_OF_CONTEXT]') || accumulatedText.includes('[MISSING_CONTEXT]'));
            if (isOutOfContext) {
              accumulatedText = outOfContextNotice;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ delta: outOfContextNotice, replace: true })}\n\n`)
              );
            } else if (accumulatedText.includes('[OUT_OF_CONTEXT]')) {
              accumulatedText = accumulatedText.replace(/\[OUT_OF_CONTEXT\]/gi, '').trim();
            }

            if (!isOutOfContext && accumulatedText) {
              const stripped = stripFluff(accumulatedText);
              if (stripped !== accumulatedText) {
                accumulatedText = stripped;
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta: accumulatedText, replace: true })}\n\n`)
                );
              }
            }

            if (accumulatedText && !isPersonal && !isOutOfContext) {
              storeCachedAnswer({
                question,
                canonicalQuery: searchQuery,
                answer: accumulatedText,
                courseId: effectiveCourseId,
              }).catch(() => {});
            }

            const citedSources = isOutOfContext
              ? []
              : compileAllSources({
                  aiText: accumulatedText,
                  ragMode,
                  relevantChunks,
                  isParametricFallback,
                  groundingMetadata: streamGroundingMetadata,
                  course,
                  question,
                });

            const responseModel = streamResult.modelName || streamResult.modelId || 'AI Assistant';
            const responseProvider = streamResult.provider || 'auto';

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                done: true,
                fullText: accumulatedText,
                sources: citedSources,
                model: responseModel,
                modelId: streamResult.modelId,
                provider: responseProvider,
                ragMode,
                isFallback: isParametricFallback,
                finishReason: streamResult.finishReason || 'stop',
              })}\n\n`)
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (streamErr) {
            console.error('Stream generation error in tutor:', streamErr);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  error:
                    streamErr instanceof Error
                      ? streamErr.message
                      : 'Lỗi trong quá trình tạo phản hồi AI.',
                })}\n\n`
              )
            );
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // 3. AI Execution via unified model registry (Non-streaming JSON fallback)
    let aiText = '';
    let responseModel = 'AI Assistant';
    let responseProvider = 'auto';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let groundingMetadata: any = null;
    let resultFinishReason = 'stop';

    try {
      const effectiveCategory = detectTaskCategory({
        system: systemInstruction,
        userPrompt,
        history: history.slice(-6).map(msg => ({
          role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: msg.text,
        })),
        documents: effectiveDocuments,
        taskCategory: answerStyle === 'concise' ? 'basic' : undefined,
      });

      const result = await generateText(model, {
        system: systemInstruction,
        userPrompt,
        history: history.slice(-6).map(msg => ({
          role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: msg.text,
        })),
        temperature: effectiveTemperature,
        topP: effectiveTopP,
        maxTokens: maxTokensLimit,
        documents: effectiveDocuments,
        googleSearchGrounding: ragMode === 'creative',
        allowExternalSource: ragMode === 'creative',
        taskCategory: effectiveCategory,
        stop: effectiveStopSequences,
        ragMode,
      });
      aiText = result.text;
      groundingMetadata = result.groundingMetadata || null;
      if (result.finishReason) resultFinishReason = result.finishReason;
      if (result.modelName) responseModel = result.modelName;
      if (result.provider) responseProvider = result.provider;
    } catch (err) {
      console.warn('AI generation failed:', err);
    }

    if (!aiText) {
      return NextResponse.json({
        answer: `⚠️ **Không thể kết nối API AI**\n\nVui lòng kiểm tra lại API key trong file \`.dev.vars\` / \`.env.local\`.`,
        sources: [],
      });
    }

    const isPedagogicalTask =
      question.toLowerCase().includes('câu hỏi') ||
      question.toLowerCase().includes('thảo luận') ||
      question.toLowerCase().includes('bài tập') ||
      question.toLowerCase().includes('ôn tập') ||
      question.toLowerCase().includes('soạn') ||
      question.toLowerCase().includes('trắc nghiệm') ||
      question.toLowerCase().includes('đề thi');

    const isOutOfContext =
      ragMode === 'strict' &&
      !isPedagogicalTask &&
      (aiText.includes('[OUT_OF_CONTEXT]') || aiText.includes('[MISSING_CONTEXT]'));
    if (isOutOfContext) {
      aiText = outOfContextNotice;
    } else if (aiText.includes('[OUT_OF_CONTEXT]')) {
      aiText = aiText.replace(/\[OUT_OF_CONTEXT\]/gi, '').trim();
    }

    if (!isOutOfContext && aiText) {
      aiText = stripFluff(aiText);
    }

    if (!isPersonal && !isOutOfContext) {
      storeCachedAnswer({
        question,
        canonicalQuery: searchQuery,
        answer: aiText,
        courseId: effectiveCourseId,
      }).catch(() => {});
    }

    const citedSources = isOutOfContext
      ? []
      : compileAllSources({
          aiText,
          ragMode,
          relevantChunks,
          isParametricFallback,
          groundingMetadata,
          course,
          question,
        });

    return NextResponse.json({
      answer: aiText,
      sources: citedSources,
      model: responseModel,
      provider: responseProvider,
      ragMode,
      isFallback: isParametricFallback,
      finishReason: resultFinishReason,
    });
  } catch (error) {
    console.error('Tutor Error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Lỗi kết nối tới Trợ lý AI.',
      },
      { status: 500 }
    );
  }
}

function compileAllSources({
  aiText,
  ragMode,
  relevantChunks = [],
  isParametricFallback = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groundingMetadata = null,
  course = '',
  question = '',
}: {
  aiText: string;
  ragMode: RagMode;
  relevantChunks?: DocumentChunk[];
  isParametricFallback?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groundingMetadata?: any;
  course?: string;
  question?: string;
}): Array<CitationSource> {
  const sources: CitationSource[] = [];

  // 1. Add course document sources from retrieved chunks (Green pills)
  if (relevantChunks && relevantChunks.length > 0) {
    const seenDocs = new Set<string>();
    for (const chunk of relevantChunks) {
      const title = chunk.docTitle?.trim();
      if (title && !seenDocs.has(title.toLowerCase())) {
        seenDocs.add(title.toLowerCase());
        sources.push({
          name: title,
          type: 'course_material',
          isExternal: false,
          chapter: chunk.metadata?.chapter,
          score: chunk.similarityScore,
        });
      }
    }
  }

  // 2. Add fallback badge if parametric fallback was triggered in hybrid mode (Orange warning pill)
  if (isParametricFallback || (ragMode === 'hybrid' && relevantChunks.length === 0)) {
    sources.push({
      name: 'Kiến thức tham khảo ngoài giáo trình',
      type: 'extended_knowledge',
      isExternal: true,
      isFallback: true,
    });
  }

  // 3. Extract external citations (web links, Google Search Grounding) (Blue pills)
  const isExternalSearchActive = ragMode === 'creative';
  const extractedExt = extractCitedSources(aiText, isExternalSearchActive, question, course, groundingMetadata);
  for (const ext of extractedExt) {
    if (!sources.some(s => s.url === ext.url || s.name === ext.name)) {
      sources.push({
        name: ext.name,
        type: 'external_web',
        isExternal: true,
        url: ext.url,
      });
    }
  }

  return sources;
}

function extractCitedSources(
  aiText: string,
  allowExternalSource: boolean,
  question: string,
  course: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groundingMetadata: any
): Array<{ name: string; isExternal: boolean; url: string }> {
  const isNotFoundResponse =
    aiText.toLowerCase().includes('không có trong tài liệu môn học được cung cấp') ||
    aiText.toLowerCase().includes('không có trong tài liệu được cung cấp') ||
    aiText.toLowerCase().includes('không thuộc phạm vi môn học');

  let citedSources: Array<{ name: string; isExternal: boolean; url: string }> = [];
  if (!isNotFoundResponse) {
    const seenUrls = new Set<string>();

    // 1. Extract exact grounded web pages from Google Search Grounding metadata
    if (allowExternalSource && groundingMetadata?.groundingChunks?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const chunk of groundingMetadata.groundingChunks as any[]) {
        const uri = chunk?.web?.uri;
        let title = chunk?.web?.title || '';
        if (uri) {
          if (!title) {
            try {
              title = new URL(uri).hostname.replace(/^www\./, '');
            } catch {
              title = 'Trang kiểm chứng';
            }
          }
          const normUri = uri.trim().toLowerCase().replace(/\/+$/, '');
          if (!seenUrls.has(normUri) && citedSources.length < 6) {
            seenUrls.add(normUri);
            citedSources.push({
              name: title,
              isExternal: true,
              url: uri,
            });
          }
        }
      }
    }

    // 2. Extract markdown links explicitly provided in the AI text response
    const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let mdMatch: RegExpExecArray | null;
    while ((mdMatch = markdownLinkRegex.exec(aiText)) !== null) {
      const title = mdMatch[1].trim();
      const url = mdMatch[2].trim();
      const normUrl = url.toLowerCase().replace(/\/+$/, '');
      if (url && !seenUrls.has(normUrl) && citedSources.length < 8) {
        seenUrls.add(normUrl);
        citedSources.push({
          name: title || url,
          isExternal: true,
          url,
        });
      }
    }

    // 3. Extract bare/autolink URLs mentioned in the AI text
    const bareUrlRegex = /(?<!\()(https?:\/\/[^\s)\],`"<>]+)/g;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bareUrlRegex.exec(aiText)) !== null) {
      const url = bareMatch[1].trim();
      const normUrl = url.toLowerCase().replace(/\/+$/, '');
      if (url && !seenUrls.has(normUrl) && citedSources.length < 8) {
        seenUrls.add(normUrl);
        let host = url;
        try {
          host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          host = 'Nguồn liên kết';
        }
        citedSources.push({
          name: host,
          isExternal: true,
          url,
        });
      }
    }

    // 4. Fallback to direct query search if external mode is on but no sources were extracted
    if (allowExternalSource && citedSources.length === 0) {
      const cleanQ = question.replace(/[\r\n]+/g, ' ').trim();
      const searchTarget = cleanQ || course || 'Kiến thức chuyên ngành';
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchTarget)}`;
      const displayName = cleanQ
        ? `Kiểm chứng: ${cleanQ.length > 45 ? cleanQ.slice(0, 45) + '…' : cleanQ}`
        : 'Nguồn mở rộng thực tế & tra cứu Web';

      citedSources = [
        {
          name: displayName,
          isExternal: true,
          url: searchUrl,
        },
      ];
    }
  }

  return citedSources;
}
