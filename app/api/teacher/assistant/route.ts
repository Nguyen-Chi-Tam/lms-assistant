import { NextResponse } from 'next/server';
import { generateText, detectTaskCategory } from '@/models/registry';
import { supabaseAdmin } from '@/lib/supabase';
import { parseDocumentFromUrl } from '@/lib/document-parser';
import {
  scoreAndSelectChunks,
  formatChunksForPrompt,
  chunkDocument,
  filterSourcesByPromptMetadata,
  type DocumentChunk,
} from '@/lib/rag';
import { getPersonalMaterials } from '@/lib/firebase-data';
import {
  getStoredCourseEmbeddings,
  vectorizeAndStoreLmsSource,
  getExistingCourseFileIds,
  isWebOrTransientSource,
  hydrateChunksWithParentText,
} from '@/lib/supabase-vector';
import { stripFluff, COMMON_FLUFF_STOP_SEQUENCES } from '@/lib/anti-fluff';
import { getCircuitBreakerNotice } from '@/lib/language-detector';
import { findCachedAnswer, storeCachedAnswer, isPersonalQuery } from '@/lib/semantic-cache';
import type { RagMode, CitationSource } from '@/app/types';

interface ChatHistoryItem {
  role: 'user' | 'ai' | 'model' | 'assistant';
  text: string;
}

interface SourceItem {
  id?: string;
  name: string;
  url?: string;
  type?: string;
  fileId?: number;
  moduleId?: number;
  sectionId?: number;
  sectionName?: string;
  chapter?: string | number;
  isStudentUpload?: boolean;
  content?: string;
}

interface StudentScoreItem {
  columnName: string;
  maxScore: number;
  score: number | null;
}

interface StudentItem {
  id: number | string;
  fullname: string;
  username?: string;
  idnumber?: string;
  scores?: StudentScoreItem[];
}

interface StudentSummary {
  total?: number;
  names?: string[];
}

interface GradeColumnSummary {
  id?: number | string;
  name: string;
  grademax: number;
}

interface UpcomingEventItem {
  title: string;
  due?: string;
  type?: string;
}

