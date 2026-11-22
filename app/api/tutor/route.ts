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
  getDocumentTOC,
  hydrateChunksWithParentText,
  isWebOrTransientSource,
} from '@/lib/pinecone-vector';
import { rerankChunksWithCohere } from '@/models/cohere';
import { getLearningArtifacts } from '@/lib/learning-artifacts';
import { getStudentCourseProgressContext } from '@/lib/student-progress';
import { getPersonalMaterials } from '@/lib/firebase-data';
import { getUserApiKeys } from '@/lib/key-manager';
import type { ExamResult, RagMode, CitationSource } from '@/app/types';
import { findCachedAnswer, storeCachedAnswer, isPersonalQuery } from '@/lib/semantic-cache';
import { stripFluff, stripCitationMarkers, COMMON_FLUFF_STOP_SEQUENCES } from '@/lib/anti-fluff';
import { getCircuitBreakerNotice, buildUniversalLanguageDirective } from '@/lib/language-detector';
import {
  checkQueryScope,
  buildStrictTutorPrompt,
  filterValidHistory,
  REFUSAL_MESSAGE,
  type AllowedIntent,
} from '@/lib/scope-guard';

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
      strictModel = false,
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
      /** When true the manually selected model must answer alone, no cascade fallback. */
      strictModel?: boolean;
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

    // BYOK: prioritize the acting user's own Gemini key for OCR/embeddings when available.
    const userGeminiKeys = typeof userId === 'number' ? await getUserApiKeys(userId, 'gemini').catch(() => []) : [];
    if (userGeminiKeys.length > 0) {
      const maskedUserKeys = userGeminiKeys.map(k => `${k.slice(0, 6)}...${k.slice(-4)}`);
      console.log(`[Gemini Pool] BYOK: user ${userId} personal Gemini key(s) in use: ${maskedUserKeys.join(', ')} (${userGeminiKeys.length} key(s)) - tried before the system pool.`);
    }

    // ── Layer 4: History Hygiene (Filter out refused/blocked turns) ──
    const sanitizedHistory = filterValidHistory(history);
    const hasHistory = sanitizedHistory.length > 0;

    // ── RAG Stage 1: Intent Extraction & Query Reformulation via Groq (Silent Gatekeeper) ──
    // Convert verbose, rambling, or emotional student prompts into compact canonical search keywords
    // to dramatically boost Semantic Cache hit rate and vector similarity while saving input tokens.
    // Skip Groq call entirely for short standalone queries (<= 4 words, no coreference pronouns)
    // to avoid unnecessary LLM round-trip on simple definition questions.
    const wordCount = question.trim().split(/\s+/).length;
    const hasCoreferencePronoun = /\b(nó|cái này|phần này|những cái này|chúng|chúng nó|đó|này)\b/i.test(question);
    const isShortStandalone = !hasHistory && wordCount <= 4 && !hasCoreferencePronoun && question.trim().length <= 30;

    let searchQuery: string;
    /** Intent Tầng 0/3 được Groq trả về trong CÙNG request với cụm từ khóa (0ms thêm). */
    let reformulatedIntent: 'student_progress' | 'curriculum_or_prereq' | 'off_topic' | undefined;
    if (isShortStandalone) {
      searchQuery = question.trim();
    } else {
      const queryReformulation = await reformulateQueryWithGroq(question, {
        courseContext: course ? `${course} (${courseCode})` : undefined,
        history: hasHistory ? sanitizedHistory.slice(-4) : undefined,
      });
      searchQuery = queryReformulation.reformulatedQuery || question;
      reformulatedIntent = queryReformulation.intent;
    }
    const isStream = Boolean(stream || request.headers.get('accept')?.includes('text/event-stream'));
    const moodleCourseId = Number(courseId) || undefined;

    // ── Layer 1: Scope Gatekeeper (4 tầng: 0 = tiến độ cá nhân, 1/2/3 như cũ) ──
    // Phân loại trên CÂU GỐC (không phải từ khóa RAG) để không mất dấu hiệu "của tôi/bài mới đây".
    // Khi Groq đã trả intent ở bước trên, Gatekeeper dùng luôn -> không gọi LLM lần 2.
    const scopeCheck = await checkQueryScope({
      standaloneQuery: question,
      courseName: course ? `${course} (${courseCode})` : 'Môn học hiện tại',
      courseSummary: courseCode ? `Môn học mã ${courseCode}` : undefined,
      uploadedFileNames: effectiveSources.map(s => s.name),
      userId,
      preclassifiedIntent:
        reformulatedIntent === 'student_progress'
          ? 'STUDENT_PROGRESS'
          : reformulatedIntent === 'off_topic'
            ? 'OUT_OF_SCOPE'
            : undefined,
    });

    const isStudentProgress = scopeCheck.intent === 'STUDENT_PROGRESS';

    // Tầng 0 nhưng chỉ trả đúng khía cạnh sinh viên hỏi (không lan sang phần khác).
    const progressFocus = {
      exam: /kiểm tra|bài thi|trắc nghiệm|điểm|lỗi sai|hổng|yếu|chỗ sai|cải thiện|phân tích/i.test(question),
      attendance: /điểm danh|vắng|chuyên cần|đi học|buổi học/i.test(question),
      homework: /bài tập|nộp|hạn nộp|deadline|quá hạn|sắp hạn|sắp tới/i.test(question),
    };
    if (!progressFocus.exam && !progressFocus.attendance && !progressFocus.homework) {
      progressFocus.exam = true;
      progressFocus.attendance = true;
      progressFocus.homework = true;
    }

    if (scopeCheck.intent === 'OUT_OF_SCOPE') {
      console.log(`[Scope Gatekeeper] Blocked OUT_OF_SCOPE query: "${question}" (${scopeCheck.reason})`);
      if (isStream) {
        const encoder = new TextEncoder();
        const readableStream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ delta: REFUSAL_MESSAGE })}\n\n`)
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  done: true,
                  fullText: REFUSAL_MESSAGE,
                  sources: [],
                  model: 'Scope Gatekeeper (Lớp 1)',
                  provider: 'guardrail',
                  blocked: true,
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
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      return NextResponse.json({
        answer: REFUSAL_MESSAGE,
        reply: REFUSAL_MESSAGE,
        sources: [],
        model: 'Scope Gatekeeper (Lớp 1)',
        provider: 'guardrail',
        blocked: true,
        ragMode,
        isFallback: false,
      });
    }

    // ── TẦNG 0 (student_progress): chấp thuận ngay, nạp số liệu thực tế ──
    // Không phụ thuộc vào Cohere Rerank hay độ tương đồng PDF.
    let studentProgressContext = '';
    if (isStudentProgress) {
      try {
        studentProgressContext = await getStudentCourseProgressContext({
          userId: typeof userId === 'number' ? userId : 4,
          courseId: moodleCourseId,
          courseName: course || undefined,
          gradebook,
          focus: progressFocus,
        });
        console.log(
          `[Scope Gatekeeper] Tier 0 student_progress accepted (user ${userId}, course ${moodleCourseId ?? 'n/a'})`
        );
      } catch (progressErr) {
        console.warn('[Scope Gatekeeper] Could not load student progress context:', progressErr);
        studentProgressContext =
          '=== DỮ LIỆU TIẾN ĐỘ HỌC TẬP THỰC TẾ ===\n- Hệ thống chưa truy xuất được số liệu lúc này. Chỉ được nói rõ điều này, TUYỆT ĐỐI không bịa điểm số, ngày hạn hay số buổi điểm danh.';
      }
    }

    // ── Semantic Cache Interception (0ms / 0 tokens) ──
    // Check if question is personal (contains personal keywords, gradebook queries, or student uploads).
    // If it's a standalone general question and matches a cached answer in this course (similarity >= 0.92),
    // return immediately to avoid burning LLM quota, database vector scans, and Cohere rerank latency.
    const isStudentUpload = effectiveSources.some(s => s.isStudentUpload);
    const hasGradebook = Array.isArray(gradebook) && gradebook.length > 0;
    const isFollowUp = hasHistory && searchQuery.toLowerCase() !== question.toLowerCase();
    const isMultiTurn = sanitizedHistory.length > 1;
    const isPersonal = isStudentUpload || hasGradebook || isPersonalQuery(question) || isFollowUp || isStudentProgress;
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

    // Strict manual model selection must always hit the chosen model, never a cached answer.
    if (!strictModel && !isPersonal && !isMultiTurn && ragMode !== 'creative') {
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
            isStudentProgress,
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
      // PARALLEL CONTEXT HARVESTING: gọi song song learning artifacts + personal materials (Promise.allSettled) thay vì tuần tự await.
      const [artifactsResult, matsResult] = await Promise.allSettled([
        getLearningArtifacts({
          userId: Number(userId) || 4,
          moodleCourseId,
          limit: 10,
        }),
        getPersonalMaterials({ moodleCourseId, limit: 10 }),
      ]);

      if (artifactsResult.status === 'fulfilled') {
        const artifacts = artifactsResult.value;
        if (artifacts && artifacts.length > 0) {
          artifactContext = artifacts
            .slice(0, 5)
            .map((artifact, index) => {
              const title = artifact.title || artifact.artifact_type || 'Học liệu';
              return `- [Học liệu ${index + 1}] ${artifact.artifact_type.toUpperCase()}: "${title}"`;
            })
            .join('\n');
        }
      } else {
        console.warn('Could not query learning artifacts in tutor:', artifactsResult.reason);
      }

      if (matsResult.status === 'fulfilled') {
        const mats = matsResult.value;
        if (mats) {
          for (const mat of mats) {
            if (mat.storage_url && mat.title && !docMap.has(String(mat.title).toLowerCase())) {
              try {
                const text = await parseDocumentFromUrl(String(mat.storage_url), String(mat.title), { userKeys: userGeminiKeys });
                if (text && text.length > 50) docMap.set(String(mat.title).toLowerCase(), text);
              } catch {
                // ignore unavailable material
              }
            }
          }
        }
      } else {
        console.warn('Firebase personal_materials query in tutor:', matsResult.reason);
      }
    }

    // 1c. Prompt-Aware Metadata Filtering ("Judge the book by its cover")
    // Pre-filters candidate sources by matching prompt keywords against document titles,
    // URL slugs, section names, and chapter numbers BEFORE full-text fetching, chunking,
    // or requesting embeddings from Gemini.
    // This saves 80-90% of Gemini embedding quota and keeps Gemini (the team captain) protected from rate limits.
    const preFilteredSources = filterSourcesByPromptMetadata(effectiveSources, question);

    // Separate LMS Course Documents vs On-The-Fly In-Memory Sources (Web Links, Personal Uploads)
    // Rule (Enterprise RAG): Web links, external articles, and student uploads are transient.
    // They are parsed and chunked purely in-memory (On-The-Fly RAG) and filtered via Cohere Rerank.
    const studentSources = preFilteredSources.filter(isWebOrTransientSource);
    const lmsSources = preFilteredSources.filter(s => !isWebOrTransientSource(s));

    // A. For LMS sources in Pinecone:
    let storedLmsChunks: DocumentChunk[] = [];
    if (moodleCourseId && lmsSources.length > 0) {
      try {
        const isSubset = preFilteredSources.length < effectiveSources.length;

        // PARALLEL RETRIEVAL: chạy song song 2 lệnh Pinecone độc lập (kiểm tra fileId đã có vector chưa + lấy toàn bộ stored vectors) để bỏ một full course-corpus round trip khỏi critical path trước khi ranking chunk / gọi LLM.
        const [existingLmsFileIds, storedRetrievedChunks] = await Promise.all([
          getExistingCourseFileIds(moodleCourseId),
          getStoredCourseEmbeddings(moodleCourseId, {
            docTitles: isSubset ? lmsSources.map(s => s.name) : undefined,
          }),
        ]);
        storedLmsChunks = storedRetrievedChunks;

        // Files that need extraction and vectorization into Pinecone
        const lmsToIngest = lmsSources.filter(src => {
          const fid = Number(src.fileId || src.moduleId);
          return fid && !existingLmsFileIds.has(fid);
        });

        if (lmsToIngest.length > 0) {
          await Promise.allSettled(
            lmsToIngest.map(async src => {
              if (!src.url) return;
              try {
                const extractedText = await parseDocumentFromUrl(src.url, src.name, { userKeys: userGeminiKeys });
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

        // NOTE: Do NOT sweep orphaned vectors here.
        // This request only carries the sources the student selected for one question,
        // not the full course file list. Sweeping against that partial list deletes
        // embeddings of every other course document (and their parent texts).
        // Garbage collection runs in the scheduled sync-moodle cron, which knows
        // the complete Moodle course contents.

        // NOTE: Stored chunks were already retrieved concurrently above via Promise.all.
      } catch (lmsVecErr) {
        console.warn('LMS Pinecone retrieval note:', lmsVecErr);
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
            const extractedText = await parseDocumentFromUrl(src.url!, src.name, { userKeys: userGeminiKeys });
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

    // If any LMS source has no chunks in Supabase (or table empty / offline fallback), also compile missing LMS docs to memory
    const missingLmsSources = lmsSources.filter(src => {
      const lower = src.name.toLowerCase();
      const hasChunks = storedLmsChunks.some(c => c.docTitle.toLowerCase() === lower);
      return !hasChunks && !docMap.has(lower) && src.url;
    });
    if (missingLmsSources.length > 0) {
      await Promise.allSettled(
        missingLmsSources.map(async src => {
          try {
            const extractedText = await parseDocumentFromUrl(src.url!, src.name, { userKeys: userGeminiKeys });
            if (extractedText && extractedText.trim()) {
              docMap.set(src.name.toLowerCase(), extractedText);
            }
          } catch {}
        })
      );
    }

    if (missingLmsSources.length > 0 || (storedLmsChunks.length === 0 && lmsSources.length > 0)) {
      for (const src of (missingLmsSources.length > 0 ? missingLmsSources : lmsSources)) {
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

    // Combine candidate chunks: Persistent Pinecone chunks + in-memory student chunks
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

          // ── RAG Stage 2: Sharp Retrieval via Pinecone & Cohere Rerank ──
          // Băm vector & chấm điểm cosine + BM25 trên từ khóa cốt lõi (searchQuery) thay vì prompt nhiễu
          // Stage 1: Broad candidate collection (top 10 candidates)
          const broadCandidates = scoreAndSelectChunks(candidateChunks, searchQuery, {
            // Tầng 0 chỉ cần 1-2 tài liệu gợi ý ôn lại -> limiting topK saves tokens.
            topK: isStudentProgress ? 2 : 4,
            maxTotalChars: isStudentProgress ? 3000 : 6000,
            minSimilarity: ragMode === 'creative' ? 0.20 : 0.30,
            dynamicTopK: true,
          });

          // Stage 2: Cross-Encoder Scanning via Cohere Rerank API (Dedicated Quota, Zero Chat Quota Burn)
          // Fast-path: skip cross-encoder rerank when the top vector candidate is already
          // highly confident (top score >= threshold) — saves a full Cohere API round trip +
          // tokens for obvious queries without hurting answer quality.
          const topCandidateScore = broadCandidates[0]?.similarityScore ?? 0;
          // Tầng 0: bỏ qua Cohere Rerank để tiết kiệm quota (dữ liệu tiến độ là nguồn chính).
          const shouldSkipRerank =
            isStudentProgress || topCandidateScore >= (ragMode === 'creative' ? 0.85 : 0.90);
          if (broadCandidates.length > 1 && !shouldSkipRerank) {
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
          } else if (broadCandidates.length > 0) {
            // Fast-path: top vector candidate already highly confident -> skip rerank, use top chunks directly
            console.log(`[IELTS Scanning Gatekeeper] Skipped Cohere rerank: topScore=${topCandidateScore.toFixed(3)} >= threshold (ragMode: ${ragMode})`);
            relevantChunks = broadCandidates.slice(0, 3);
          }

          // Fallback if Cohere Rerank was unavailable: use Dynamic Top-K vector scoring on searchQuery
          if (relevantChunks.length === 0) {
            relevantChunks = scoreAndSelectChunks(candidateChunks, searchQuery, {
              topK: isStudentProgress ? 2 : 5,
              maxTotalChars: isStudentProgress ? 3000 : 8000,
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

    // ── Layer 2: Explicit Strict RAG Circuit Breaker ──
    const topScore = relevantChunks.length > 0
      ? Math.max(
          relevantChunks[0].similarityScore ?? 0,
          relevantChunks[0].rerankScore ?? 0
        )
      : 0;

    const isGradeInquiry = scopeCheck.intent === 'GRADE_INQUIRY';
    const isStudyGuidance = scopeCheck.intent === 'STUDY_GUIDANCE';
    const isFoundationKnowledge = scopeCheck.intent === 'FOUNDATION_KNOWLEDGE';

    const isStrictCircuitBroken =
      ragMode === 'strict' &&
      (relevantChunks.length === 0 || topScore < 0.5) &&
      !isDocOverviewQuery &&
      !isStudentProgress &&
      !isGradeInquiry &&
      !isStudyGuidance &&
      !isFoundationKnowledge;

    if (isStrictCircuitBroken) {
      const refusalContent = getCircuitBreakerNotice(question);
      console.log(`[Strict RAG Circuit Breaker] Triggered: topScore=${topScore.toFixed(3)}, chunks=${relevantChunks.length}, intent=${scopeCheck.intent}`);

      if (isStream) {
        const encoder = new TextEncoder();
        const readableStream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ delta: refusalContent })}\n\n`)
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  done: true,
                  fullText: refusalContent,
                  sources: [],
                  model: 'Strict RAG Circuit Breaker (Lớp 2)',
                  provider: 'system',
                  ragMode,
                  blocked: true,
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
        answer: refusalContent,
        reply: refusalContent,
        sources: [],
        model: 'Strict RAG Circuit Breaker (Lớp 2)',
        provider: 'system',
        ragMode,
        blocked: true,
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
- TUYỆT ĐỐI KHÔNG chèn bất kỳ marker trích dẫn dạng [n] (ví dụ [1], [2], [3], [10]) vào câu trả lời; nguồn tài liệu được hệ thống hiển thị tự động ở chân trang.
- TRIỆT TIÊU VĂN MẪU & TIẾT KIỆM TOKEN: Cấm chào hỏi đầu câu, cấm kết luận thừa thãi cuối câu. Đi thẳng vào nội dung từ ký tự đầu tiên.`;
    } else if (ragMode === 'hybrid') {
      domainGuardrail = `Bạn là trợ lý học tập. Hãy ưu tiên tối đa việc sử dụng thông tin trong thẻ <document> để trả lời. Nếu thẻ <document> trống hoặc thiếu dữ kiện, bạn ĐƯỢC PHÉP dùng kiến thức nền tảng và tri thức chuyên ngành để giải thích đầy đủ, chính xác.
