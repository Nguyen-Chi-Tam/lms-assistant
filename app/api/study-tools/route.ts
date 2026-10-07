import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';
import { saveLearningArtifact } from '@/lib/learning-artifacts';
import { parseDocumentFromUrl } from '@/lib/document-parser';
import { retrieveRelevantChunks, formatChunksForPrompt } from '@/lib/rag';
import { getPersonalMaterials } from '@/lib/firebase-data';
import { cleanSummaryData } from '@/lib/summary-cleaner';
import { COMMON_FLUFF_STOP_SEQUENCES } from '@/lib/anti-fluff';
import type { RagMode } from '@/app/types';

interface SourceItem {
  name: string;
  url?: string;
  type?: string;
}

const cancelledRequests = new Map<string, number>();
const CANCEL_EXPIRY_MS = 10 * 60 * 1000;

class RequestAbortedError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'AbortError';
  }
}

function throwIfRequestAborted(request: Request, requestId?: string) {
  const now = Date.now();
  for (const [id, cancelledAt] of cancelledRequests) {
    if (now - cancelledAt > CANCEL_EXPIRY_MS) cancelledRequests.delete(id);
  }
  if (request.signal.aborted || (requestId && cancelledRequests.has(requestId))) {
    throw new RequestAbortedError();
  }
}

function extractJsonObject(text: string) {
  const start = text.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  // An invalid closing quote can prevent a balanced scan.  This fallback still
  // gives the repairer the JSON-shaped part instead of any prose around it.
  return text.slice(start, text.lastIndexOf('}') + 1);
}

