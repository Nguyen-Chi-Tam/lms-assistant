import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';
import { parseDocumentFromUrl } from '@/lib/rag/document-parser';
import { retrieveRelevantChunks, formatChunksForPrompt, scoreAndSelectChunks, type DocumentChunk } from '@/lib/rag/rag';
import { getStoredCourseEmbeddings, getExistingCourseFileIds, hydrateChunksWithParentText, vectorizeAndStoreLmsSource, isPineconeEgressBlocked } from '@/lib/rag/pinecone-vector';
import { getLatestQuizAnalysis } from '@/lib/learning/learning-artifacts';
import { getPersonalMaterials } from '@/lib/database/firebase-data';
import { stripFluff } from '@/lib/ai/anti-fluff';
import { getUserApiKeys } from '@/lib/security/key-manager';
import { parseQuizJson, normalizeQuizQuestions, type MatchingPair, type QuizQuestion } from '@/app/lib/quiz-parser';

interface SourceItem {
  name: string;
  url?: string;
  type?: string;
  fileId?: number;
  moduleId?: number;
  sectionId?: number;
  sectionName?: string;
  chapter?: string | number;
  isStudentUpload?: boolean;
}

export type { MatchingPair, QuizQuestion };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      topic?: string;
      course?: string;
      courseCode?: string;
      courseId?: string | number;
      userId?: number;
      sourceNames?: string[];
      sources?: SourceItem[];
      count?: number;
      difficulty?: 'easy' | 'normal' | 'hard';
      questionType?: 'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer' | 'mixed';
      questionTypes?: Array<'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer'>;
      quickTest?: boolean;
      generatorMode?: 'comprehensive' | 'targeted';
      focusWeakAreas?: boolean;
      weakTopics?: string[];
      allowExternalSource?: boolean;
      ragMode?: 'strict' | 'hybrid' | 'creative';
      model?: string;
      /** When true the manually selected model must generate alone, no cascade fallback. */
      strictModel?: boolean;
      /** When true or when model starts with puter:, delegate actual generation to Puter.js in browser. */
      preferPuter?: boolean;
    };

    // Validate count: quick check-ins use 3 questions; full quizzes can use more.
    const rawCount = typeof body.count === 'number' ? body.count : 10;
    const count = Math.min(50, Math.max(3, rawCount));

    const allKnownTypes: Array<'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer'> = [
      'multiple_choice',
      'true_false',
      'multiple_select',
      'matching',
      'short_answer',
    ];
    type KnownQuestionType = (typeof allKnownTypes)[number];

    let selectedTypes: Array<'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer'> = [];
    if (Array.isArray(body.questionTypes) && body.questionTypes.length > 0) {
      selectedTypes = body.questionTypes.filter(t => allKnownTypes.includes(t));
    }

    if (selectedTypes.length === 0) {
      if (body.questionType === 'mixed') {
        selectedTypes = [...allKnownTypes];
      } else if (body.questionType && allKnownTypes.includes(body.questionType as KnownQuestionType)) {
        selectedTypes = [body.questionType as KnownQuestionType];
      } else {
        selectedTypes = ['multiple_choice'];
      }
    }

    const difficulty = body.difficulty || 'normal';
    const questionType = body.questionType || (selectedTypes.length === 1 ? selectedTypes[0] : 'mixed');
    const topic = body.topic || 'Kiểm tra kiến thức môn học';
    const ragMode: 'strict' | 'hybrid' | 'creative' =
      body.ragMode || (body.allowExternalSource ? 'creative' : 'hybrid');
    const quizGeminiKeys = body.userId ? await getUserApiKeys(Number(body.userId), 'gemini').catch(() => []) : [];

    const effectiveSources: SourceItem[] =
      body.sources && body.sources.length > 0
        ? body.sources
        : (body.sourceNames || []).map(name => ({ name }));

    const effectiveSourceNames = effectiveSources.map(s => s.name);

    // 1. Gather document context from personal_materials / Moodle
    let documentContext = '';
    const docMap = new Map<string, string>();
    const moodleCourseId = Number(body.courseId) || undefined;
    // Giới hạn 20s cho toàn bộ khâu parse tài liệu để không ăn hết thời gian request.
    const quizDocSignal = AbortSignal.timeout(20_000);
    const quizParseOptions = { userKeys: quizGeminiKeys, signal: quizDocSignal, skipVisionOcr: true };

    if (moodleCourseId) {
      try {
        const mats = await getPersonalMaterials({ moodleCourseId, limit: 10 });
        if (mats) {
          for (const mat of mats) {
            if (mat.storage_url && mat.title && !docMap.has(String(mat.title).toLowerCase())) {
              try {
                const text = await parseDocumentFromUrl(String(mat.storage_url), String(mat.title), quizParseOptions);
                if (text && text.length > 50) docMap.set(String(mat.title).toLowerCase(), text);
              } catch {
                // ignore unavailable material
              }
            }
          }
        }
      } catch (firebaseError) {
        console.warn('Firebase personal_materials query in quiz route:', firebaseError);
      }
    }

    // 1b. LMS course corpus (Pinecone) - the same indexed course files the tutor reads.
    // Quick check-ins carry no preselected sources, so the whole course corpus is used.
    const selectedLmsSources = effectiveSources.filter(src => (src.fileId || src.moduleId) && !src.isStudentUpload);
    let lmsChunks: DocumentChunk[] = [];

    if (moodleCourseId) {
      try {
        const storedChunks = await getStoredCourseEmbeddings(
          moodleCourseId,
          selectedLmsSources.length > 0 ? { docTitles: selectedLmsSources.map(src => src.name) } : {}
        );

        if (storedChunks.length > 0) {
          const picked = scoreAndSelectChunks(storedChunks, topic, {
            topK: body.quickTest ? 10 : 6,
            maxTotalChars: body.quickTest ? 14000 : 9000,
            minSimilarity: 0.15,
            dynamicTopK: true,
          });
          if (picked.length > 0) {
            lmsChunks = await hydrateChunksWithParentText(picked);
          } else if (body.quickTest) {
            // Fallback: nothing matched the course title, so spread the check-in across
            // the opening sections of every indexed course document instead of failing.
            const leadChunks: DocumentChunk[] = [];
            const chunksByTitle = new Map<string, DocumentChunk[]>();
            for (const chunk of storedChunks) {
              const list = chunksByTitle.get(chunk.docTitle) || [];
              list.push(chunk);
              chunksByTitle.set(chunk.docTitle, list);
            }
            for (const list of chunksByTitle.values()) {
              leadChunks.push(...list.sort((a, b) => a.chunkIndex - b.chunkIndex).slice(0, 2));
            }
            if (leadChunks.length > 0) {
              lmsChunks = await hydrateChunksWithParentText(leadChunks.slice(0, 12));
            }
          }
        }

        // Ingest LMS files that are not indexed yet (same on-demand path as the tutor).
        // Quick check-ins ingest a small batch per run so the first prompt stays fast;
        // the next check-in picks up the remaining files.
        if (selectedLmsSources.length > 0) {
          const pineconeBlocked = isPineconeEgressBlocked();
          const existingFileIds = pineconeBlocked ? new Set<number>() : await getExistingCourseFileIds(moodleCourseId);
          const pendingIngest = selectedLmsSources
            .filter(src => {
              const fileId = Number(src.fileId || src.moduleId);
              return Boolean(fileId) && Boolean(src.url) && !existingFileIds.has(fileId);
            })
            .slice(0, body.quickTest ? 3 : 8);

          if (pendingIngest.length > 0) {
            await Promise.allSettled(
              pendingIngest.map(async src => {
                try {
                  const text = await parseDocumentFromUrl(src.url!, src.name, quizParseOptions);
                  if (!text || text.trim().length < 20) return;
                  if (!pineconeBlocked) {
                    await vectorizeAndStoreLmsSource({
                      moodleCourseId,
                      moodleFileId: Number(src.fileId || src.moduleId) || 1,
                      documentTitle: src.name,
                      text,
                      metadata: {
                        sectionId: src.sectionId,
                        sectionName: src.sectionName,
                        chapter: src.chapter,
                        courseId: moodleCourseId,
                      },
                    });
                  }
                  docMap.set(src.name.toLowerCase(), text);
                } catch (ingestErr) {
                  console.warn(`[Quiz] Could not parse LMS source "${src.name}":`, ingestErr);
                }
              })
            );
          }
        }
      } catch (lmsErr) {
        console.warn('[Quiz] LMS course retrieval warning:', lmsErr);
      }
    }

    // Direct content from LMS sources sent from frontend
    for (const src of effectiveSources) {
      const lowerName = src.name.toLowerCase();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content = (src as any).content;
      if (content && typeof content === 'string' && content.trim() && !docMap.has(lowerName)) {
        docMap.set(lowerName, content.trim());
      }
    }

    // Parse URL documents if needed
    for (const src of effectiveSources) {
      const lowerName = src.name.toLowerCase();
      // If Pinecone provided chunks, quickTest doesn't need to re-parse. But if Pinecone was empty/blocked,
      // allow reading up to 2 LMS files directly so we have real course text.
      if (body.quickTest && lmsChunks.length > 0 && (src.fileId || src.moduleId) && !docMap.has(lowerName)) continue;
      if (!docMap.has(lowerName) && src.url && docMap.size < (body.quickTest ? 2 : 5)) {
        try {
          const extractedText = await parseDocumentFromUrl(src.url, src.name, quizParseOptions);
          if (extractedText && extractedText.trim()) {
            docMap.set(lowerName, extractedText);
          }
        } catch {
          // ignore
        }
      }
    }

    // Synthesize outline from LMS syllabus if no full documents were parsed
    if (docMap.size === 0 && effectiveSources.length > 0) {
      const outline = effectiveSources.slice(0, 15).map((s, i) =>
        `- Học liệu LMS ${i + 1}: "${s.name}"${s.sectionName ? ` (Mục: ${s.sectionName})` : ''}${s.chapter ? ` [Chương: ${s.chapter}]` : ''}`
      ).join('\n');
      docMap.set('lms_course_outline', `TÀI LIỆU VÀ CÁC CHỦ ĐỀ HỌC PHẦN TRÊN LMS:\n${outline}`);
    }

    const compiledDocs: Array<{ title: string; text: string }> = [];
    for (const src of effectiveSources) {
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
      if (text && text.trim() && !compiledDocs.some(d => d.title === src.name)) {
        compiledDocs.push({ title: src.name, text });
      }
    }
    // Quick check-ins may not have a preselected source (or the selected LMS files may
    // not be parseable yet). In that case, keep every material loaded for the course
    // instead of silently dropping them.
    if (effectiveSources.length === 0 || body.quickTest) {
      for (const [title, text] of docMap.entries()) {
        if (text.trim() && !compiledDocs.some(d => d.title.toLowerCase() === title)) {
          compiledDocs.push({ title, text });
        }
      }
    }

    if (ragMode === 'strict' && compiledDocs.length === 0 && lmsChunks.length === 0 && !body.quickTest) {
      return NextResponse.json(
        {
          error:
            'Chế độ Bám sát tài liệu (Strict RAG) yêu cầu tài liệu môn học. Hiện chưa có tài liệu nào được cung cấp. Vui lòng chuyển sang chế độ Hybrid hoặc Creative để tiếp tục.',
        },
        { status: 400 }
      );
    }
    if (body.quickTest && compiledDocs.length === 0 && lmsChunks.length === 0) {
      // Build a fallback document representing the course structure instead of rejecting with 422
      compiledDocs.push({
        title: `Đề cương môn học ${body.course || topic}`,
        text: `Môn học: ${body.course || topic}\nChủ đề: ${topic}\nTài liệu khóa học: ${effectiveSourceNames.join(', ') || 'Giáo trình môn học'}`,
      });
    }

    // LMS chunks already carry the retrieved course text, so skip the same documents
    // in the in-memory pipeline to keep the prompt free of duplicates.
    const lmsChunkTitles = new Set(lmsChunks.map(chunk => chunk.docTitle.toLowerCase().trim()));
    const compiledForPrompt = compiledDocs.filter(doc => !lmsChunkTitles.has(doc.title.toLowerCase().trim()));

    if (compiledForPrompt.length > 0) {
      try {
        const relevantChunks = await retrieveRelevantChunks(topic, compiledForPrompt, {
          topK: 8,
          maxTotalChars: 18000,
          minSimilarity: 0.15,
        });

        if (relevantChunks.length > 0) {
          documentContext = formatChunksForPrompt(relevantChunks);
        } else {
          const maxPerDoc = Math.max(2500, Math.floor(25000 / compiledForPrompt.length));
          documentContext = compiledForPrompt
            .map((doc, idx) => `[TÀI LIỆU ${idx + 1}: "${doc.title}"]\n${doc.text.slice(0, maxPerDoc)}`)
            .join('\n\n');
        }
      } catch (ragErr) {
        console.warn('RAG retrieval warning in quiz route:', ragErr);
        const maxPerDoc = Math.max(2500, Math.floor(25000 / compiledForPrompt.length));
        documentContext = compiledForPrompt
          .map((doc, idx) => `[TÀI LIỆU ${idx + 1}: "${doc.title}"]\n${doc.text.slice(0, maxPerDoc)}`)
          .join('\n\n');
      }
    }

    if (lmsChunks.length > 0) {
      // Parent-text hydration can expand chunks to full pages, so cap the budget here.
      const lmsBudget = body.quickTest ? 16000 : 12000;
      let usedChars = 0;
      const cappedLmsChunks: DocumentChunk[] = [];
      for (const chunk of lmsChunks) {
        const remaining = lmsBudget - usedChars;
        if (remaining <= 200) break;
        const text = chunk.text.slice(0, remaining);
        usedChars += text.length;
        cappedLmsChunks.push({ ...chunk, text });
      }
      const lmsContext = formatChunksForPrompt(cappedLmsChunks);
      if (lmsContext) documentContext = [lmsContext, documentContext].filter(Boolean).join('\n\n');
    }

    // Difficulty Prompting
    let difficultyDesc = '';
    if (difficulty === 'easy') {
      difficultyDesc = 'ĐỘ KHÓ: DỄ (Câu hỏi nhận biết khái niệm cơ bản, định nghĩa trực tiếp, không bẫy phức tạp).';
    } else if (difficulty === 'hard') {
      difficultyDesc = 'ĐỘ KHÓ: KHÓ / NÂNG CAO (Câu hỏi vận dụng cao, phân tích tình huống thực tế, so sánh chi tiết, công thức, bẫy trắc nghiệm sâu sắc).';
    } else {
      difficultyDesc = 'ĐỘ KHÓ: TRUNG BÌNH (Cân đối giữa câu hỏi lý thuyết hiểu bản chất và bài tập vận dụng vừa phải).';
    }

    // Type Prompting
    const typeDescriptions: Record<string, string> = {
      multiple_choice: '1. TRẮC NGHIỆM 4 LỰA CHỌN (Single Choice): "type": "multiple_choice", "choices": đúng 4 lựa chọn, "answer": số nguyên 0..3 (1 đáp án đúng duy nhất).',
      true_false: '2. ĐÚNG / SAI (True/False): "type": "true_false", "q" PHẢI là một mệnh đề khẳng định hoàn chỉnh, KHÔNG kết thúc bằng dấu "?" (KHÔNG dùng dạng "Câu nào/Điều nào..."), "choices": ["Đúng", "Sai"], "answer": 0 nếu Đúng, 1 nếu Sai.',
      multiple_select: '3. CHỌN NHIỀU ĐÁP ÁN (Multiple Select): "type": "multiple_select", "choices": 4-5 lựa chọn, "answers": mảng chứa từ 2 ĐẾN 3 chỉ số đúng (ví dụ [0, 2] hoặc [1, 2, 3]). BẮT BUỘC chỉ có 2 hoặc 3 đáp án đúng, TUYỆT ĐỐI KHÔNG chọn tất cả và KHÔNG chọn chỉ 1.',
      matching: '4. NỐI CẶP TƯƠNG ỨNG (Matching): "type": "matching", "q": "Yêu cầu nối thuật ngữ với định nghĩa phù hợp...", "pairs": mảng 3 đến 5 cặp [{"left": "Khái niệm A", "right": "Định nghĩa chính xác của A"}, ...]. Vế phải phải tương ứng chuẩn xác với vế trái.',
      short_answer: '5. TRẢ LỜI NGẮN (Short Answer): "type": "short_answer", "q": "Nội dung câu hỏi yêu cầu điền thuật ngữ/từ khóa/con số ngắn...", "answers": mảng 1 đến 3 biến thể đáp án đúng chấp nhận được (ví dụ ["TCP", "Transmission Control Protocol"]).',
    };

    let typeDesc = '';
    if (selectedTypes.length === 1) {
      typeDesc = `LOẠI CÂU HỎI BẮT BUỘC (100%): Hãy tạo 100% câu hỏi theo đúng định dạng sau:\n${typeDescriptions[selectedTypes[0]]}`;
    } else {
      typeDesc = `LOẠI CÂU HỎI: HÃY PHÂN BỔ ĐỀU VÀ XEN KẼ CHÍNH XÁC GIỮA ${selectedTypes.length} ĐỊNH DẠNG ĐƯỢC CHỌN SAU ĐÂY:\n${selectedTypes.map(t => typeDescriptions[t]).join('\n')}\nLƯU Ý QUAN TRỌNG: TUYỆT ĐỐI CHỈ TẠO CÂU HỎI THUỘC CÁC ĐỊNH DẠNG ĐÃ CHỌN TRÊN, KHÔNG TẠO DẠNG NGOÀI DANH SÁCH!`;
    }

    let contextSection = '';
    if (documentContext.trim()) {
      contextSection = `DƯỚI ĐÂY LÀ VĂN BẢN TRÍCH XUẤT TỪ TÀI LIỆU MÔN HỌC:\n${documentContext}\n\n`;
    } else {
      contextSection = `MÔN HỌC: ${body.course || 'Khóa học'}\nTÀI LIỆU: ${effectiveSourceNames.join(', ') || 'Giáo trình môn học'}\n\n`;
    }

    let externalRule = '';
    if (ragMode === 'strict') {
      externalRule = `CHẾ ĐỘ BÁM SÁT TÀI LIỆU NGHIÊM NGẶT (STRICT RAG - 100% GIÁO TRÌNH):
- Câu hỏi BẮT BUỘC bám sát tuyệt đối 100% nội dung tài liệu môn học được cung cấp.
- Tuyệt đối không tự suy diễn, không đưa kiến thức hoặc thuật ngữ nằm ngoài tài liệu giáo trình.
- Mọi đáp án đúng và lời giải thích ("explanation") PHẢI có căn cứ trực tiếp trích xuất từ tài liệu đã cung cấp.`;
    } else if (ragMode === 'hybrid') {
      externalRule = `CHẾ ĐỘ RAG LAI GHÉP (HYBRID RAG - ƯU TIÊN GIÁO TRÌNH & BÙ ĐẮP KHI THIẾU):
- Ưu tiên tối đa khai thác nội dung tài liệu môn học được cung cấp.
- Nếu tài liệu ngắn hoặc thiếu dữ kiện, bạn ĐƯỢC PHÉP vận dụng kiến thức chuyên ngành chuẩn mực để mở rộng câu hỏi tình huống thực tế và bài tập áp dụng.
- Trong phần giải thích ("explanation"), nếu câu hỏi sử dụng kiến thức mở rộng ngoài tài liệu, hãy mở đầu bằng: "[Kiến thức mở rộng]: ..."`;
    } else {
      externalRule = `CHẾ ĐỘ SÁNG TẠO & MỞ RỘNG (CREATIVE / OPEN WEB):
- Bạn ĐƯỢC TOÀN QUYỀN đưa thêm các câu hỏi tình huống thực tế ngành, câu hỏi ứng dụng hiện đại, case study thực tế và câu hỏi mở rộng tư duy sáng tạo ngoài giáo trình.`;
    }

    // Adaptive Learning Remediation Mode
    const generatorMode = body.generatorMode || (body.focusWeakAreas ? 'targeted' : 'comprehensive');
    let effectiveWeakTopics: string[] = body.weakTopics || [];

    if (generatorMode === 'targeted' && effectiveWeakTopics.length === 0) {
      try {
        const courseIdNum = typeof body.courseId === 'number' ? body.courseId : Number(body.courseId);
        const latestAnalysis = await getLatestQuizAnalysis({
          moodleCourseId: !isNaN(courseIdNum) ? courseIdNum : undefined,
          userId: body.userId ? Number(body.userId) : undefined,
        });
        if (latestAnalysis?.weakTopics?.length) {
          effectiveWeakTopics = latestAnalysis.weakTopics;
        }
      } catch (err) {
        console.warn('Could not retrieve weak topics from learning_artifacts:', err);
      }
    }

    let adaptiveSection = '';
    if (generatorMode === 'targeted' && effectiveWeakTopics.length > 0) {
      adaptiveSection = `\nĐẶC BIỆT - CHẾ ĐỘ HỌC TẬP THÍCH ỨNG (ADAPTIVE REMEDIATION):
Sinh viên này đang bị hổng kiến thức hoặc liên tục làm sai ở các chủ đề sau:
${effectiveWeakTopics.map((t, idx) => `  ${idx + 1}. ${t}`).join('\n')}
YÊU CẦU BẮT BUỘC: Hãy tập trung 100% câu hỏi xoáy sâu vào các chủ đề trên! Tăng cường các câu hỏi tình huống thực tế, câu hỏi phân biệt bản chất dễ nhầm lẫn để giúp sinh viên rà soát và khắc phục triệt để lỗ hổng.\n`;
    }

    const prompt = `${contextSection}YÊU CẦU SOẠN ĐỀ TRẮC NGHIỆM:
Hãy tạo chính xác ${count} câu hỏi trắc nghiệm theo chủ đề: "${topic}".
${difficultyDesc}
${typeDesc}
${externalRule}
${adaptiveSection}
${body.quickTest ? `
QUY TẮC RIÊNG CHO CHECK-IN NHANH:
- Mỗi câu hỏi phải kiểm tra một chi tiết cụ thể trong tài liệu: thuật ngữ, định nghĩa, công nghệ, quy trình, ví dụ, đoạn mã, con số hoặc mối quan hệ giữa các khái niệm.
- Không tạo câu hỏi về phương pháp học, mục tiêu học tập, ôn bài, xem điểm, "nên làm gì trước", hoặc lời khuyên chung chung.
- Không dùng các câu hỏi có thể áp dụng nguyên xi cho mọi môn học.
- Quy tắc dấu câu: mọi câu "multiple_choice" BẮT BUỘC kết thúc bằng dấu "?" và có đúng 4 lựa chọn; mọi câu "true_false" BẮT BUỘC là mệnh đề khẳng định KHÔNG có dấu "?". Không hỏi "Câu nào/Điều nào..." trong câu Đúng/Sai.
- Nếu không tìm thấy đủ dữ kiện cụ thể trong tài liệu, hãy tạo ít câu hơn thay vì bịa hoặc dùng kiến thức chung.
` : ''}

QUY TẮC BẮT BUỘC CHO TỪNG LOẠI CÂU HỎI:
1. "multiple_choice": "choices" có 4 phương án, "answer": số nguyên 0..3 (1 đáp án đúng).
2. "true_false": "choices": ["Đúng", "Sai"], "answer": 0 (nếu Đúng) hoặc 1 (nếu Sai).
3. "multiple_select": "choices" có 4-5 phương án, "answers": mảng chứa từ 2 đến 3 chỉ số đúng (ví dụ [0, 2]). KHÔNG chọn tất cả, KHÔNG chọn chỉ 1.
4. "matching": "pairs" mảng 3 đến 5 cặp ghép đúng [{"left": "Khái niệm", "right": "Định nghĩa tương ứng"}].
5. "short_answer": "answers" mảng 1 đến 3 biến thể chuỗi ngắn gọn được chấp nhận.
6. "explanation": Lời giải thích ngắn gọn nhưng đủ ý khoa học.
7. NGÔN NGỮ ĐỀ THI (LANGUAGE CONFORMANCE): Bộ câu hỏi, phương án, đáp án và giải thích BẮT BUỘC dùng CHÍNH XÁC ngôn ngữ của chủ đề/yêu cầu (ví dụ: English nếu chủ đề bằng tiếng Anh, Español nếu bằng tiếng Tây Ban Nha...). Tiếng Việt luôn là ngôn ngữ mặc định nếu chủ đề bằng tiếng Việt hoặc không rõ ngôn ngữ.
8. Trả về đúng JSON object duy nhất có thuộc tính "questions":
{
  "questions": [
    {
      "type": "multiple_choice",
      "q": "Nội dung câu hỏi 1 lựa chọn?",
      "choices": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "answer": 0,
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "true_false",
      "q": "MVC tách Model, View và Controller thành các thành phần độc lập.",
      "choices": ["Đúng", "Sai"],
      "answer": 0,
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "multiple_select",
      "q": "Những khẳng định nào sau đây là ĐÚNG? (Chọn 2 hoặc 3 đáp án)",
      "choices": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "answers": [0, 2],
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "matching",
      "q": "Nối các khái niệm ở cột trái với nội dung tương ứng ở cột phải:",
      "pairs": [
        { "left": "Khái niệm 1", "right": "Nội dung 1" },
        { "left": "Khái niệm 2", "right": "Nội dung 2" },
        { "left": "Khái niệm 3", "right": "Nội dung 3" }
      ],
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "short_answer",
      "q": "Giao thức nào hoạt động ở tầng Giao vận cung cấp truyền dữ liệu tin cậy?",
      "answers": ["TCP", "Transmission Control Protocol"],
      "explanation": "TCP là giao thức hướng kết nối tin cậy..."
    }
  ]
}
Không bao gồm markdown hay văn bản ngoài JSON.`;

    // 3. AI Execution via unified model registry (Quiz: Basic Speed Task -> Groq forward in Strict RAG)
    const maxTokens = Math.min(8000, 1500 + count * 350);
    const seenQuestions = new Set<string>();
    const normalized: QuizQuestion[] = [];

    for (let attempt = 0; attempt < 3 && normalized.length < count; attempt++) {
      try {
        // Mỗi lần thử lại phải yêu cầu câu KHÁC — nếu không, dedup ở dưới sẽ loại
        // toàn bộ câu trùng từ các lần trước và route luôn trả 500 dù model vẫn chạy.
        const retryHint = attempt > 0 && seenQuestions.size > 0
          ? `\n\nLƯU Ý LẦN THỬ ${attempt + 1}: Các câu hỏi sau đã có, TUYỆT ĐỐI không lặp lại (hãy tạo câu khác cùng chủ đề):\n${[...seenQuestions].slice(-30).map((q, i) => `${i + 1}. ${q}`).join('\n')}`
          : '';

        const result = await generateText(body.model, {
          system: 'Bạn là chuyên gia khảo thí và sư phạm đại học. Luôn đảm bảo tuyệt đối tính chính xác của câu hỏi, đáp án đúng và lời giải thích dựa trên sự thật lịch sử và khoa học, chống ảo giác 100%. Trả về đúng JSON schema.',
          userPrompt: `${prompt}${retryHint}`,
          userId: body.userId ? Number(body.userId) : undefined,
          strictModel: Boolean(body.strictModel) && Boolean(body.model && body.model !== 'auto'),
          temperature: ragMode === 'strict' ? 0.0 : ragMode === 'hybrid' ? 0.3 : 0.7,
          topP: ragMode === 'strict' ? 0.001 : ragMode === 'hybrid' ? 0.7 : 0.9,
          maxTokens,
          jsonMode: true,
          googleSearchGrounding: ragMode === 'creative',
          allowExternalSource: ragMode === 'creative',
          ragMode,
          taskCategory: body.quickTest ? 'quick' : 'basic',
          signal: request.signal,
        });

        console.log(
          `[Quiz gen] attempt=${attempt + 1}: provider=${result.provider || 'auto'} model=${result.modelId || '-'} textChars=${result.text.length} preview=${JSON.stringify(result.text.slice(0, 80))}`,
        );
        if (!result.text) {
          console.warn(`[Quiz gen] attempt=${attempt + 1}: cascade trả về rỗng — mọi provider đều fail/bị skip.`);
        }

        if (result.text) {
          // Defensive parse: handles markdown fences, trailing commas, truncation.
          const questionsList = parseQuizJson(result.text);
          // Deduplicate by question text so retry batches don't repeat questions.
          // Nhiều model trả "question" thay vì "q" — chấp nhận cả 3 alias, nếu không
          // toàn bộ câu bị drop ở bước này và route trả 500 dù AI vẫn trả JSON hợp lệ.
          const fresh = questionsList.filter((item: { q?: string; questionText?: string; question?: string }) => {
            const key = String(item?.q || item?.questionText || item?.question || '').toLowerCase().trim();
            if (!key || seenQuestions.has(key)) return false;
            seenQuestions.add(key);
            return true;
          });
          console.log(
            `[Quiz gen] attempt=${attempt + 1}: parsed=${questionsList.length} fresh=${fresh.length} total=${normalized.length}/${count}`,
          );
          const baseIdx = normalized.length;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mapped = fresh.map((item: any, i: number) => {
            const idx = baseIdx + i;
            const rawChoices = item.choices || item.options || [];

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
                return {
                  id: `sq-${idx + 1}-${Date.now()}`,
                  type: 'matching' as const,
                  q: item.q || item.questionText || item.question || `Nối các cặp khái niệm tương ứng sau:`,
                  pairs: validPairs,
                  explanation: item.explanation || '',
                };
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

              return {
                id: `sq-${idx + 1}-${Date.now()}`,
                type: 'short_answer' as const,
                q: item.q || item.questionText || item.question || `Câu hỏi ${idx + 1}`,
                answers: validAnswers.length > 0 ? validAnswers : ['Đáp án đúng'],
                answer: validAnswers[0] || 'Đáp án đúng',
                explanation: item.explanation ? stripFluff(item.explanation) : '',
              };
            }

            // 3. True / False
            if (
              item.type === 'true_false' ||
              item.type === 'truefalse' ||
              (rawChoices.length === 2 && (rawChoices[0].toLowerCase().includes('đúng') || rawChoices[0].toLowerCase().includes('true')))
            ) {
              const ans = typeof item.answer === 'number' ? item.answer : 0;
              return {
                id: `sq-${idx + 1}-${Date.now()}`,
                type: 'true_false' as const,
                q: item.q || item.questionText || item.question || `Câu hỏi ${idx + 1}`,
                choices: ['Đúng', 'Sai'],
                answer: ans === 1 ? 1 : 0,
                explanation: item.explanation ? stripFluff(item.explanation) : '',
              };
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
              const choices = rawChoices.length >= 2 ? rawChoices : ['Lựa chọn A', 'Lựa chọn B', 'Lựa chọn C', 'Lựa chọn D'];
              let validAnswers = rawAnswers
                .map(Number)
                .filter((n: number) => !isNaN(n) && n >= 0 && n < choices.length);

              // Enforce 2 or 3 correct answers, not all and not 1
              if (validAnswers.length <= 1) {
                const remaining = [0, 1, 2, 3].filter(i => i < choices.length && !validAnswers.includes(i));
                validAnswers = [...validAnswers, remaining[0] ?? 1].slice(0, 2);
              } else if (validAnswers.length >= choices.length) {
                validAnswers = validAnswers.slice(0, Math.min(3, choices.length - 1));
              } else if (validAnswers.length > 3) {
                validAnswers = validAnswers.slice(0, 3);
              }

              return {
                id: `sq-${idx + 1}-${Date.now()}`,
                type: 'multiple_select' as const,
                q: item.q || item.questionText || item.question || `Câu hỏi ${idx + 1}`,
                choices,
                answers: validAnswers,
                explanation: item.explanation ? stripFluff(item.explanation) : '',
              };
            }

            // 5. Default: Multiple choice (single)
            const choices = rawChoices.length >= 4 ? rawChoices.slice(0, 4) : [...rawChoices, 'Lựa chọn 1', 'Lựa chọn 2'].slice(0, 4);
            const ans = typeof item.answer === 'number' ? item.answer : 0;
            return {
              id: `sq-${idx + 1}-${Date.now()}`,
              type: 'multiple_choice' as const,
              q: item.q || item.questionText || item.question || `Câu hỏi ${idx + 1}`,
              choices,
              answer: Math.min(choices.length - 1, Math.max(0, ans)),
              explanation: item.explanation ? stripFluff(item.explanation) : '',
            };
          });

          normalized.push(...mapped);
          if (normalized.length >= count) break;
        }
      } catch (err) {
        if (request.signal?.aborted) throw err;
        // Strict manual selection: report the chosen model's failure instead of cascading.
        if (body.strictModel) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : `Model ${body.model} không thể tạo đề trắc nghiệm.` },
            { status: 502 }
          );
        }
        console.warn('AI quiz generation failed:', err);
      }
    }

    if (normalized.length < count) {
      console.warn(`[Quiz gen] giving up: got ${normalized.length}/${count} valid questions after 3 attempts.`);
      if (body.strictModel && body.model && body.model !== 'auto') {
        return NextResponse.json(
          { error: `Model ${body.model} không tạo được câu hỏi hợp lệ. Hãy chọn model khác.` },
          { status: 502 }
        );
      }
      if (body.quickTest) {
        // Không trả về câu hỏi chung chung: nếu AI không sinh được câu hỏi cụ thể từ tài liệu,
        // báo lỗi để client hiển thị thử lại/bỏ qua thay vì câu hỏi meta/generic.
        return NextResponse.json(
          { error: 'Không thể tạo câu hỏi check-in cụ thể từ tài liệu lúc này. Vui lòng thử lại.' },
          { status: 503 }
        );
      }
      return NextResponse.json({ error: 'Không thể tạo đề trắc nghiệm lúc này.' }, { status: 500 });
    }

    const questions = normalized.slice(0, count);
    return NextResponse.json({
      questions,
      count: questions.length,
      difficulty,
      questionType,
      questionTypes: selectedTypes,
      generatorMode,
      weakTopics: effectiveWeakTopics,
      mode: 'ai',
    });
  } catch (error) {
    console.error('Quiz route error:', error);
    return NextResponse.json({ error: 'Lỗi khi tạo đề trắc nghiệm.' }, { status: 500 });
  }
}