- QUY TẮC ANTI-FLUFF (TUYỆT ĐỐI KHÔNG PERFORMATIVE / KHÔNG MÀU MÈ NÓI VỀ NGUỒN):
  + TUYỆT ĐỐI KHÔNG BAO GIỜ nói các câu như: "Dựa trên các tài liệu bạn cung cấp...", "Dựa trên tài liệu được cung cấp...", "Dựa trên kiến thức mở rộng ngoài khóa học...", "Dựa trên các nguồn bên ngoài tôi tìm được...", "Based on the sources provided...", "Based on the external sources I found...".
  + ĐI THẲNG TRỰC TIẾP VÀO BẢN CHẤT VẤN ĐỀ TỪ TỪ ĐẦU TIÊN (Jump straight to the problem). Tuyệt đối không tạo banner, không tạo callout phân bua về nguồn gốc kiến thức.
- TUYỆT ĐỐI KHÔNG chèn bất kỳ marker trích dẫn dạng [n] (ví dụ [1], [2], [3], [10]) vào câu trả lời; nguồn tài liệu đã có huy hiệu tự động ở chân trang. Cấm chào hỏi xã giao, cấm kết bài thừa thãi.`;
    } else {
      // ragMode === 'creative'
      domainGuardrail = `Bạn là một giảng viên AI uyên bác. Hãy giải thích chi tiết, cặn kẽ và mở rộng vấn đề bằng các ví dụ thực tế, code mẫu hoặc xu hướng công nghệ mới nhất. Bạn được toàn quyền sử dụng kiến thức chuyên môn của mình.