function repairCommonJsonMistakes(json: string) {
  return json
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    // Newlines are legal only when escaped inside a JSON string.
    .replace(/"([^"\\]*(?:\\.[^"\\]*)*)\r?\n([^"\\]*(?:\\.[^"\\]*)*)"/g, '"$1\\n$2"')
    // A number of fallback models omit separators between generated items.
    .replace(/"\s*"/g, '","')
    .replace(/([}\]])\s*"/g, '$1,"')
    .replace(/"\s*([{\[])/g, '",$1')
    .replace(/([}\]])\s*([{\[])/g, '$1,$2')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseGeneratedJson(text: string): unknown {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const candidate = extractJsonObject(normalized);
  const attempts = [normalized, candidate, repairCommonJsonMistakes(candidate)].filter(Boolean);

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next, progressively more defensive representation.
    }
  }
  throw new Error('Mô hình AI không trả về JSON hợp lệ. Vui lòng thử lại hoặc đổi mô hình.');
}

export async function POST(request: Request) {
  let requestId: string | undefined;
  let isCancelRequest = false;
  try {
    const body = (await request.json()) as {
      action?: 'cancel';
      requestId?: string;
      type?: 'summary' | 'mindmap' | 'flashcards' | 'slides' | 'slide' | 'presentation';
      topic?: string;
      course?: string;
      courseCode?: string;
      courseId?: string | number;
      userId?: number;
      sourceNames?: string[];
      sources?: SourceItem[];
      level?: 'simple' | 'standard' | 'complex';
      ragMode?: RagMode;
      allowExternalSource?: boolean;
      model?: string;
    };

    requestId = body.requestId;
    isCancelRequest = body.action === 'cancel';
    if (isCancelRequest) {
      if (requestId) cancelledRequests.set(requestId, Date.now());
      return NextResponse.json({ success: true });
    }

    throwIfRequestAborted(request, requestId);

    const toolType = body.type || 'summary';
    const level = body.level || 'standard';
    const topic = body.topic || 'Nội dung học tập';

    const effectiveSources: SourceItem[] =
      body.sources && body.sources.length > 0
        ? body.sources
        : (body.sourceNames || []).map(name => ({ name }));

    const effectiveSourceNames = effectiveSources.map(s => s.name);

    // 1. Gather document context from personal_materials / Moodle
    let documentContext = '';
    const docMap = new Map<string, string>();
    const moodleCourseId = Number(body.courseId) || undefined;

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
        console.warn('Firebase personal_materials query in study-tools:', firebaseError);
      }
    }

    // Parse URL documents if needed
    for (const src of effectiveSources) {
      throwIfRequestAborted(request, requestId);
      const lowerName = src.name.toLowerCase();
      if (!docMap.has(lowerName) && src.url) {
        try {
          const extractedText = await parseDocumentFromUrl(src.url, src.name);
          if (extractedText && extractedText.trim()) {
            docMap.set(lowerName, extractedText);
          }
        } catch {
          // ignore
        }
      }
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

    const ragMode: RagMode = body.ragMode || (body.allowExternalSource ? 'creative' : 'hybrid');

    // Strict RAG Circuit Breaker: If no documents or empty content, block without LLM call (0 tokens spent)
    if (ragMode === 'strict' && compiledDocs.length === 0) {
      return NextResponse.json(
        { error: 'Tài liệu khóa học hiện tại không chứa thông tin này.' },
        { status: 400 }
      );
    }

    if (compiledDocs.length > 0) {
      const documentCharBudget = level === 'complex' ? 36000 : level === 'simple' ? 12000 : 25000;
      try {
        const retrievalBudget = level === 'complex'
          ? { topK: 12, maxTotalChars: 30000 }
          : level === 'simple'
            ? { topK: 4, maxTotalChars: 9000 }
            : { topK: 8, maxTotalChars: 18000 };
        const relevantChunks = await retrieveRelevantChunks(topic, compiledDocs, {
          ...retrievalBudget,
          minSimilarity: 0.15,
        });

        if (relevantChunks.length > 0) {
          documentContext = formatChunksForPrompt(relevantChunks);
        } else {
          const maxPerDoc = Math.max(2500, Math.floor(documentCharBudget / compiledDocs.length));
          documentContext = compiledDocs
            .map(doc => `=== NỘI DUNG TÀI LIỆU: "${doc.title}" ===\n${doc.text.slice(0, maxPerDoc)}`)
            .join('\n\n');
        }
      } catch (ragErr) {
        console.warn('RAG retrieval warning in study-tools:', ragErr);
        const maxPerDoc = Math.max(2500, Math.floor(documentCharBudget / compiledDocs.length));
        documentContext = compiledDocs
          .map(doc => `=== NỘI DUNG TÀI LIỆU: "${doc.title}" ===\n${doc.text.slice(0, maxPerDoc)}`)
          .join('\n\n');
      }
    }

    // 2. Define Level Prompts, Shapes & Technical Settings
    let levelInstruction = '';
    let shapeDesc = '';
    let systemInstruction = '';
    let effectiveStopSequences: string[] | undefined = undefined;

    // RAG Mode Directive
    let ragInstruction = '';
    if (ragMode === 'strict') {
      ragInstruction = `BỘ QUY TẮC STRICT RAG (KỶ LUẬT THÉP & TUYỆT ĐỐI BÁM SÁT TÀI LIỆU):
- CHỈ trích xuất và tổng hợp dữ liệu nằm trong thẻ <document>.
- TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài, cấm tự suy diễn chủ quan hoặc bịa thêm nội dung ngoài tài liệu.`;
    } else if (ragMode === 'hybrid') {
      ragInstruction = `BỘ QUY TẮC HYBRID RAG (ƯU TIÊN GIÁO TRÌNH & MINH BẠCH NGUỒN GỐC):
- Ưu tiên tối đa việc sử dụng thông tin trong thẻ <document>.
- Nếu tài liệu thiếu dữ kiện nhỏ hoặc cần hoàn thiện ví dụ thực tế: Được phép bổ sung kiến thức chuyên môn mở rộng nhưng phải bám sát tinh thần môn học.`;
    } else {
      ragInstruction = `CHẾ ĐỘ SÁNG TẠO (CREATIVE / OPEN WEB):
- Dữ liệu trong thẻ <document> (nếu có) đóng vai trò tham khảo nhẹ.
- Bạn được toàn quyền sử dụng kiến thức chuyên môn, liên hệ thực tế ngành nghề, công nghệ hiện đại và mở rộng tư duy đa chiều.`;
    }

    if (level === 'simple') {
      // 1. Mức độ Cơ bản (Nhanh & Tối ưu chi phí)
      // Chấp nhận rập khuôn để tiết kiệm quota tối đa, như một cỗ máy tóm tắt đơn thuần, gạch đầu dòng khô khan nhưng đi thẳng vào vấn đề.
      systemInstruction = 'Bạn là công cụ tóm tắt và trích xuất dữ liệu học thuật nhanh gọn. Bạn hoạt động như một cỗ máy trích xuất đơn thuần, chủ động chấp nhận sự rập khuôn ngắn gọn để tiết kiệm quota tối đa. Đi thẳng vào vấn đề, không chào hỏi, không hoa mỹ, trả về JSON hợp lệ 100%. Tuyệt đối không chèn ký hiệu trích dẫn (như [1], (tài liệu x)).';

      if (toolType === 'summary') {
        levelInstruction = `CẤP ĐỘ CƠ BẢN (NHANH & TỐI ƯU CHI PHÍ):
Bóc tách nhanh 3-4 luận điểm trọng tâm nhất trong vòng 1-2 phút. Trả về các gạch đầu dòng ngắn gọn, khô khan nhưng đi thẳng vào bản chất vấn đề, không hoa mỹ.`;
        shapeDesc = '{ "title": "Tiêu đề", "overview": "Tóm tắt 1-2 câu ngắn", "points": ["Luận điểm 1", "Luận điểm 2", "Luận điểm 3"] }';
      } else if (toolType === 'mindmap') {
        levelInstruction = `CẤP ĐỘ CƠ BẢN (NHANH & TỐI ƯU CHI PHÍ):
Sơ đồ tư duy 3-4 nhánh chính, mỗi nhánh gồm 2-3 từ khóa trọng tâm, bóc tách nhanh khái niệm cốt lõi.`;
        shapeDesc = '{ "root": "Chủ đề cốt lõi", "branches": [ { "title": "Nhánh chính 1", "items": ["Từ khóa 1", "Từ khóa 2"] } ] }';
      } else if (toolType === 'slides' || toolType === 'slide' || toolType === 'presentation') {
        levelInstruction = `CẤP ĐỘ CƠ BẢN (NHANH & TỐI ƯU CHI PHÍ):
Tạo bộ slide tóm tắt nhanh gồm 4-5 trang slide trọng tâm. Mỗi slide tối đa 3 gạch đầu dòng ngắn gọn, đi thẳng vào ý chính, phần notes ngắn gọn 20-35 từ.`;
        shapeDesc = `{
  "title": "Tiêu đề bài giảng",
  "topic": "${topic}",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Tên Slide",
      "subtitle": "Phụ đề ngắn",
      "bullets": ["Ý chính 1", "Ý chính 2", "Ý chính 3"],
      "keyTakeaway": "Điểm cốt lõi cần nhớ",
      "notes": "Lời dẫn ngắn gọn..."
    }
  ]
}`;
      } else {
        levelInstruction = 'CẤP ĐỘ CƠ BẢN: Tạo chính xác 5 thẻ ghi nhớ khái niệm then chốt nhất, ngắn gọn, súc tích.';
        shapeDesc = '{ "flashcards": [ { "front": "Khái niệm / Câu hỏi", "back": "Định nghĩa / Câu trả lời ngắn" } ] }';
      }
    } else if (level === 'standard') {
      // 2. Mức độ Tiêu chuẩn (Cân bằng)
      // Cấu trúc mạch lạc, dàn trải đều đặn từ 5-7 luận điểm, ngôn từ lịch sự chuẩn mực bài giảng. Áp dụng Stop Sequences.
      effectiveStopSequences = [...COMMON_FLUFF_STOP_SEQUENCES];
      systemInstruction = 'Bạn là chuyên gia sư phạm và kiến trúc tri thức. Xây dựng bài giảng chuẩn mực, mạch lạc, ngôn từ sư phạm lịch sự, bố cục cân đối và trả về JSON hợp lệ 100%. Tuyệt đối không chèn ký hiệu trích dẫn (như [1], (tài liệu x)).';

      if (toolType === 'summary') {
        levelInstruction = `CẤP ĐỘ TIÊU CHUẨN (CÂN BẰNG):
Xây dựng cấu trúc mạch lạc, dàn trải đều đặn từ 5-7 luận điểm cân đối, dễ tiếp thu cho người học. 1 đoạn tổng quan và các luận điểm bài giảng chuẩn mực.`;
        shapeDesc = '{ "title": "Tiêu đề", "overview": "Tổng quan môn học/chủ đề", "points": ["Luận điểm 1", "Luận điểm 2", "Luận điểm 3", "Luận điểm 4", "Luận điểm 5", "Luận điểm 6"] }';
      } else if (toolType === 'mindmap') {
        levelInstruction = `CẤP ĐỘ TIÊU CHUẨN (CÂN BẰNG):
Sơ đồ tư duy 4-6 nhánh cân đối, mỗi nhánh chứa 3-4 khái niệm cốt lõi theo cấu trúc bài giảng chuẩn.`;
        shapeDesc = '{ "root": "Chủ đề chính", "branches": [ { "title": "Nhánh 1", "items": ["Mục 1", "Mục 2", "Mục 3"] } ] }';
      } else if (toolType === 'slides' || toolType === 'slide' || toolType === 'presentation') {
        levelInstruction = `CẤP ĐỘ TIÊU CHUẨN (CÂN BẰNG):
Tạo chính xác bộ slide bài giảng chuẩn mực (7-9 trang slide). Cấu trúc bao gồm trang mở đầu, các slide bài học phân bổ đồng đều và slide tổng kết. Lời giảng notes lịch sự, rõ ràng (40-60 từ).`;
        shapeDesc = `{
  "title": "Tiêu đề bài giảng / Bài thuyết trình",
  "topic": "${topic}",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Tên Slide",
      "subtitle": "Phụ đề / Ngữ cảnh",
      "bullets": ["Ý chính 1", "Ý chính 2", "Ý chính 3"],
      "keyTakeaway": "Điểm cốt lõi cần nhớ",
      "notes": "Lời giảng chuẩn mực cho giảng viên khi thuyết trình trang này..."
    }
  ]
}`;
      } else {
        levelInstruction = 'CẤP ĐỘ TIÊU CHUẨN: Tạo chính xác 8-10 thẻ ghi nhớ cân đối, giải thích chuẩn mực.';
        shapeDesc = '{ "flashcards": [ { "front": "Câu hỏi / Khái niệm", "back": "Câu trả lời / Giải thích rõ ràng" } ] }';
      }
    } else {
      // 3. Mức độ Chuyên sâu (Tự nhiên & Con người)
      // Zero-Shot Roleplay: Giảng viên tâm huyết, giàu kinh nghiệm thực tế.
      // Anti-Placeholder & Anti-Fluff Prompting: Triệt tiêu văn mẫu, cấm giữ chỗ [Tên...], [Chèn ví dụ...].
      // Kiểm soát Token: Đào sâu nguyên lý, công thức, ví dụ thực tế, phân tích đa chiều.
      effectiveStopSequences = [...COMMON_FLUFF_STOP_SEQUENCES];
      systemInstruction = `Bạn là một giảng viên đại học tâm huyết, chuyên gia đầu ngành giàu kinh nghiệm thực tế đang biên soạn học liệu chuyên sâu cho sinh viên năm cuối môn "${body.course || 'học phần'}".

QUY TẮC PHONG CÁCH TỰ NHIÊN NHƯ CON NGƯỜI (BẮT BUỘC):
1. ZERO-SHOT ROLEPLAY: Trình bày sống động, sâu sắc, lập luận đa chiều, liên hệ thực tế ngành nghề; tuyệt đối không trả lời máy móc rập khuôn sách vở.
2. TRIỆT TIÊU VĂN MẪU & RÀO ĐÓN NGUỒN (ANTI-FLUFF): Tuyệt đối cấm các câu rào đón sáo rỗng ("Dưới đây là...", "Hy vọng học liệu này...", "Dựa trên tài liệu bạn cung cấp...", "Theo tài liệu..."). Đi thẳng vào nội dung chuyên môn đỉnh cao.
3. CHẶN ĐỨNG TỪ NGỮ RẬP KHUÔN (ANTI-PLACEHOLDER): Tuyệt đối không xuất các thẻ giữ chỗ rập khuôn dạng: [Tên...], [Chèn ví dụ...], [Ngày/tháng...]. Tự động điền dữ liệu thực tế và câu chữ hoàn chỉnh 100%.
4. ĐÀO SÂU NGUYÊN LÝ & CÔNG THỨC: Phân tích cặn kẽ bản chất, cơ chế hoạt động, công thức toán học/thuật toán (dùng LaTeX chuẩn nếu có) và quyết định thực tiễn.
5. Luôn bảo đảm tính xác thực học thuật, chống ảo giác và trả về đúng định dạng JSON hợp lệ 100%. Tuyệt đối không chèn ký hiệu trích dẫn (như [1], (tài liệu x)).`;

      if (toolType === 'summary') {
        levelInstruction = `CẤP ĐỘ CHUYÊN SÂU (TỰ NHIÊN & CON NGƯỜI):
Phân tích toàn diện, đa chiều, đào sâu nguyên lý, cơ chế, cấu trúc và ví dụ thực tế với 8-12 luận điểm sâu sắc.
YÊU CẦU ĐỘ DÀI & ĐỘ SÂU: Đảm bảo độ dài tối thiểu tương đương 1/2 max_token của hướng trả lời nhanh (tối thiểu từ 350-450 từ trở lên), phân tích cặn kẽ mọi góc nhìn, không viết nông cạn.`;
        shapeDesc = '{ "title": "Tiêu đề chuyên sâu", "overview": "Bản phân tích tổng quan chi tiết và sâu sắc", "points": ["Luận điểm 1: Phân tích cơ chế và bản chất", "Luận điểm 2: Nguyên lý và cấu trúc vận hành", "Luận điểm 3: Đánh đổi và các trường hợp biên", "Luận điểm 4: Ví dụ thực tiễn chuyên sâu", "Luận điểm 5: Lưu ý ứng dụng thực tế", "Luận điểm 6: Đối chiếu và so sánh", "Luận điểm 7: Thách thức thường gặp", "Luận điểm 8: Định hướng tối ưu"] }';
      } else if (toolType === 'mindmap') {
        levelInstruction = `CẤP ĐỘ CHUYÊN SÂU (TỰ NHIÊN & CON NGƯỜI):
Tạo một sơ đồ tư duy có chiều sâu và có chủ đích (6-9 nhánh chính theo đúng trọng số chủ đề).
- Nhánh cơ chế, tình huống thực tế hoặc đánh đổi được đào sâu với 3-6 mục con.
- Mỗi mục con là một ý hoàn chỉnh, giàu thông tin (nguyên lý, quan hệ nhân quả, ví dụ, ngoại lệ, đánh đổi hoặc lưu ý thực hành).
- Tuyệt đối không dùng các nhãn giữ chỗ chung chung như "Mục 1", "Khái niệm", "Đặc điểm".`;
        shapeDesc = '{ "root": "Tên chủ đề cụ thể", "branches": [ { "title": "Tên nhánh giàu nghĩa chuyên môn", "items": ["Ý cụ thể có quan hệ hoặc hệ quả", "Ví dụ hoặc đánh đổi thực tế liên quan"] } ] }';
      } else if (toolType === 'slides' || toolType === 'slide' || toolType === 'presentation') {
        levelInstruction = `CẤP ĐỘ CHUYÊN SÂU (TỰ NHIÊN & CON NGƯỜI):
Tạo một bộ slide bài giảng chuyên sâu (10-14 trang slide).
- Mạch lập luận tự nhiên: vấn đề/câu hỏi lớn → nguyên lý nền tảng → cơ chế hoạt động/đối chiếu → ví dụ, giới hạn & quyết định thực tế.
- Trên mặt slide: Mỗi bullet tối đa 6 từ, đắt giá, dứt khoát.
- Phần notes: Là lời giảng tâm huyết 60-100 từ như một giảng viên đại học đang say sưa giảng giải cho sinh viên năm cuối, chia sẻ kinh nghiệm thực chiến và câu hỏi gợi mở.`;
        shapeDesc = `{
  "title": "Tiêu đề bài giảng chuyên sâu",
  "topic": "${topic}",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Tên Slide",
      "subtitle": "Ngữ cảnh chuyên sâu",
      "bullets": ["Luận điểm then chốt", "Cơ chế bản chất", "Đánh đổi thực tiễn"],
      "keyTakeaway": "Đúc kết kinh nghiệm cốt lõi",
      "notes": "Lời giảng tâm huyết của giảng viên phân tích sâu cho sinh viên..."
    }
  ]
}`;
      } else {
        levelInstruction = 'CẤP ĐỘ CHUYÊN SÂU: Tạo chính xác 12-16 thẻ ghi nhớ chuyên sâu kèm tình huống thực tế, bẫy trắc nghiệm tư duy và giải thích cặn kẽ tại sao đúng/sai.';
        shapeDesc = '{ "flashcards": [ { "front": "Tình huống / Câu hỏi đào sâu nguyên lý", "back": "Phân tích cặn kẽ bản chất và lời giải thích chuyên môn" } ] }';
      }
    }

    let contextPart = '';
    if (documentContext.trim()) {
      contextPart = `DƯỚI ĐÂY LÀ VĂN BẢN TÀI LIỆU MÔN HỌC:\n<document>\n${documentContext}\n</document>\n\n`;
    } else {
      contextPart = `MÔN HỌC: ${body.course || 'Khóa học'}\nDANH SÁCH TÀI LIỆU: ${effectiveSourceNames.join(', ') || 'Giáo trình môn học'}\n<document>\n(Không có tài liệu nào được tích chọn hoặc tài liệu chưa có nội dung văn bản)\n</document>\n\n`;
    }

    const prompt = `${contextPart}YÊU CẦU:
Hãy tạo ${toolType} cho chủ đề: "${topic}".
NGÔN NGỮ NỘI DUNG (LANGUAGE CONFORMANCE): Toàn bộ tiêu đề, các luận điểm, slide, thẻ ghi nhớ hoặc sơ đồ tư duy BẮT BUỘC dùng CHÍNH XÁC ngôn ngữ của chủ đề/yêu cầu (ví dụ: English nếu chủ đề bằng tiếng Anh, Español nếu bằng tiếng Tây Ban Nha...). Tiếng Việt luôn là ngôn ngữ mặc định nếu chủ đề bằng tiếng Việt hoặc không rõ ngôn ngữ.
${levelInstruction}
${ragInstruction}

BẮT BUỘC trả về đúng một JSON object duy nhất theo định dạng:
${shapeDesc}
JSON HỢP LỆ LÀ ĐIỀU KIỆN BẮT BUỘC: đặt dấu phẩy giữa mọi phần tử mảng/thuộc tính; không dùng dấu phẩy cuối; không đặt dấu ngoặc kép bên trong nội dung chuỗi (hãy dùng «...» hoặc viết lại nếu cần).
Không bao gồm bất kỳ văn bản ngoài hay markdown.`;

    // 3. AI Execution via unified model registry
    // Complex: slide structure, branching mindmap, deep comparison
    // Basic: concise summary, definitions (speed forward)
    const isComplex = level === 'complex' || toolType === 'slides' || toolType === 'slide' || toolType === 'presentation' || toolType === 'mindmap';
    const taskCategory: 'basic' | 'complex' = isComplex ? 'complex' : 'basic';

    // Technical parameters by level and RAG mode:
    const effectiveTemperature =
      ragMode === 'strict'
        ? 0.0
        : ragMode === 'hybrid'
          ? (level === 'complex' ? 0.35 : 0.20)
          : (level === 'complex' ? 0.85 : 0.75);

    const effectiveTopP =
      ragMode === 'strict'
        ? 0.0
        : ragMode === 'hybrid'
          ? 0.50
          : 0.90;

    const effectiveMaxTokens =
      level === 'complex'
        ? (toolType === 'slides' || toolType === 'slide' || toolType === 'presentation' ? 5000 : 3500)
        : level === 'simple'
          ? (toolType === 'slides' || toolType === 'slide' || toolType === 'presentation' ? 1200 : 900)
          : (toolType === 'slides' || toolType === 'slide' || toolType === 'presentation' ? 2600 : 2000);

    try {
      throwIfRequestAborted(request, requestId);
      const result = await generateText(body.model, {
        system: systemInstruction,
        userPrompt: prompt,
        signal: request.signal,
        temperature: effectiveTemperature,
        topP: effectiveTopP,
        maxTokens: effectiveMaxTokens,
        jsonMode: true,
        allowExternalSource: ragMode === 'creative',
        taskCategory,
        stop: effectiveStopSequences,
        ragMode,
      });

      throwIfRequestAborted(request, requestId);

      if (result.text) {
        const parsed = parseGeneratedJson(result.text) as Record<string, unknown> | unknown[];
        let data: unknown = parsed;
        if (toolType === 'summary') {
          data = cleanSummaryData(parsed as any);
        } else if (toolType === 'flashcards' && !Array.isArray(parsed)) {
          data = parsed.flashcards || parsed.cards || (Array.isArray(parsed) ? parsed : []);
        } else if (toolType === 'slides' || toolType === 'slide' || toolType === 'presentation') {
          data = !Array.isArray(parsed) && parsed.slides
            ? parsed
            : { title: topic, topic, slides: Array.isArray(parsed) ? parsed : [] };
        }

        // Save learning artifact to database
        throwIfRequestAborted(request, requestId);
        const numericUserId = body.userId || 4;
        const targetCourseId = moodleCourseId || 1;
        const artifactOrientation = toolType === 'mindmap' ? 'horizontal' : undefined;
        const artifactContentData: Record<string, unknown> = {
          name: topic,
          topic,
          level,
          data: data as Record<string, unknown>,
        };
        if (artifactOrientation) {
          artifactContentData.orientation = artifactOrientation;
          if (data && typeof data === 'object') {
            (data as Record<string, unknown>).orientation = artifactOrientation;
          }
        }
        const savedArtifact = await saveLearningArtifact({
          userId: numericUserId,
          moodleCourseId: targetCourseId,
          artifactType: toolType,
          contentData: artifactContentData,
        }).catch(saveErr => {
          console.warn('saveLearningArtifact warning in study-tools:', saveErr);
        });

        return NextResponse.json({ data, mode: 'ai', level, artifactId: savedArtifact?.id || null });
      }
    } catch (err) {
      if (err instanceof RequestAbortedError || request.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      console.warn('AI study-tools generation failed:', err);
    }

    return NextResponse.json({ error: 'Không thể tạo học liệu lúc này.' }, { status: 500 });
  } catch (error) {
    if (error instanceof RequestAbortedError || request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    console.error('Study tool error:', error);
    return NextResponse.json({ error: 'Lỗi xử lý yêu cầu.' }, { status: 500 });
  }
}
