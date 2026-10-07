/**
 * Anti-Fluff, Anti-Placeholder & Persona utilities:
 * Enforces zero-filler, zero-greeting, token-saving, non-templated responses across all AI models.
 */

/**
 * Universal stop sequences to halt models before they generate
 * boilerplate conclusion paragraphs ("Hy vọng...", "Tóm lại...", "Kết luận:...").
 * Note: Never include '\n\n' here as a stop sequence because paragraph breaks
 * in markdown would prematurely truncate responses mid-thought.
 */
export const COMMON_FLUFF_STOP_SEQUENCES = [
  'Tóm lại,',
  'Kết luận:',
  'Hy vọng',
  'In conclusion,',
  'To summarize,',
  'Hope this helps',
  'En conclusión,',
];

/**
 * Regex for stripping leading greetings, polite conversational openings,
 * and conversational filler emitted by LLMs (e.g. Llama, Groq, Gemini).
 */
const LEADING_FLUFF_REGEX = /^(?:(?:\*{1,2}|_{1,2})?(?:dạ\s+vâng|dạ|xin\s+chào|kính\s+chào|thưa\s+quý\s+thầy\s+cô|thưa\s+thầy\s+cô|thưa\s+bạn|thưa\s+anh\/chị|chào\s+(?:quý\s+thầy\s+cô|thầy\s+cô|quý\s+thầy|quý\s+cô|quý\s+vị|anh\/chị|anh\s+chị|anh|chị|bạn|các\s+bạn|em)|chào|hello|hi\b|hey\b|dear\s+(?:student|teacher|user)|hola|buenos\s+días)[^a-zA-Z0-9\n\r\p{L}\p{N}]*(?:\*{1,2}|_{1,2})?[\s!,.:;•\-—~🎓👋😊]*\n*)+/iu;

/**
 * Regex for stripping trailing conversational filler and boilerplate goodbyes.
 */
const TRAILING_FLUFF_REGEX = /(?:\n+|\.\s+)(?:(?:\*{1,2}|_{1,2})?(?:hy\s+vọng\s+(?:thông\s+tin|câu\s+trả\s+lời|giải\s+thích|bài\s+viết|hướng\s+dẫn|giáo\s+án|nội\s+dung)|chúc\s+(?:bạn|thầy\s+cô|quý\s+thầy\s+cô|anh\/chị)|nếu\s+(?:bạn|thầy\s+cô|anh\/chị)\s+cần\s+(?:thêm\s+thông\s+tin|hỗ\s+trợ)|tóm\s+lại|hope\s+(?:this\s+helps|this\s+information\s+helps|it\s+helps)|in\s+conclusion|to\s+summarize|espero\s+que\s+esto\s+te\s+ayude|en\s+conclusión)[^.\n]*[.\s!👋🎓😊]*(?:\*{1,2}|_{1,2})?[\s\n]*)$/iu;

/**
 * Regex for identifying lazy template placeholders like [Tên sinh viên], [Chèn ví dụ tại đây], etc.
 */
const PLACEHOLDER_REGEX = /\[(?:tên\s+(?:sinh\s+viên|bạn|giảng\s+viên|thầy\s+cô|trường|lớp|môn)|ngày(?:\/tháng)?(?:\/năm)?|thời\s+gian|địa\s+điểm|mã\s+sv|mã\s+số|chèn\s+ví\s+dụ[^\]]*|điền\s+vào\s+đây|nội\s+dung\s+cần\s+điền|insert\s+here|your\s+name)\]/giu;

/**
 * Regex for stripping trailing word-count loops (e.g. "Đếm: Java(1) SDK(2)...", "Word count: 120", "Count: ...").
 */
const WORD_COUNT_VERIFICATION_REGEX = /(?:\r?\n+|^|\.\s+)(?:đếm(?:\s+từ)?|count|word\s*count|tổng\s+số\s+từ)\s*:[\s\S]*$/iu;