- Dữ liệu trong thẻ <document> (nếu có) đóng vai trò tham khảo nhẹ, bạn không bị giới hạn trong thẻ này.
- TRIỆT TIÊU VĂN MẪU & TIẾT KIỆM TOKEN (ANTI-FLUFF - LỆNH CỨNG BẮT BUỘC): Cấm chào hỏi đầu câu, cấm chúc tụng sáo rỗng cuối câu. Đi thẳng vào nội dung từ từ đầu tiên.`;
    }

    // Tầng 0 không bị khóa bởi "chỉ trả lời trong <document>": nguồn chính là hồ sơ tiến độ.
    if (isStudentProgress) {
      domainGuardrail = `Bạn đang ở CHẾ ĐỘ HỒ SƠ TIẾN ĐỘ CÁ NHÂN (TẦNG 0 - student_progress).
- Ưu tiên số 1 là khối "HỒ SƠ & TIẾN ĐỘ HỌC TẬP THỰC TẾ CỦA SINH VIÊN" trong <course_materials>. BẮT BUỘC trả lời, KHÔNG được từ chối vì thiếu trích đoạn giáo trình.
- <document> (nếu có) chỉ dùng để gợi ý 1-2 tài liệu nên ôn lại, không được thay thế số liệu tiến độ.
- Tuyệt đối không tự bịa điểm số, ngày hạn, số buổi điểm danh. Dữ liệu ghi "Chưa có" thì phải nói là chưa có.
- Không chèn marker trích dẫn dạng [n]; nguồn đã được hệ thống hiển thị tự động ở chân trang.`;
    }

    let externalInstruction =
      ragMode === 'creative'
        ? `HƯỚNG DẪN MỞ RỘNG TRI THỨC (CREATIVE MODE - SÁNG TẠO & ANTI-FLUFF):