export async function POST(request: Request) {
  try {
    const {
      question = '',
      course = '',
      courseCode = '',
      courseId,
      sources = [],
      sourceNames = [],
      history = [],
      model = 'auto',
      students,
      gradeColumns = [],
      upcomingEvents = [],
      ragMode: rawRagMode,
      allowExternalSource: legacyAllowExternalSource = false,
      answerStyle = 'concise',
      stop,
      stopSequences,
    } = (await request.json()) as {
      question?: string;
      course?: string;
      courseCode?: string;
      courseId?: string | number;
      sources?: SourceItem[];
      sourceNames?: string[];
      history?: ChatHistoryItem[];
      model?: string;
      students?: StudentItem[] | StudentSummary;
      gradeColumns?: GradeColumnSummary[];
      upcomingEvents?: UpcomingEventItem[];
      ragMode?: RagMode;
      allowExternalSource?: boolean;
      answerStyle?: 'concise' | 'detailed';
      stop?: string[];
      stopSequences?: string[];
    };

    if (!question.trim()) {
      return NextResponse.json({ error: 'Câu hỏi không được để trống.' }, { status: 400 });
    }

    const ragMode: RagMode = rawRagMode || (legacyAllowExternalSource ? 'creative' : 'hybrid');
    const allowExternalSource = ragMode === 'creative';
    const moodleCourseId = Number(courseId) || undefined;
    const isManualModel = Boolean(model && model !== 'auto');

    // 0. Semantic Caching (Check duplicate queries to save quota when not running manual model testing)
    if (!isManualModel && !isPersonalQuery(question)) {
      try {
        const cachedHit = await findCachedAnswer({
          question: `[mode:${ragMode}] ${question}`,
          courseId: moodleCourseId,
        });

        if (cachedHit) {
          const cleanCachedAnswer = stripFluff(cachedHit.answer);
          console.log(
            `[Teacher Assistant Semantic Cache] 0ms HIT (Similarity: ${cachedHit.similarity}, Hits: ${cachedHit.hitCount}) for: "${question.slice(0, 40)}..."`
          );
          return NextResponse.json({
            answer: cleanCachedAnswer,
            sources: [],
            cached: true,
            ragMode,
            model: 'Semantic Cache (0ms)',
            provider: 'cache',
          });
        }
      } catch (cacheErr) {
        console.warn('Teacher Assistant Semantic Cache lookup error:', cacheErr);
      }
    }

    const effectiveSources = Array.isArray(sources) ? sources : [];
    const effectiveSourceNames = Array.isArray(sourceNames) && sourceNames.length > 0
      ? sourceNames
      : effectiveSources.map(s => s.name);

    // 1. Retrieve ONLY checked course documents for RAG grounding
    let documentContext = '';
    const docMap = new Map<string, string>();
    // Metadata Filtering ("Judge the book by its cover") to skip irrelevant sources before fetch/embedding
    const preFilteredSources = filterSourcesByPromptMetadata(effectiveSources, question);
    const checkedUploadSources = preFilteredSources.filter(isWebOrTransientSource);
    const checkedLmsSources = preFilteredSources.filter(s => !isWebOrTransientSource(s));

    // A. For checked LMS sources in Supabase pgvector:
    let storedLmsChunks: DocumentChunk[] = [];
    if (moodleCourseId && checkedLmsSources.length > 0) {
      try {
        const existingLmsFileIds = await getExistingCourseFileIds(moodleCourseId);
        const lmsToIngest = checkedLmsSources.filter(src => {
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

        // Retrieve stored LMS vectors strictly for checked LMS sources
        const lmsTitles = checkedLmsSources.map(s => s.name);
        storedLmsChunks = await getStoredCourseEmbeddings(moodleCourseId, {
          docTitles: lmsTitles,
        });
      } catch (lmsVecErr) {
        console.warn('Teacher Assistant pgvector retrieval note:', lmsVecErr);
      }
    }

    // B. For checked teacher/user uploaded files or notes:
    // Only search materials matching the checked sources list!
    if (checkedUploadSources.length > 0) {
      // 1. Direct content if passed
      for (const src of checkedUploadSources) {
        if (src.content && src.content.trim()) {
          docMap.set(src.name.toLowerCase(), src.content.trim());
        }
      }

      // 2. Query Firebase personal materials ONLY for matching checked sources
      if (moodleCourseId) {
        try {
          const mats = await getPersonalMaterials({ moodleCourseId, limit: 30 });
          if (mats) {
            const matchingMats = mats.filter(m =>
              checkedUploadSources.some(s =>
                s.name.toLowerCase() === String(m.title).toLowerCase() ||
                (s.id && (s.id.includes(String(m.id)) || String(m.id).includes(s.id)))
              )
            );

            for (const mat of matchingMats) {
              const lowerTitle = String(mat.title).toLowerCase();
              if (mat.storage_url && !docMap.has(lowerTitle)) {
                try {
                  const text = await parseDocumentFromUrl(String(mat.storage_url), String(mat.title));
                  if (text && text.length > 20) {
                    docMap.set(lowerTitle, text);
                  }
                } catch {
                  // ignore
                }
              }
            }
          }
        } catch (firebaseErr) {
          console.warn('Firebase query for teacher upload materials:', firebaseErr);
        }
      }

      // 3. Fallback: Parse URL if provided directly on the checked source
      for (const src of checkedUploadSources) {
        const lowerName = src.name.toLowerCase();
        if (!docMap.has(lowerName) && src.url) {
          try {
            const extractedText = await parseDocumentFromUrl(src.url, src.name);
            if (extractedText && extractedText.trim().length > 20) {
              docMap.set(lowerName, extractedText.trim());
            }
          } catch (urlErr) {
            console.warn(`Could not parse checked upload ${src.name}:`, urlErr);
          }
        }
      }
    }

    // C. Combine Chunks strictly from checked sources
    const inMemoryChunks: DocumentChunk[] = [];
    for (const [title, text] of docMap.entries()) {
      const chunks = chunkDocument(title, text);
      inMemoryChunks.push(...chunks);
    }

    const allCandidateChunks: DocumentChunk[] = [...storedLmsChunks, ...inMemoryChunks];

    // Filter candidate chunks so they ONLY belong to titles in effectiveSources
    const allowedTitles = new Set(effectiveSources.map(s => s.name.toLowerCase().trim()));
    const filteredCandidateChunks = allCandidateChunks.filter(chunk => {
      if (allowedTitles.size === 0) return false;
      const t = chunk.docTitle.toLowerCase().trim();
      return allowedTitles.has(t) || Array.from(allowedTitles).some(at => t.includes(at) || at.includes(t));
    });

    const lowerQ = question.toLowerCase();
    const isPedagogicalTask =
      lowerQ.includes('soạn') ||
      lowerQ.includes('câu hỏi') ||
      lowerQ.includes('thảo luận') ||
      lowerQ.includes('bài tập') ||
      lowerQ.includes('đề thi') ||
      lowerQ.includes('giáo án') ||
      lowerQ.includes('bài giảng') ||
      lowerQ.includes('kế hoạch') ||
      lowerQ.includes('gợi ý') ||
      lowerQ.includes('rubric') ||
      lowerQ.includes('hoạt động');

    const isChapterIntent =
      lowerQ.includes('chương') ||
      lowerQ.includes('bài 1') ||
      lowerQ.includes('bài đầu') ||
      lowerQ.includes('chương 1') ||
      lowerQ.includes('chương đầu');

    const isOverviewQuery =
      isPedagogicalTask ||
      isChapterIntent ||
      lowerQ.includes('file') ||
      lowerQ.includes('tài liệu') ||
      lowerQ.includes('slide') ||
      lowerQ.includes('nội dung') ||
      lowerQ.includes('tóm tắt') ||
      lowerQ.includes('mục lục') ||
      lowerQ.includes('giới thiệu') ||
      lowerQ.includes('đề tài');

    // 2. Build Upcoming Events context for Course Reference
    let eventsContext = '';
    let upcomingEventsList: Array<{ title: string; due: string; type?: string }> = [];

    if (Array.isArray(upcomingEvents) && upcomingEvents.length > 0) {
      upcomingEventsList = upcomingEvents.map(e => ({
        title: e.title,
        due: e.due || '',
        type: e.type || 'Sự kiện',
      }));
    } else if (moodleCourseId && supabaseAdmin) {
      try {
        const { data: dbEvts } = await supabaseAdmin
          .from('events')
          .select('title, deliver_time, event_type')
          .eq('moodle_course_id', moodleCourseId)
          .gte('deliver_time', new Date().toISOString())
          .order('deliver_time', { ascending: true })
          .limit(8);

        if (dbEvts && dbEvts.length > 0) {
          upcomingEventsList = dbEvts.map(e => ({
            title: e.title,
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
        console.warn('Teacher Assistant Supabase events query error:', evtErr);
      }
    }

    if (upcomingEventsList.length > 0) {
      eventsContext = upcomingEventsList
        .map((e, idx) => `  ${idx + 1}. [${e.type || 'Sự kiện'}] ${e.title} (Thời gian/Hạn chót: ${e.due || 'Chưa ấn định'})`)
        .join('\n');
    }

    // 3. Build Gradebook context for Course Reference
    let gradebookContext = '';
    if (Array.isArray(students) && students.length > 0) {
      gradebookContext += `- Sĩ số lớp: ${students.length} sinh viên\n`;
      if (gradeColumns.length > 0) {
        gradebookContext += `- Các cột điểm kiểm tra:\n`;
        gradeColumns.forEach((col, i) => {
          gradebookContext += `  ${i + 1}. "${col.name}" (Điểm tối đa: ${col.grademax}đ)\n`;
        });
      }

      gradebookContext += `\n- BẢNG ĐIỂM CHI TIẾT TỪNG SINH VIÊN (DỮ LIỆU ĐIỂM THỰC TẾ):\n`;
      students.forEach(s => {
        const idInfo = s.idnumber || s.username ? ` [Mã SV: ${s.idnumber || s.username}]` : '';
        gradebookContext += `  * Sinh viên: **${s.fullname}**${idInfo}\n`;
        if (Array.isArray(s.scores) && s.scores.length > 0) {
          s.scores.forEach(sc => {
            if (sc.score !== null && sc.score !== undefined) {
              const pct = sc.maxScore > 0 ? ` (${Math.round((sc.score / sc.maxScore) * 100)}%)` : '';
              gradebookContext += `      - Cột "${sc.columnName}": **${sc.score}** / ${sc.maxScore}đ${pct}\n`;
            } else {
              gradebookContext += `      - Cột "${sc.columnName}": Chưa có điểm\n`;
            }
          });
        } else {
          gradebookContext += `      - Chưa có điểm ghi nhận\n`;
        }
      });
    } else if (students && typeof students === 'object' && 'total' in students && (students.total ?? 0) > 0) {
      gradebookContext += `- Sĩ số: ${students.total} sinh viên`;
      if (students.names && students.names.length > 0) {
        gradebookContext += `\n- Danh sách: ${students.names.slice(0, 30).join(', ')}`;
      }
    }

    const isGradeQuery =
      lowerQ.includes('điểm') ||
      lowerQ.includes('sinh viên') ||
      lowerQ.includes('học lực') ||
      lowerQ.includes('phổ điểm') ||
      lowerQ.includes('danh sách');
    const isEventQuery =
      lowerQ.includes('lịch') ||
      lowerQ.includes('hạn') ||
      lowerQ.includes('deadline') ||
      lowerQ.includes('sự kiện');

    const hasInternalCourseData =
      (isGradeQuery && gradebookContext.trim().length > 0) ||
      (isEventQuery && eventsContext.trim().length > 0);

    let isFallback = false;

    // Strict Mode Circuit Breaker (When no candidates exist and not an internal data inquiry)
    if (ragMode === 'strict' && filteredCandidateChunks.length === 0 && !hasInternalCourseData) {
      console.log(`[Teacher Assistant Circuit Breaker] 0 candidate chunks in strict mode: "${question.slice(0, 50)}"`);
      return NextResponse.json({
        answer: getCircuitBreakerNotice(question),
        sources: [],
        cached: false,
        ragMode: 'strict',
        isFallback: false,
        model: 'Circuit Breaker (0 tokens)',
        provider: 'guardrail',
      });
    } else if (ragMode === 'hybrid' && filteredCandidateChunks.length === 0 && !hasInternalCourseData) {
      isFallback = true;
    }

    if (filteredCandidateChunks.length > 0) {
      try {
        let relevantChunks = scoreAndSelectChunks(filteredCandidateChunks, question, {
          topK: 8,
          maxTotalChars: 20000,
          minSimilarity: 0.10,
        });

        const topScore = relevantChunks.length > 0
          ? Math.max(
              relevantChunks[0].similarityScore ?? 0,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (relevantChunks[0] as any).rerankScore ?? 0
            )
          : 0;

        // Strict Mode Circuit Breaker (Scored 0 relevant chunks or topScore < 0.5)
        if (ragMode === 'strict' && (relevantChunks.length === 0 || topScore < 0.5) && !isOverviewQuery && !hasInternalCourseData) {
          console.log(`[Teacher Assistant Circuit Breaker] topScore ${topScore} < 0.5 or 0 relevant chunks: "${question.slice(0, 50)}"`);
          return NextResponse.json({
            answer: getCircuitBreakerNotice(question),
            sources: [],
            cached: false,
            ragMode: 'strict',
            isFallback: false,
            model: 'Circuit Breaker (0 tokens)',
            provider: 'guardrail',
          });
        }

        if (ragMode === 'hybrid' && (relevantChunks.length === 0 || topScore < 0.5) && !isOverviewQuery && !hasInternalCourseData) {
          isFallback = true;
        }

        // If the question is pedagogical, overview, chapter-specific, or yielded few chunks:
        // Guarantee lead and beginning chunks of each checked document are included!
        if (isOverviewQuery || relevantChunks.length < 3) {
          const leadChunks: DocumentChunk[] = [];
          const seenChunkIds = new Set(relevantChunks.map(c => c.id));
          for (const title of allowedTitles) {
            const docChunks = filteredCandidateChunks
              .filter(c =>
                c.docTitle.toLowerCase().trim() === title ||
                c.docTitle.toLowerCase().includes(title) ||
                title.includes(c.docTitle.toLowerCase())
              )
              .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));

            // Pull first 15 chunks (which cover the opening chapters, introduction, and outlines)
            docChunks.slice(0, 15).forEach(c => {
              if (!seenChunkIds.has(c.id)) {
                leadChunks.push(c);
                seenChunkIds.add(c.id);
              }
            });
          }
          relevantChunks = [...leadChunks, ...relevantChunks].slice(0, 24);
        }

        // Hydrate condensed child chunks with full parent text from Firebase
        const hydratedChunks = await hydrateChunksWithParentText(relevantChunks);
        documentContext = formatChunksForPrompt(hydratedChunks);
      } catch (ragErr) {
        console.warn('Teacher Assistant RAG retrieval error:', ragErr);
        // Fallback: take top slices of each available doc with hydration
        const fallbackChunks = await hydrateChunksWithParentText(filteredCandidateChunks.slice(0, 8));
        documentContext = formatChunksForPrompt(fallbackChunks);
      }
    }

    const ragDocuments = filteredCandidateChunks.slice(0, 15).map((c, idx) => ({
      id: `doc_${idx + 1}`,
      title: c.docTitle || `Tài liệu ${idx + 1}`,
      text: c.text,
    }));

    // 4. Build System Instruction with strict separation
    const subjectName = course || 'môn học hiện tại';

    let modeInstruction = '';
    if (ragMode === 'strict') {
      modeInstruction = `Bạn là công cụ trích xuất văn bản. CHỈ trả lời dựa trên dữ liệu nằm trong thẻ <document>. Tuyệt đối không sử dụng kiến thức bên ngoài. Nếu dữ liệu trong thẻ không đủ để trả lời, bạn BẮT BUỘC phải nói chính xác: 'Không có thông tin trong tài liệu'.
- Tuyệt đối cấm sử dụng kiến thức ngoài tài liệu, cấm suy diễn chủ quan hoặc bịa đặt số liệu (Zero Creativity).
- Triệt tiêu hoàn toàn văn mẫu, không chào hỏi, không kết bài dư thừa.`;
    } else if (ragMode === 'hybrid') {
      modeInstruction = `Bạn là trợ lý học tập. Hãy ưu tiên tối đa việc sử dụng thông tin trong thẻ <document> để trả lời. Nếu thẻ <document> trống hoặc thiếu dữ kiện, bạn ĐƯỢC PHÉP dùng kiến thức nền tảng và tri thức chuyên ngành để giải thích thấu đáo cho Giảng viên.
- QUY TẮC ANTI-FLUFF (TUYỆT ĐỐI KHÔNG PERFORMATIVE / KHÔNG MÀU MÈ NÓI VỀ NGUỒN):
  + TUYỆT ĐỐI KHÔNG BAO GIỜ nói các câu như: "Dựa trên các tài liệu bạn cung cấp...", "Dựa trên tài liệu được cung cấp...", "Dựa trên kiến thức mở rộng ngoài khóa học...", "Dựa trên các nguồn bên ngoài tôi tìm được...", "Based on the sources provided...", "Based on the external sources I found...".
  + ĐI THẲNG TRỰC TIẾP VÀO BẢN CHẤT VẤN ĐỀ TỪ TỪ ĐẦU TIÊN (Jump straight to the problem). Tuyệt đối không tạo banner, không tạo callout phân bua về nguồn gốc kiến thức.
- Bám sát tài liệu đã được cung cấp trong thẻ <document> và trích dẫn chuẩn xác khi có. Cấm chào hỏi xã giao, cấm kết bài thừa thãi.`;
    } else {
      modeInstruction = `Bạn là một giảng viên AI uyên bác. Hãy giải thích chi tiết, cặn kẽ và mở rộng vấn đề bằng các ví dụ thực tế, code mẫu hoặc xu hướng công nghệ mới nhất. Bạn được toàn quyền sử dụng kiến thức chuyên môn của mình.
- Dữ liệu trong thẻ <document> (nếu có) đóng vai trò tham khảo nhẹ, bạn không bị giới hạn trong thẻ này.
- Triệt tiêu văn mẫu và tiết kiệm token: không chào hỏi, không kết bài thừa thãi.`;
    }

    const systemInstruction = `Bạn là TRỢ LÝ AI CHUYÊN BIỆT CHO GIẢNG VIÊN (Teacher AI Assistant) môn "${subjectName}".

VAI TRÒ & NĂNG LỰC:
Bạn hỗ trợ Giảng viên với TẤT CẢ các công việc giảng dạy, bao gồm:
1. GỢI Ý TÀI LIỆU & NGUỒN HỌC LIỆU: Đề xuất sách giáo khoa, bài báo khoa học, video bài giảng, trang web chuyên ngành, bài tập thực hành phù hợp với nội dung môn ${subjectName}. Ưu tiên nguồn tiếng Việt khi có, kèm nguồn quốc tế uy tín.
2. SOẠN BÀI TẬP VỀ NHÀ (Homework): Tạo bài tập với đề bài rõ ràng, yêu cầu cụ thể, tiêu chí chấm điểm (rubric), và gợi ý thời gian hoàn thành. Phân loại theo mức độ (cơ bản / nâng cao).
3. LẬP KẾ HOẠCH BÀI GIẢNG (Lesson Plan): Soạn kế hoạch bài giảng chi tiết bao gồm: mục tiêu học tập (Learning Outcomes), nội dung chính, hoạt động trên lớp, phương pháp giảng dạy, thời lượng dự kiến từng phần, và tài liệu tham khảo.
4. TẠO CÂU HỎI KIỂM TRA & ÔN TẬP: Soạn câu hỏi trắc nghiệm, tự luận, hoặc bài tập tình huống phù hợp với nội dung môn học. Đảm bảo phân bổ theo các mức độ nhận thức Bloom (Nhớ, Hiểu, Vận dụng, Phân tích, Đánh giá, Sáng tạo).
5. PHÂN TÍCH PHỔ ĐIỂM & HIỆU QUẢ GIẢNG DẠY: Khi có dữ liệu sổ điểm, phân tích chính xác điểm số, xác định sinh viên cần hỗ trợ, đánh giá hiệu quả từng cột điểm.
6. SOẠN NHẬN XÉT SINH VIÊN: Viết feedback chuyên nghiệp, mang tính xây dựng cho từng sinh viên hoặc nhóm dựa trên kết quả học tập.

${modeInstruction}

QUY TẮC PHÂN ĐỊNH NGUỒN DỮ LIỆU TUYỆT ĐỐI (CỰC KỲ QUAN TRỌNG - KHÔNG ĐƯỢC NHẦM LẪN):
1. MỤC "CÁC TÀI LIỆU BÀI GIẢNG / HỌC TẬP ĐƯỢC CHỌN TỪ CỘT TRÁI":
   - Đây là tài liệu giáo trình, bài giảng, slide PowerPoint, tài liệu đồ án... mà Giảng viên ĐÃ TÍCH CHỌN ở danh sách nguồn tài liệu bên trái màn hình.
   - Bạn CHỈ ĐƯỢC đọc và trích dẫn kiến thức bài học từ các tài liệu ĐÃ ĐƯỢC TÍCH CHỌN trong thẻ <document>.
   - KHI GIẢNG VIÊN HỎI VỀ "file này", "slide này", "tài liệu này", "nội dung của file", "tóm tắt bài giảng" hoặc kiến thức chuyên đề: Bạn BẮT BUỘC phải đọc và trả lời từ mục tài liệu được chọn này.
   - TUYỆT ĐỐI KHÔNG ĐƯỢC nhầm lẫn giữa tài liệu bài giảng/slide với phần SỔ ĐIỂM hay LỊCH SỰ KIỆN!
   - TUYỆT ĐỐI KHÔNG đem bảng điểm số của sinh viên ra để tóm tắt cho câu hỏi về nội dung file/slide bài giảng!

2. MỤC "THÔNG TIN SỔ ĐIỂM & ĐÁNH GIÁ LỚP HỌC":
   - Đây là dữ liệu quản lý điểm số và đánh giá sinh viên của môn học. AI luôn được cung cấp để biết thông tin lớp học.
   - CHỈ SỬ DỤNG dữ liệu này khi giảng viên hỏi về: điểm số, nhận xét sinh viên, phổ điểm, sinh viên nào cần hỗ trợ, thống kê điểm bài kiểm tra.
   - Khi trả lời về điểm: BẮT BUỘC dùng đúng số liệu thực tế, không tự bịa điểm.

3. MỤC "LỊCH TRÌNH & SỰ KIỆN SẮP TỚI":
   - Dùng khi giảng viên hỏi về thời hạn nộp bài tập, lịch thi, sự kiện sắp diễn ra của môn học.

QUY TẮC PHONG CÁCH & ĐỊNH DẠNG SƯ PHẠM (BẮT BUỘC):
1. TRIỆT TIÊU VĂN MẪU, LỜI CHÀO & THÔNG BÁO NGUỒN (ANTI-FLUFF - KHÔNG PERFORMATIVE):
- TUYỆT ĐỐI CẤM MỌI CÂU TỪ CHÀO HỎI VÀ XÃ GIAO ĐẦU CÂU: CẤM nói "Chào anh/chị", "Chào anh", "Chào chị", "Chào bạn", "Chào thầy/cô", "Kính chào thầy cô", "Xin chào", "Dạ vâng", "Thưa thầy cô", v.v. Kèm mọi icon chào mừng (như 🎓, 👋, 😊).
- TUYỆT ĐỐI CẤM MỌI CÂU THÔNG BÁO NGUỒN (CẤM: "Dựa trên tài liệu bạn cung cấp...", "Dựa trên kiến thức mở rộng ngoài khóa học...", "Dựa trên các nguồn bên ngoài tôi tìm được...", "Theo tài liệu...", "Based on the sources provided...", "Based on the external sources I found..."). Nguồn tài liệu đã có hệ thống trích dẫn và hiển thị ở chân trang.
- ĐI THẲNG TRỰC TIẾP VÀO NỘI DUNG VẤN ĐỀ (Jump straight to the problem): Bắt đầu câu trả lời ngay từ từ đầu tiên bằng bản chất chuyên môn hoặc giải pháp sư phạm (Ví dụ: "ReactJS là thư viện JavaScript...", KHÔNG CÓ bất kỳ chữ chào hay chữ rào đón nguồn nào đứng trước).
- TUYỆT ĐỐI CẤM VĂN MẪU KẾT BÀI THỪA: Cấm các câu như "Hy vọng thông tin này giúp ích cho thầy cô...", "Hy vọng giáo án...", "Chúc thầy cô...", "Tóm lại,...", "Kết luận:...". Ngắt bài ngay khi hoàn thành nội dung trọng tâm.
2. ĐỊNH DẠNG CODE & THUẬT NGỮ CHUẨN MỰC:
- Các thuật ngữ chuyên môn, thư viện, tên hàm, API, lệnh (như \`router.push\`, \`router.query\`, \`ReactJS\`, \`Next.js\`, \`useState\`) BẮT BUỘC đặt trong cặp backtick \`code\`. In đậm **từ khóa then chốt** để tăng tính trực quan.
3. CHẶN ĐỨNG TỪ NGỮ ĐIỀN KHUYẾT RẬP KHUÔN (ANTI-PLACEHOLDER):
- TUYỆT ĐỐI KHÔNG xuất các thẻ placeholder giữ chỗ rập khuôn dạng: [Tên sinh viên], [Tên bạn], [Tên giảng viên], [Ngày/tháng], [Chèn ví dụ tại đây], [Nội dung...].
- Tự động điền dữ liệu thực tế từ ngữ cảnh môn học đã có, hoặc diễn đạt thành câu văn tự nhiên, hoàn chỉnh 100% để giảng viên có thể sử dụng được ngay mà không cần điền khuyết thủ công.
4. ZERO-SHOT ROLEPLAY (NHẬP VAI THỰC CHIẾN TỰ NHIÊN):
- Nhập vai Trợ lý Sư phạm Đại học cấp cao, giàu kinh nghiệm thực tế, am hiểu sâu sắc giáo trình và thực tiễn ngành nghề.
- Trình bày sống động, chuyên nghiệp, giàu giá trị ứng dụng thực tiễn; tuyệt đối không trả lời máy móc rập khuôn sách vở.
5. PHONG CÁCH & MỨC ĐỘ CHI TIẾT (BẮT BUỘC TUÂN THỦ):
${answerStyle === 'detailed'
  ? '- Đang chọn "Chi tiết / Chuyên sâu": ĐẢM BẢO ĐỘ DÀI TỐI THIỂU BẰNG 1/2 GIỚI HẠN TOKEN CỦA PHONG CÁCH NHANH (tối thiểu từ 350 - 450 từ trở lên). Phân tích toàn diện, sâu sắc, giải thích cặn kẽ nguyên lý, dẫn chứng đầy đủ, lập bảng so sánh hoặc hướng dẫn từng bước chi tiết.'
  : '- Đang chọn "Nhanh / Trọng tâm": Trình bày cô đọng, súc tích trong 1-2 đoạn văn ngắn (hoặc tối đa 2-3 gạch đầu dòng), đi thẳng vào kết luận và giải pháp then chốt. KHI HỎI NÊN DÙNG GÌ, BẮT BUỘC CHỌN ĐÚNG 1 CÁI DUY NHẤT. CẤM lập bảng Markdown, CẤM chia nhiều mục La Mã, không dông dài. TUYỆT ĐỐI KHÔNG viết nháp, không đếm từ, không phân tích yêu cầu đề bài.'}
6. VĂN PHONG HỌC THUẬT CHUẨN MỰC: Sử dụng ngôn ngữ chuẩn sư phạm đại học, trang trọng, khúc chiết, chuẩn xác. Tuyệt đối không dùng phong cách suồng sã hay mỉa mai.
7. QUY TẮC ĐỒNG BỘ NGÔN NGỮ (LANGUAGE CONFORMANCE - BẮT BUỘC):
- Luôn nhận diện và phản hồi bằng CHÍNH XÁC ngôn ngữ mà Giảng viên sử dụng trong câu hỏi (English, Español, Français, Deutsch, 日本語, 中文...).
- TIẾNG VIỆT LUÔN LÀ NGÔN NGỮ MẶC ĐỊNH (Vietnamese is always the default): Nếu câu hỏi bằng tiếng Việt, câu hỏi hỗn hợp hoặc không rõ ngôn ngữ, BẮT BUỘC phản hồi hoàn toàn bằng Tiếng Việt chuẩn mực sư phạm.
- Toàn bộ giáo án, bài tập và tài liệu soạn thảo phải đồng nhất theo ngôn ngữ của yêu cầu.
8. TOÁN HỌC: Sử dụng LaTeX chuẩn $công_thức$ (ví dụ: $O(n \\log n)$, $\\sum_{i=1}^{n}$).
9. BẢNG BIỂU: ${answerStyle === 'concise' ? 'Ở chế độ "Nhanh / Trọng tâm", CẤM dùng bảng Markdown Table.' : 'Dùng thẻ <br/> xuống dòng trong ô bảng Markdown. Không đặt code block bên trong ô bảng.'}
10. Khi soạn câu hỏi trắc nghiệm, trình bày rõ đáp án đúng và lời giải thích.
11. LIÊN KẾT NGUỒN NGOÀI: ${answerStyle === 'concise' ? 'Tối đa 1 link duy nhất nhúng inline [Tên](url). CẤM spam danh sách link.' : 'Mọi liên kết URL phải nhúng inline trực tiếp vào câu chữ dạng [Tên](https://...). TUYỆT ĐỐI KHÔNG tạo riêng từng gạch đầu dòng chỉ để dán link (như "• [Link](...)"). Tuyệt đối không tự bịa link.'}`;

    // 5. Build Grounded Context Prompt
    let contextSection = `MÔN HỌC: ${course} (Mã môn: ${courseCode || 'N/A'})\n\n`;

    // Document context section (Only checked sources) inside <document> tags
    contextSection += `=== CÁC TÀI LIỆU BÀI GIẢNG / HỌC TẬP ĐƯỢC CHỌN TỪ CỘT TRÁI ===\n<document>\n`;
    if (documentContext.trim()) {
      contextSection += `${documentContext}\n</document>\n\n`;
    } else {
      contextSection += `Danh sách tài liệu đang chọn: ${effectiveSourceNames.join(', ') || '(Không có tài liệu nào được tích chọn)'}\n(Không có tài liệu nào được tích chọn hoặc tài liệu chưa có nội dung văn bản)\n</document>\n\n`;
    }

    // Gradebook context section (Course reference)
    if (gradebookContext.trim()) {
      contextSection += `=== THÔNG TIN SỔ ĐIỂM & ĐÁNH GIÁ LỚP HỌC (DỮ LIỆU ĐIỂM SỐ NỘI BỘ, KHÔNG PHẢI NỘI DUNG TÀI LIỆU BÀI GIẢNG) ===\n${gradebookContext}\n\n`;
    }

    // Upcoming events context section (Course reference)
    if (eventsContext.trim()) {
      contextSection += `=== LỊCH TRÌNH & SỰ KIỆN SẮP TỚI CỦA KHÓA HỌC (CHỈ DÙNG KHI HỎI VỀ DEADLINE / SỰ KIỆN) ===\n${eventsContext}\n\n`;
    }

    const promptAnchor = `\n\n[LỆNH BỔ TRỢ BẮT BUỘC - ANTI-FLUFF, ANTI-PLACEHOLDER & TIẾT KIỆM TOKEN]:
1. TUYỆT ĐỐI CẤM CHÀO HỎI VÀ CẤM THÔNG BÁO NGUỒN (CẤM: "Chào anh/chị", "Dựa trên tài liệu bạn cung cấp...", "Dựa trên kiến thức mở rộng...", "Based on the sources provided..."). ĐI THẲNG TRỰC TIẾP VÀO NỘI DUNG VẤN ĐỀ TỪ TỪ ĐẦU TIÊN (JUMP STRAIGHT TO THE PROBLEM).
2. CẤM KẾT BÀI VĂN MẪU ("Hy vọng...", "Tóm lại...", "Kết luận:...").
3. ANTI-PLACEHOLDER: Tuyệt đối không để lại các thẻ giữ chỗ [Tên sinh viên], [Chèn ví dụ], [Ngày/tháng]. Tự động điền dữ liệu thực tế hoặc viết câu văn hoàn chỉnh.
4. NGÔN NGỮ: Sử dụng CHÍNH XÁC ngôn ngữ của câu hỏi (English -> English, Español -> Español, Français -> Français...), mặc định luôn là Tiếng Việt nếu câu hỏi bằng tiếng Việt hoặc không rõ ngôn ngữ.
${answerStyle === 'concise' && !isOverviewQuery
  ? '5. PHONG CÁCH NHANH / TRỌNG TÂM: Trả lời súc tích trong 1-2 đoạn văn ngắn, đi thẳng vào bản chất và giải pháp then chốt.\n6. Nếu hỏi về lựa chọn công nghệ/giải pháp: Chọn đúng 1 phương án tối ưu nhất kèm 1-2 lý do then chốt.\n7. CHỈ XUẤT CÂU TRẢ LỜI: Cấm xuất suy nghĩ nội tâm, cấm viết nháp, cấm đếm từ, cấm lặp lại chỉ thị.'
  : '5. PHONG CÁCH CHI TIẾT / CHUYÊN SÂU: Đảm bảo độ dài tối thiểu bằng 1/2 giới hạn token của chế độ nhanh (tối thiểu từ 350 - 450 từ trở lên), phân tích cặn kẽ mọi khía cạnh, nguyên lý, dẫn chứng và ví dụ trực quan.'}`;

    const userPrompt = `${contextSection}---\nYÊU CẦU CỦA GIẢNG VIÊN: ${question}${promptAnchor}`;

    // 6. Generate AI response
    let aiText = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let groundingMetadata: any = null;

    // Dynamic Temperature & Top_P by RAG Mode:
    // Strict: temperature = 0.0, top_p = 0.0 (Zero creativity, strictly deterministic facts)
    // Hybrid: temperature = 0.35 (0.30 - 0.40 range), top_p = 0.5
    // Creative: temperature = 0.80 (0.7 - 0.9 range), top_p = 0.9
    const effectiveTemperature =
      ragMode === 'strict'
        ? 0.0
        : ragMode === 'hybrid'
          ? (isFallback ? 0.40 : 0.35)
          : (answerStyle === 'concise' ? 0.75 : 0.85);

    const effectiveTopP =
      ragMode === 'strict'
        ? 0.0
        : ragMode === 'hybrid'
          ? 0.50
          : 0.90;

    const effectiveDocuments = ragMode === 'creative' ? undefined : ragDocuments;
    const outOfContextStandardMsg = 'Tài liệu khóa học hiện tại không chứa thông tin này.';

    let maxTokensLimit: number;
    if (isOverviewQuery) {
      maxTokensLimit = 1500;
    } else if (answerStyle === 'concise') {
      maxTokensLimit = 800; // Giới hạn token đối với hướng trả lời nhanh
    } else {
      maxTokensLimit = 3000; // Hướng trả lời chi tiết: độ dài tối thiểu bằng 1/2 max_token của hướng nhanh
    }

    // ── Stop Sequences (Chuỗi dừng): Triệt tiêu văn mẫu kết bài thừa ──
    let effectiveStopSequences: string[] | undefined = stop || stopSequences;
    if (!effectiveStopSequences || effectiveStopSequences.length === 0) {
      effectiveStopSequences = [...COMMON_FLUFF_STOP_SEQUENCES];
    }

    let teacherModelError: string | null = null;
    let chosenModelName = model || 'AI Assistant';
    let chosenProviderName = model ? model.split(':')[0] : 'auto';
    let resultFinishReason = 'stop';

    try {
      const isManualModel = Boolean(model && model !== 'auto');
      const teacherTaskCategory = isOverviewQuery
        ? 'basic'
        : (answerStyle === 'concise' ? 'basic' : undefined);

      const effectiveCategory = detectTaskCategory({
        system: systemInstruction,
        userPrompt,
        history: history.slice(-8).map(msg => ({
          role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: msg.text,
        })),
        documents: effectiveDocuments,
        taskCategory: teacherTaskCategory,
      });

      const result = await generateText(model, {
        system: systemInstruction,
        userPrompt,
        history: history.slice(-8).map(msg => ({
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
        strictModel: isManualModel,
        ragMode,
      });
      aiText = result.text;
      chosenModelName = result.modelName || chosenModelName;
      chosenProviderName = result.provider || chosenProviderName;
      groundingMetadata = result.groundingMetadata || null;
      if (result.finishReason) resultFinishReason = result.finishReason;
    } catch (err: unknown) {
      teacherModelError = err instanceof Error ? err.message : String(err);
      console.warn(`[Teacher Assistant] Model ${model} execution error:`, teacherModelError);
    }

    if (teacherModelError) {
      return NextResponse.json({
        answer: `⚠️ **Báo cáo lỗi hoạt động của model [${model}]:**\n\n\`\`\`\n${teacherModelError}\n\`\`\`\n\n*Hệ thống đang chạy ở chế độ Kiểm thử Giảng viên: Model này được bắt chạy độc lập (không tự động fallback) để bạn kiểm tra chính xác cách thức hoạt động và phản hồi lỗi của API.*`,
        sources: [],
        model: chosenModelName,
        provider: chosenProviderName,
        error: teacherModelError,
      });
    }

    if (!aiText) {
      return NextResponse.json({
        answer: `⚠️ **Không thể kết nối API AI**\n\nVui lòng kiểm tra lại API key trong cấu hình hệ thống.`,
        sources: [],
      });
    }

    const isOutOfContext =
      ragMode === 'strict' &&
      !isPedagogicalTask &&
      (aiText.includes('[OUT_OF_CONTEXT]') || aiText.includes('[MISSING_CONTEXT]') || aiText.includes('Không có thông tin trong tài liệu'));
    if (isOutOfContext) {
      aiText = outOfContextStandardMsg;
    } else if (aiText.includes('[OUT_OF_CONTEXT]')) {
      aiText = aiText.replace(/\[OUT_OF_CONTEXT\]/gi, '').trim();
    }

    if (!isOutOfContext && aiText) {
      aiText = stripFluff(aiText);
    }

    // Save to Semantic Cache if not personal query and not out of context
    if (!isPersonalQuery(question) && !isOutOfContext && aiText) {
      storeCachedAnswer({
        question: `[mode:${ragMode}] ${question}`,
        answer: aiText,
        courseId: moodleCourseId,
      }).catch(() => {});
    }

    // 7. Extract grounding sources
    const citedSources: CitationSource[] = [];
    if (!isOutOfContext && groundingMetadata?.groundingChunks?.length) {
      const seenUrls = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const chunk of groundingMetadata.groundingChunks as any[]) {
        const uri = chunk?.web?.uri;
        let title = chunk?.web?.title || '';
        if (uri) {
          if (!title) {
            try {
              title = new URL(uri).hostname.replace(/^www\./, '');
            } catch {
              title = 'Nguồn tham khảo';
            }
          }
          if (!seenUrls.has(uri) && citedSources.length < 5) {
            seenUrls.add(uri);
            citedSources.push({
              name: title,
              isExternal: true,
              url: uri,
              type: 'external_web',
            });
          }
        }
      }
    }

    // Include checked document names if they were utilized and not out of context
    if (!isOutOfContext && documentContext.trim() && effectiveSourceNames.length > 0) {
      effectiveSourceNames.slice(0, 3).forEach(name => {
        if (!citedSources.some(c => c.name === name)) {
          citedSources.unshift({
            name,
            isExternal: false,
            url: '',
            type: 'course_material',
          });
        }
      });
    }

    // If hybrid fallback occurred, add the orange warning badge
    if (isFallback) {
      citedSources.unshift({
        name: 'Kiến thức tham khảo ngoài giáo trình',
        isExternal: false,
        url: '',
        type: 'extended_knowledge',
        isFallback: true,
      });
    }

    return NextResponse.json({
      answer: aiText,
      sources: citedSources,
      model: chosenModelName,
      provider: chosenProviderName,
      ragMode,
      isFallback,
      finishReason: resultFinishReason,
    });
  } catch (error) {
    console.error('Teacher Assistant Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi kết nối tới Trợ lý AI.' },
      { status: 500 }
    );
  }
}