/**
 * Regex for stripping leading scratchpad planning where models talk to themselves before answering:
 * e.g. "Người dùng hỏi ... Yêu cầu: ... Độ dài 80-150 từ. Hãy đếm xấp xỉ."
 */
const SCRATCHPAD_PREFIX_REGEX = /^(?:người\s+dùng\s+hỏi|yêu\s+cầu\s*:|phân\s+tích\s*(?:đề\s+bài|yêu\s+cầu)|bối\s+cảnh\s*:|xem\s+xét\s+yêu\s+cầu|nội\s+dung\s*:|here(?:'s|\s+is)\s+(?:the\s+)?(?:thought|thinking))[\s\S]*?(?:(?:hãy\s+đếm\s+(?:xấp\s+xỉ|từ)|bắt\s+đầu\s+trực\s+tiếp|sau\s+đây\s+là\s+đáp\s+án|nội\s+dung\s+trả\s+lời)[\s:.]*\n*)/iu;

/**
 * Regex for stripping leading and inline performative source filler phrases:
 * - "Dựa trên các tài liệu bạn cung cấp,", "Theo tài liệu được cung cấp,"
 * - "Dựa trên kiến thức mở rộng ngoài khóa học:", "Dựa trên các nguồn bên ngoài tôi tìm được:"
 * - "Based on the sources provided,", "Based on the external sources I found,"
 */
export const PERFORMATIVE_SOURCE_FLUFF_REGEX = /(?:^|\r?\n+)\s*(?:(?:>\s*)*(?:💡\s*)?(?:\*{1,2}|_{1,2})?(?:dựa\s+(?:trên|vào)|căn\s+cứ\s+(?:vào|theo)|theo|chiếu\s+theo|từ)\s+(?:các\s+|những\s+)?(?:nguồn(?:\s+(?:tài\s+liệu|bên\s+ngoài))?|tài\s+liệu|dữ\s+liệu|thông\s+tin|giáo\s+trình|học\s+liệu|bài\s+giảng|kiến\s+thức(?:\s+mở\s+rộng)?|tri\s+thức(?:\s+mở\s+rộng)?)?\s*(?:(?:được|bạn|thầy\s+cô|giảng\s+viên|khóa\s+học|môn\s+học|ngoài\s+khóa\s+học|ngoài\s+giáo\s+trình|bên\s+ngoài|tôi\s+tìm\s+được)\s*)*(?:cung\s+cấp|đã\s+cho|cho\s+trước|có\s+sẵn|đính\s+kèm|chia\s+sẻ|nêu\s+trên|tham\s+khảo|mở\s+rộng)?[^a-zA-Z0-9\n\r\p{L}\p{N}]*(?:\*{1,2}|_{1,2})?[\s,.:;•\-—~]*\n*|(?:>\s*)*(?:\*{1,2}|_{1,2})?(?:based\s+on|according\s+to|from)\s+(?:the\s+)?(?:provided|given|attached|shared|external)?\s*(?:sources?|documents?|materials?|context|data)\s*(?:you\s+provided|provided|i\s+found|outside\s+the\s+course)?(?:\*{1,2}|_{1,2})?[\s,.:;•\-—~]*\n*)+/giu;

/**
 * Strips leading greetings, reasoning tags, CoT scratchpads, performative source banners, and trailing pleasantries.
 * Never outputs performative banners ("Based on...", "Dựa trên kiến thức mở rộng..."). Jumps straight to the answer.
 */
export function stripFluff(text: string): string {
  if (!text) return '';
  let cleaned = text.trim();

  // 1. Remove explicit <think>...</think> or <thought>...</thought> reasoning blocks
  cleaned = cleaned.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();
  if (cleaned.startsWith('<think>') || cleaned.startsWith('<thought>')) {
    const closeIdx = cleaned.indexOf('</');
    if (closeIdx !== -1) {
      const endTag = cleaned.indexOf('>', closeIdx);
      if (endTag !== -1) {
        cleaned = cleaned.slice(endTag + 1).trim();
      }
    }
  }

  // 2. Strip trailing word-count verification blocks (e.g. "Đếm: Java(1) SDK(2)...")
  cleaned = cleaned.replace(WORD_COUNT_VERIFICATION_REGEX, '').trim();

  // 3. Strip leading CoT scratchpad planning headers if present
  if (SCRATCHPAD_PREFIX_REGEX.test(cleaned)) {
    cleaned = cleaned.replace(SCRATCHPAD_PREFIX_REGEX, '').trim();
    // If model wrapped its response draft in quotes, unwrap them
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith('“') && cleaned.endsWith('”'))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }

  // 4. Strip word-index annotations if model leaked word counting inline like "Java(1) SDK(2)"
  cleaned = cleaned.replace(/(?<=\p{L})\(\d+\)/gu, '');

  // 5. Strip leading greeting phrases
  cleaned = cleaned.replace(LEADING_FLUFF_REGEX, '').trim();

  // 6. Anti-Fluff: Strip performative source filler & meta-announcements ("Based on...", "Dựa trên...")
  cleaned = cleaned.replace(PERFORMATIVE_SOURCE_FLUFF_REGEX, '\n\n').trim();

  // 7. Clean stray empty markdown artifacts (stray double asterisks, orphan blockquote markers)
  cleaned = cleaned
    .replace(/(?:\r?\n)\s*\*{2,}\s*(?:\r?\n)/g, '\n')
    .replace(/^\s*\*{2,}\s*$/gm, '')
    .replace(/(?:^|\n\n)\s*>\s*/g, '\n\n')
    .trim();

  // 8. Re-check leading fluff in case greeting was followed by source announcement or vice-versa
  if (LEADING_FLUFF_REGEX.test(cleaned) || PERFORMATIVE_SOURCE_FLUFF_REGEX.test(cleaned)) {
    cleaned = cleaned
      .replace(LEADING_FLUFF_REGEX, '')
      .replace(PERFORMATIVE_SOURCE_FLUFF_REGEX, '\n\n')
      .trim();
  }

  // 9. Strip trailing fluff if present
  cleaned = cleaned.replace(TRAILING_FLUFF_REGEX, '').trim();

  // 10. Clean up lazy template placeholders if emitted
  cleaned = cleaned.replace(PLACEHOLDER_REGEX, '').trim();

  // Capitalize first character if text was left lowercase after stripping prefix
  if (cleaned.length > 0 && !cleaned.startsWith('>') && !cleaned.startsWith('#') && !cleaned.startsWith('`')) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned;
}

/**
 * Checks if a generated response contains leaked internal scratchpads or word count loops.
 */
export function isPollutedResponse(text: string): boolean {
  if (!text) return false;
  return (
    /<(?:think|thought)>/i.test(text) ||
    WORD_COUNT_VERIFICATION_REGEX.test(text) ||
    SCRATCHPAD_PREFIX_REGEX.test(text) ||
    /(?<=\p{L})\(\d+\)/u.test(text)
  );
}

/**
 * Reusable system instruction block for strict Anti-Fluff, Anti-Placeholder & Zero-Shot Roleplay
 */
export const ANTI_FLUFF_SYSTEM_INSTRUCTION = `QUY TẮC ANTI-FLUFF, KHÔNG MÀU MÈ DIỄN GIẢI & TRẢ LỜI TRỰC DIỆN (BẮT BUỘC):
1. TRIỆT TIÊU VĂN MẪU, LỜI CHÀO & THÔNG BÁO NGUỒN (ANTI-FLUFF - TUYỆT ĐỐI KHÔNG PERFORMATIVE):
   - TUYỆT ĐỐI CẤM MỌI CÂU TỪ CHÀO HỎI VÀ XÃ GIAO ĐẦU CÂU: CẤM nói "Chào anh/chị", "Chào bạn", "Chào thầy/cô", "Kính chào", "Xin chào", "Dạ vâng", "Thưa bạn/thầy cô"... Kèm mọi icon chào mừng (🎓, 👋, 😊).
   - TUYỆT ĐỐI CẤM MỌI CÂU THÔNG BÁO NGUỒN SÁO RỖNG (CẤM TUYỆT ĐỐI: "Dựa trên tài liệu bạn cung cấp...", "Dựa trên kiến thức mở rộng ngoài khóa học...", "Dựa trên các nguồn bên ngoài tôi tìm được...", "Theo tài liệu...", "Based on the sources provided...", "Based on the external sources I found...").
   - ĐI THẲNG TRỰC TIẾP VÀO NỘI DUNG VẤN ĐỀ (Jump straight to the problem): Bắt đầu câu trả lời ngay từ từ đầu tiên bằng bản chất chuyên môn hoặc giải pháp. Nguồn tài liệu đã có hệ thống trích dẫn [1], [2] và huy hiệu nguồn tự động hiển thị ở chân trang. Tuyệt đối không tự thuyết minh nguồn.
   - TUYỆT ĐỐI CẤM VĂN MẪU KẾT BÀI THỪA: Cấm các câu như "Hy vọng thông tin này giúp ích...", "Hy vọng giáo án...", "Chúc bạn/thầy cô...", "Tóm lại,...", "Kết luận:...". Ngắt bài ngay khi hoàn thành nội dung trọng tâm.

2. ĐỊNH DẠNG CODE & THUẬT NGỮ CHUẨN MỰC:
   - Các thuật ngữ chuyên môn, thư viện, tên hàm, API, lệnh (như \`router.push\`, \`router.query\`, \`ReactJS\`, \`Next.js\`, \`useState\`) BẮT BUỘC đặt trong cặp backtick \`code\`. In đậm **từ khóa then chốt** để tăng tính trực quan.

3. CHẶN ĐỨNG TỪ NGỮ ĐIỀN KHUYẾT RẬP KHUÔN (ANTI-PLACEHOLDER):
   - TUYỆT ĐỐI KHÔNG xuất các thẻ placeholder giữ chỗ rập khuôn dạng: [Tên sinh viên], [Tên bạn], [Tên giảng viên], [Ngày/tháng], [Chèn ví dụ tại đây], [Nội dung...].
   - Tự động điền dữ liệu thực tế từ ngữ cảnh môn học đã có, hoặc diễn đạt thành câu văn tự nhiên, hoàn chỉnh 100% để người dùng có thể sử dụng được ngay mà không cần điền khuyết thủ công.

4. ZERO-SHOT ROLEPLAY (NHẬP VAI THỰC CHIẾN TỰ NHIÊN):
   - Nhập vai chuyên gia học thuật / giảng viên đại học thực tế, sâu sát với kiến thức ngành nghề và thực tiễn công nghệ.
   - Trả lời sống động, giàu hàm lượng tri thức thực tế, không lý thuyết suông hay máy móc rập khuôn sách vở.

5. TUYỆT ĐỐI KHÔNG XUẤT NHÁP & SUY NGHĨ NỘI TÂM (ZERO-LEAK CHAIN-OF-THOUGHT):
   - TUYỆT ĐỐI CẤM xuất các câu tự trò chuyện với bản thân, phân tích đề bài, hoặc suy nghĩ nội tâm (như "Người dùng hỏi...", "Yêu cầu:...", "Cần đảm bảo...", "Độ dài...", "Hãy đếm xấp xỉ...").
   - TUYỆT ĐỐI CẤM đếm từ hoặc đánh số thứ tự từ ngữ (như "Đếm: từ(1) từ(2)...").
   - Toàn bộ nội dung xuất ra PHẢI là câu trả lời trực tiếp cuối cùng dành cho người dùng.`;