- Ưu tiên tính sáng tạo, linh hoạt sư phạm và liên hệ thực tiễn mở rộng dựa trên tri thức chuyên môn thực tế và tra cứu hiện đại thay vì bị bó hẹp trong tài liệu.
- CẤM VĂN MẪU GIAO TIẾP: Cấm chào hỏi đầu câu, cấm chúc tụng hay kết luận sáo rỗng cuối câu ("Hy vọng thông tin này giúp ích...", "Hy vọng câu trả lời..."). Đi thẳng vào nội dung chuyên môn ngay từ từ đầu tiên.
- LIÊN KẾT NGUỒN NGOÀI: Khi nhắc đến công cụ, tài liệu học thuật hoặc trang web chính thức, hãy dùng định dạng liên kết Markdown [Tên](https://...).`
        : ragMode === 'hybrid'
          ? `HƯỚNG DẪN CHẾ ĐỘ RAG LAI:
- Phân tích và giải thích dựa trên nội dung tài liệu và các chủ đề chuyên môn của môn học ${subjectName} đã chọn ("${selectedTopicsStr}").
- Bám sát giáo trình đã chọn. Không chèn marker trích dẫn dạng [n] (ví dụ [1], [2], [3], [10]) vào câu trả lời; nguồn được hiển thị tự động ở chân trang.
- Nếu câu hỏi có khía cạnh mở rộng ngoài giáo trình: Minh bạch ranh giới giữa tài liệu học phần và phân tích bổ trợ.`
          : `HƯỚNG DẪN BÁM SÁT TÀI LIỆU (STRICT RAG):
- Phân tích và giải thích nghiêm ngặt dựa trên nội dung tài liệu của môn học ${subjectName} đã chọn ("${selectedTopicsStr}").
- Không suy đoán hay chêm xen kiến thức ngoài phạm vi các đoạn trích.`;

    if (isStudentProgress) {
      externalInstruction = `HƯỚNG DẪN CHẾ ĐỘ HỒ SƠ TIẾN ĐỘ:
- Không áp đặt giới hạn "chỉ trích dẫn giáo trình" hay "chỉ trả lời trong <document>". Nguồn chính là dữ liệu tiến độ thực tế.
- <document> nếu có chỉ để gợi ý tài liệu ôn tập; không suy diễn số liệu từ tài liệu.
- Không chèn marker trích dẫn dạng [n]; nguồn đã được hệ thống hiển thị tự động ở chân trang.`;
    }

    const progressRules: string[] = [];
    if (progressFocus.exam) {
      progressRules.push(`Về bài kiểm tra & lỗ hổng kiến thức: Chỉ rõ bài nào hoặc chủ đề nào đang đạt điểm thấp (< 6.5/10 hoặc < 65%), phân tích ngắn gọn phần kiến thức cần củng cố và gợi ý sinh viên mở tab "Không gian học tập" -> dùng chế độ "Tạo đề trắc nghiệm (Tập trung vào chỗ sai)" hoặc chơi 1 lượt "Soi lỗi 1 chạm" để lấp lỗ hổng đó.`);
    }
    if (progressFocus.attendance) {
      progressRules.push(`Về điểm danh: Báo chính xác số buổi đã đi học / số buổi vắng. Nếu có buổi vắng hoặc tỷ lệ vắng cao, nhắc nhở sinh viên đi học đầy đủ để tránh rủi ro cấm thi. Nếu dữ liệu ghi chưa đối chiếu được trạng thái, chỉ báo số buổi đã diễn ra và nói rõ cần kiểm tra lại, KHÔNG kết luận vắng mặt.`);
    }
    if (progressFocus.homework) {
      progressRules.push(`Về bài tập: Liệt kê rõ các bài tập đã quên nộp (quá hạn) và bài sắp đến hạn kèm thời gian cụ thể để sinh viên ưu tiên xử lý ngay. Nếu hệ thống chưa đối chiếu được trạng thái nộp, dùng giọng "cần kiểm tra lại" thay vì khẳng định quên nộp.`);
    }
    progressRules.push(`Giọng điệu: Thân thiện, thẳng thắn như một trợ giảng đồng hành, trình bày rõ ràng theo từng gạch đầu dòng. TUYỆT ĐỐI KHÔNG thêm phần nào sinh viên không hỏi (ví dụ hỏi về bài kiểm tra thì không viết về điểm danh hay bài tập).`);

    const progressSystemInstruction = `
Sinh viên đang hỏi về QUÁ TRÌNH HỌC TẬP CÁ NHÂN của chính họ trong môn "${subjectName}".
Bạn BẮT BUỘC chấp thuận trả lời dựa trên số liệu thực tế trong khối "HỒ SƠ & TIẾN ĐỘ HỌC TẬP THỰC TẾ CỦA SINH VIÊN" (tuyệt đối không tự bịa số điểm hay ngày hạn nếu dữ liệu ghi "Chưa có").
CHỈ trả lời đúng các khía cạnh sau (đây là toàn bộ phạm vi câu trả lời):
${progressRules.map((rule, idx) => `${idx + 1}. ${rule}`).join('\n')}`;

    const scopeTierInstruction = isStudentProgress
      ? `PHÂN TẦNG 0 - HỒ SƠ & TIẾN ĐỘ HỌC TẬP CÁ NHÂN (student_progress):\n${progressSystemInstruction}`
      : scopeCheck.intent === 'FOUNDATION_KNOWLEDGE'
        ? answerStyle === 'concise'
          ? `PHÂN TẦNG 2 - KIẾN THỨC NỀN TẢNG BỔ TRỢ:
- Câu hỏi là kiến thức tiên quyết trực tiếp cho môn "${subjectName}", nên được phép trả lời dù không có chunk tài liệu phù hợp.
- Mở đầu đúng bằng: "> 💡 *Kiến thức nền tảng bổ trợ (ngoài giáo trình trực tiếp):*"
- Chế độ Nhanh / Trọng tâm: chỉ giải thích ngắn gọn trong 3-4 gạch đầu dòng, sau đó liên hệ 1 câu với môn học hiện tại.`
          : `PHÂN TẦNG 2 - KIẾN THỨC NỀN TẢNG BỔ TRỢ:
- Câu hỏi là kiến thức tiên quyết trực tiếp cho môn "${subjectName}", nên được phép trả lời bằng kiến thức chuyên môn dù không có chunk tài liệu phù hợp.
- Mở đầu đúng bằng: "> 💡 *Kiến thức nền tảng bổ trợ (ngoài giáo trình trực tiếp):*"
- Chế độ Creative / Mở rộng: được phân tích sâu, đưa ví dụ minh họa và luôn kết nối ngược với môn học hiện tại.`
        : `PHÂN TẦNG 1 - GIÁO TRÌNH:
- Ưu tiên các đoạn trích đã truy hồi, nhưng không chèn marker trích dẫn dạng [n] (ví dụ [1], [2], [3], [10]) vào câu trả lời.
- Nếu không có đoạn trích, chỉ sử dụng kiến thức nền tảng khi câu hỏi thực sự là tiên quyết trực tiếp của môn học.`;

    const factualGuardrail = `QUY TẮC BẢO ĐẢM TÍNH XÁC THỰC LỊCH SỬ & SỰ KIỆN (ANTI-HALLUCINATION & FACTUAL ACCURACY - BẮT BUỘC):
- TUYỆT ĐỐI KHÔNG BỊA ĐẶT hay suy diễn sai lệch về: Mốc thời gian (năm/tháng/ngày), địa điểm tổ chức, nhân vật, số liệu và nội dung các kỳ Đại hội/sự kiện lịch sử (Ví dụ: Đại hội I họp 1935 tại Ma Cao, Đại hội II họp 1951 tại Chiêm Hóa - Tuyên Quang, Đại hội III họp 1960 tại Hà Nội, Đại hội IV họp 1976 tại Hà Nội, Đại hội VI Đổi mới họp 1986 tại Hà Nội, Đại hội XIV họp 1/2026 tại Hà Nội).
- NẾU thông tin chi tiết mốc lịch sử/số liệu không có trong tài liệu được cấp và bạn không chắc chắn 100%, PHẢI NÓI RÕ "Thông tin mốc thời gian/địa điểm này cần đối chiếu thêm theo giáo trình chính thức của môn học", TUYỆT ĐỐI KHÔNG TỰ GHÉP NĂM HOẶC ĐỊA ĐIỂM BỪA BÃI.
- KHÔNG dùng một khuôn mẫu hay khẩu hiệu chung chung sao chép lặp lại cho nhiều kỳ Đại hội hay nhiều sự kiện khác nhau.`;

    const isFeedbackReview = question.toLowerCase().includes('nhận xét') || question.toLowerCase().includes('feedback') || question.toLowerCase().includes('bài thi');
    const feedbackInstruction = isFeedbackReview && !isStudentProgress
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

    const remediationInstruction = isQuizRemediation && !isStudentProgress
      ? `\nQUY TẮC PHÂN TÍCH BÀI THI & SỬA LỖI SAI (ADAPTIVE REMEDIATION - BẮT BUỘC):
- Sinh viên đang cần bạn phân tích các lỗi sai cụ thể trong bài kiểm tra để củng cố điểm số.
- BẮT BUỘC tập trung 100% vào các câu hỏi bị trừ điểm, các lựa chọn sai và các chủ đề yếu (weak concepts) được cung cấp trong câu hỏi.
- TUYỆT ĐỐI KHÔNG mở đầu bằng câu: "Hệ thống cần có nội dung cụ thể của câu hỏi" hay "Để phân tích chính xác nhất cần có đề bài". Toàn bộ nội dung câu hỏi và câu trả lời của sinh viên đã được cung cấp trực tiếp!
- TUYỆT ĐỐI KHÔNG giải thích dàn trải, lan man lý thuyết của toàn bộ môn học hoặc liệt kê toàn bộ các framework/chuyên đề không liên quan đến các câu sai.
- Hãy đi thẳng vào từng câu sai cụ thể: Phân tích tại sao đáp án đúng lại là như vậy, bẫy tư duy hoặc ngộ nhận khiến sinh viên chọn sai, và phương pháp nhớ/vận dụng chuẩn xác theo giáo trình môn học.\n`
      : '';

    const studentName = userName?.trim() || 'Sinh viên';
    const studentId = userId || 4;
    // Deadlines are only injected when the student actually asks about them.
    // Otherwise the model tends to append unsolicited "remember the deadline" notes.
    const questionWantsDeadlines = isStudentProgress
      ? progressFocus.homework
      : /deadline|hạn chót|hạn nộp|nộp bài|bài tập|kiểm tra|lịch thi|kỳ thi|bài thi|assignment|exam|due date|schedule/i.test(
          question
        );
    const lmsGroundingContext = `NGỮ CẢNH HỌC TẬP & DANH TÍNH SINH VIÊN (LMS GROUNDING):
- Người dùng hiện tại: ${studentName} (Moodle User ID: ${studentId}).
- Môn học đang mở: "${subjectName}"${courseCode ? ` [Mã môn: ${courseCode}]` : ''}${moodleCourseId ? ` [Course ID: ${moodleCourseId}]` : ''}.
${deadlineContext && questionWantsDeadlines ? `- HẠN CHÓT SẮP TỚI CỦA MÔN NÀY (chỉ sử dụng khi sinh viên trực tiếp hỏi về deadline, lịch thi, bài tập):\n${deadlineContext}` : ''}`;

    const styleInstruction = isStudentProgress
      ? `PHONG CÁCH PHẢN HỒI: Hồ sơ tiến độ - trình bày theo gạch đầu dòng chỉ cho các nhóm ${[
          progressFocus.exam ? 'điểm yếu' : '',
          progressFocus.attendance ? 'điểm danh' : '',
          progressFocus.homework ? 'bài tập' : '',
        ].filter(Boolean).join(' / ')}, thân thiện, thẳng thắn, không chào hỏi.`
      : answerStyle === 'detailed'
        ? `PHONG CÁCH PHẢN HỒI: Chi tiết & Chuyên sâu (Phân tích toàn diện, cặn kẽ nguyên lý, dẫn chứng và ví dụ trực quan).`
        : `PHONG CÁCH PHẢN HỒI: Nhanh & Trọng tâm (Trình bày súc tích trong 1-2 đoạn văn ngắn, đi thẳng vào bản chất và giải pháp then chốt).`;

    const systemInstruction = `Bạn là Trợ lý Học tập AI chuyên trách môn "${subjectName}" trên hệ thống LMS Assistant.

${lmsGroundingContext}

${domainGuardrail}

${scopeTierInstruction}

${factualGuardrail}

${styleInstruction}

${externalInstruction}
${feedbackInstruction}
${remediationInstruction}
QUY TẮC PHONG CÁCH & TRÌNH BÀY HỌC THUẬT (BẮT BUỘC):
1. TRIỆT TIÊU VĂN MẪU, LỜI CHÀO & THÔNG BÁO NGUỒN (ANTI-FLUFF - KHÔNG PERFORMATIVE):
- TUYỆT ĐỐI CẤM MỌI CÂU TỪ CHÀO HỎI VÀ XÃ GIAO ĐẦU CÂU: CẤM nói "Chào bạn", "Chào các bạn", "Chào em", "Xin chào", "Dạ vâng", "Thưa bạn", v.v. Kèm mọi icon chào mừng (như 👋, 😊, 🎓).
- TUYỆT ĐỐI CẤM MỌI CÂU THÔNG BÁO NGUỒN (CẤM: "Dựa trên tài liệu bạn cung cấp...", "Dựa trên kiến thức mở rộng ngoài khóa học...", "Dựa trên các nguồn bên ngoài tôi tìm được...", "Theo tài liệu...", "Based on the sources provided...", "Based on the external sources I found..."). Nguồn tài liệu được hệ thống hiển thị tự động ở chân trang; tuyệt đối không chèn marker trích dẫn dạng [n] (ví dụ [1], [2], [3], [10]) vào câu trả lời.
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
10. KHÔNG CHÈN KÝ HIỆU TRÍCH DẪN VÀO CÂU TRẢ LỜI:
- TUYỆT ĐỐI KHÔNG chèn các marker dạng [n] (ví dụ [1], [2], [3], [10]), "[trích đoạn 5]", "[đoạn trích 5]", "[HỌC LIỆU ĐÃ LƯU 2]" hay "[học liệu 2]" vào nội dung câu trả lời.
- Nguồn tài liệu và học liệu được hệ thống hiển thị tự động bằng huy hiệu nguồn ở chân trang. Hãy viết câu trả lời liền mạch, sạch sẽ, không có marker tham chiếu.
11. TUYỆT ĐỐI KHÔNG LẶP TIÊU ĐỀ: Tuyệt đối KHÔNG sao chép, trích lại hay lặp lại các tiêu đề trích đoạn dạng "[ĐOẠN TRÍCH TÀI LIỆU ...]" hay "--- NỘI DUNG TỪ TÀI LIỆU ---" vào trong câu trả lời. Hãy đi thẳng vào phân tích, giải thích và trình bày mạch lạc nội dung chuyên môn.
${isStudentProgress
  ? '12. CHẾ ĐỘ HỒ SƠ TIẾN ĐỘ: Được phép - và được khuyến khích - nhắc nhở sinh viên đi học đều, nộp bài quá hạn và ưu tiên các hạn sắp tới dựa trên số liệu thực tế.'
  : '12. KHÔNG TỰ ĐỘNG NHẮC DEADLINE HAY THÊM LỜI NHẮC NGOÀI CÂU HỎI: Chỉ trả lời đúng nội dung sinh viên hỏi. TUYỆT ĐỐI KHÔNG chèn các câu nhắc nhở hạn nộp bài, lịch thi, thời hạn bài kiểm tra hoặc bất kỳ ghi chú nhắc việc nào ở cuối câu trả lời — trừ khi sinh viên trực tiếp hỏi về deadline/lịch thi/bài tập.'}`;

    let contextSection = '';
    if (isStudentProgress && studentProgressContext.trim()) {
      contextSection += `=== HỒ SƠ & TIẾN ĐỘ HỌC TẬP THỰC TẾ CỦA SINH VIÊN (NGUỒN CHÍNH - TẦNG 0) ===\n${studentProgressContext}\n\n`;
    }
    if (gradebookContext.trim()) {
      contextSection += `=== SỔ ĐIỂM CỦA SINH VIÊN (DỮ LIỆU ĐIỂM SỐ NỘI BỘ, KHÔNG PHẢI NỘI DUNG TÀI LIỆU BÀI GIẢNG) ===\n${gradebookContext}\n\n`;
    }
    if (deadlineContext.trim() && questionWantsDeadlines) {
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

    // ── Layer 3: System Prompt Sandwich Defense ──
    const promptAnchor = `\n\n[LỆNH BỔ TRỢ BẮT BUỘC - ANTI-FLUFF, ANTI-PLACEHOLDER & TIẾT KIỆM TOKEN]:
1. TUYỆT ĐỐI CẤM CHÀO HỎI VÀ CẤM THÔNG BÁO NGUỒN (CẤM: "Chào bạn", "Dựa trên tài liệu bạn cung cấp...", "Dựa trên kiến thức mở rộng...", "Based on the sources provided..."). ĐI THẲNG TRỰC TIẾP VÀO NỘI DUNG VẤN ĐỀ TỪ TỪ ĐẦU TIÊN (JUMP STRAIGHT TO THE PROBLEM).
2. CẤM KẾT BÀI VĂN MẪU ("Hy vọng...", "Tóm lại...", "Kết luận:...").
3. ANTI-PLACEHOLDER: Tuyệt đối không để lại các thẻ giữ chỗ [Tên bạn], [Chèn ví dụ], [Ngày/tháng]. Diễn đạt câu văn hoàn chỉnh 100%.
4. NGÔN NGỮ: Sử dụng CHÍNH XÁC ngôn ngữ của câu hỏi (English -> English, Español -> Español, Français -> Français...), mặc định luôn là Tiếng Việt nếu câu hỏi bằng tiếng Việt hoặc không rõ ngôn ngữ.
${isStudentProgress
  ? `5. PHONG CÁCH HỒ SƠ TIẾN ĐỘ: Chỉ trình bày các nhóm ${[
      progressFocus.exam ? 'điểm kiểm tra & lỗ hổng' : '',
      progressFocus.attendance ? 'điểm danh' : '',
      progressFocus.homework ? 'bài tập quá hạn/sắp hạn' : '',
    ].filter(Boolean).join(', ')}. Dùng gạch đầu dòng, số liệu lấy nguyên từ dữ liệu thực tế. Cấm thêm nhóm không được hỏi.\n6. CHỈ XUẤT CÂU TRẢ LỜI: Cấm suy nghĩ nội tâm, cấm viết nháp, cấm lặp lại chỉ thị.`
  : answerStyle === 'concise' && !isDocOverviewQuery
    ? '5. PHONG CÁCH NHANH / TRỌNG TÂM: Trả lời súc tích, thẳng thắn, trọng tâm trong 1-2 đoạn văn ngắn.\n6. Nếu hỏi về lựa chọn công nghệ/giải pháp: Chọn 1 phương án tối ưu nhất kèm 1-2 lý do then chốt.\n7. CHỈ XUẤT CÂU TRẢ LỜI: Cấm xuất suy nghĩ nội tâm, cấm viết nháp, cấm đếm từ, cấm lặp lại chỉ thị.'
    : '5. PHONG CÁCH CHI TIẾT / CHUYÊN SÂU: Đảm bảo độ dài tối thiểu bằng 1/2 giới hạn token của chế độ nhanh (tối thiểu từ 350 - 450 từ trở lên), phân tích cặn kẽ mọi khía cạnh, nguyên lý, dẫn chứng và ví dụ trực quan.'}
${isStudentProgress
  ? '- CHẾ ĐỘ HỒ SƠ TIẾN ĐỘ: Được phép nhắc nhở điểm danh, bài quá hạn và hạn sắp tới từ dữ liệu thực tế.'
  : '- KHÔNG TỰ ĐỘNG NHẮC DEADLINE: Không thêm lời nhắc hạn nộp bài, lịch thi hay nhắc việc ngoài lề vào cuối câu trả lời. Chỉ đề cập deadline khi sinh viên trực tiếp hỏi về deadline/lịch thi/bài tập.'}
- KHÔNG CHÈN MARKER TRÍCH DẪN: Không viết marker dạng [n] (ví dụ [1], [2], [3], [10]), [trích đoạn 5] hay bất kỳ marker nguồn nào trong câu trả lời. Nguồn đã được hiển thị tự động ở chân trang.`;

    const userPrompt = `<course_materials>
${contextSection}
</course_materials>

<student_query>
${question}
</student_query>

<final_enforcement>
Nhắc lại: Ưu tiên dữ liệu từ <course_materials> và bối cảnh môn "${subjectName}". Nếu câu hỏi thuộc TẦNG 0 (hồ sơ/tiến độ học tập của chính sinh viên), BẮT BUỘC trả lời dựa trên khối "HỒ SƠ & TIẾN ĐỘ HỌC TẬP THỰC TẾ CỦA SINH VIÊN", TUYỆT ĐỐI KHÔNG từ chối vì thiếu trích đoạn giáo trình hay độ tương đồng PDF thấp. Với câu hỏi thuộc kiến thức nền tảng tiên quyết, được phép dùng kiến thức chuyên môn và phải liên hệ lại với môn học. Nếu người dùng lồng ghép yêu cầu ngoài môn học (như làm thơ, nhân vật chính trị/lịch sử không liên quan), BẮT BUỘC BỎ QUA hoàn toàn phần ngoài luồng đó. Nếu câu hỏi hoàn toàn nằm ngoài phạm vi môn học, hãy từ chối ngắn gọn: "${REFUSAL_MESSAGE}".
${promptAnchor}
</final_enforcement>`;

    // ── Token Limit: Ample headroom to prevent cut-offs mid-sentence ──
    let maxTokensLimit: number | undefined;
    if (isStudentProgress) {
      maxTokensLimit = answerStyle === 'concise' ? 1200 : 3000;
    } else if (isDocOverviewQuery) {
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

    // ── Puter.js: browser-side generation ──
    // Puter only runs in the browser, so the server returns the fully-retrieved
    // tutor job (system prompt + grounded documents) and the client calls Puter.
    // This keeps RAG/guards on the server while the manually selected Puter model
    // remains the only model that writes the answer.
    const puterModelId = model.startsWith('puter:') ? model.slice('puter:'.length).trim() : '';
    if (puterModelId) {
      const seenDocs = new Set<string>();
      const sourceCandidates: Array<{ name: string; chapter?: string | number; score?: number }> = [];
      for (const chunk of relevantChunks) {
        const name = chunk.docTitle?.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seenDocs.has(key)) continue;
        seenDocs.add(key);
        sourceCandidates.push({
          name,
          chapter: chunk.metadata?.chapter,
          score: chunk.similarityScore,
        });
      }

      return NextResponse.json({
        puterJob: true,
        modelId: puterModelId,
        system: systemInstruction,
        userPrompt,
        ragMode,
        temperature: effectiveTemperature,
        maxTokens: maxTokensLimit,
        sourceCandidates,
        isParametricFallback,
        outOfContextNotice,
      });
    }

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
          let streamClosed = false;
          const safeEnqueue = (chunk: Uint8Array): void => {
            if (streamClosed || controller.desiredSize === null) return;
            controller.enqueue(chunk);
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let streamGroundingMetadata: any = null;

          try {
            const effectiveCategory = detectTaskCategory({
              system: systemInstruction,
              userPrompt,
              history: sanitizedHistory.slice(-6).map(msg => ({
                role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
                content: msg.text,
              })),
              documents: effectiveDocuments,
              taskCategory: answerStyle === 'concise' ? 'basic' : undefined,
            });

            const streamResult = await generateTextStream(model, {
              system: systemInstruction,
              userPrompt,
              // Chỉ truyền câu hỏi thật, không để ngữ cảnh RAG ép đổi ngôn ngữ.
              languageHint: question,
              signal: request.signal,
              strictModel,
              userId: typeof userId === 'number' ? userId : undefined,
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
                safeEnqueue(
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
                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)
                );
              },
            });

            if (!accumulatedText && streamResult.text) {
              accumulatedText = streamResult.text;
              if (!accumulatedText.trim().startsWith('[OUT_OF_CONTEXT')) {
                safeEnqueue(
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
              !isStudentProgress &&
              !isPedagogicalTask &&
              (accumulatedText.includes('[OUT_OF_CONTEXT]') || accumulatedText.includes('[MISSING_CONTEXT]'));
            if (isOutOfContext) {
              accumulatedText = outOfContextNotice;
              safeEnqueue(
                encoder.encode(`data: ${JSON.stringify({ delta: outOfContextNotice, replace: true })}\n\n`)
              );
            } else if (accumulatedText.includes('[OUT_OF_CONTEXT]')) {
              accumulatedText = accumulatedText.replace(/\[OUT_OF_CONTEXT\]/gi, '').trim();
            }

            if (!isOutOfContext && accumulatedText) {
              const stripped = stripCitationMarkers(stripFluff(accumulatedText));
              if (stripped !== accumulatedText) {
                accumulatedText = stripped;
                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ delta: accumulatedText, replace: true })}\n\n`)
                );
              }
            }

            if (accumulatedText && !isPersonal && !isOutOfContext && ragMode !== 'creative') {
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
                  isParametricFallback: isParametricFallback && !isStudentProgress,
                  isStudentProgress,
                  groundingMetadata: streamGroundingMetadata,
                  course,
                  question,
                });

            const responseModelBase = streamResult.modelName || streamResult.modelId || 'AI Assistant';
            const responseModel = streamResult.keySource === 'byok'
              ? `${responseModelBase} (BYOK)`
              : responseModelBase;
            const responseProvider = streamResult.provider || 'auto';

            safeEnqueue(
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
            safeEnqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (streamErr) {
            console.error('Stream generation error in tutor:', streamErr);
            safeEnqueue(
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
            streamClosed = true;
            if (controller.desiredSize !== null) {
              controller.close();
            }
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
        history: sanitizedHistory.slice(-6).map(msg => ({
          role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: msg.text,
        })),
        documents: effectiveDocuments,
        taskCategory: answerStyle === 'concise' ? 'basic' : undefined,
      });

      const result = await generateText(model, {
        system: systemInstruction,
        userPrompt,
        // Chỉ truyền câu hỏi thật, không để ngữ cảnh RAG ép đổi ngôn ngữ.
        languageHint: question,
        userId: typeof userId === 'number' ? userId : undefined,
        strictModel,
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
      if (result.keySource === 'byok') responseModel += ' (BYOK)';
      if (result.provider) responseProvider = result.provider;
    } catch (err) {
      // Strict mode: report the selected model's failure instead of masking it.
      if (strictModel) throw err;
      console.warn('AI generation failed:', err);
    }

    if (!aiText) {
      if (strictModel) {
        return NextResponse.json(
          { error: `Model ${model} không trả về nội dung. Hãy kiểm tra lại model hoặc chọn model khác.` },
          { status: 502 }
        );
      }
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
      !isStudentProgress &&
      !isPedagogicalTask &&
      (aiText.includes('[OUT_OF_CONTEXT]') || aiText.includes('[MISSING_CONTEXT]'));
    if (isOutOfContext) {
      aiText = outOfContextNotice;
    } else if (aiText.includes('[OUT_OF_CONTEXT]')) {
      aiText = aiText.replace(/\[OUT_OF_CONTEXT\]/gi, '').trim();
    }

    if (!isOutOfContext && aiText) {
      aiText = stripCitationMarkers(stripFluff(aiText));
    }

    if (!isPersonal && !isOutOfContext && !isParametricFallback && ragMode !== 'creative') {
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
          isParametricFallback: isParametricFallback && !isStudentProgress,
          isStudentProgress,
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
  isStudentProgress = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  groundingMetadata = null,
  course = '',
  question = '',
}: {
  aiText: string;
  ragMode: RagMode;
  relevantChunks?: DocumentChunk[];
  isParametricFallback?: boolean;
  isStudentProgress?: boolean;
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
  if (!isStudentProgress && (isParametricFallback || (ragMode === 'hybrid' && relevantChunks.length === 0))) {
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
