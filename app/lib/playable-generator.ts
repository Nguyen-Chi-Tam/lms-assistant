// app/lib/playable-generator.ts

import { PlayableType } from './playable-limit';
import type { CourseSourceItem } from '@/app/types';
import { isPuterSignedIn } from '@/app/lib/puter-client';

export function buildMaterialContext(sources?: CourseSourceItem[], maxLen = 6000): string {
  if (!sources || sources.length === 0) return '';
  const parts: string[] = [];
  for (const s of sources) {
    if (s.content && s.content.trim()) {
      parts.push(`[Tài liệu: ${s.name}]\n${s.content.trim()}`);
    } else {
      parts.push(`[Tài liệu: ${s.name} (${s.type})]`);
    }
  }
  return parts.join('\n\n').slice(0, maxLen);
}

// Bóc tách JSON an toàn kể cả khi LLM bọc trong ```json ... ``` hoặc thêm lời dẫn
export function parseAIJson<T>(rawResponse: unknown): T {
  const text =
    typeof rawResponse === 'string'
      ? rawResponse
      : (rawResponse as { message?: { content?: string } })?.message?.content ??
        String(rawResponse);

  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const firstBracket = Math.min(
    cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{'),
    cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[')
  );
  const lastBracket = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));

  if (firstBracket === Infinity || lastBracket === -1) {
    throw new Error('AI không trả về định dạng JSON hợp lệ.');
  }
  return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1)) as T;
}

export function buildSpotTheBugPrompt(courseName: string, materialContext: string): string {
  return `
Bạn là chuyên gia thiết kế câu hỏi ôn tập cho môn "${courseName}".
Dựa vào tài liệu bên dưới, hãy tạo 5 thử thách "Tìm điểm sai & Sửa chuẩn" (Spot the Error).

QUY TẮC THÍCH NGHI CHUYÊN NGÀNH:
- Nếu tài liệu thuộc lĩnh vực Lập trình / Kỹ thuật phần mềm: Tạo đoạn code ngắn (4-6 dòng/khối) chứa 1 lỗi cú pháp, kiểu dữ liệu hoặc logic thực tế.
- Nếu tài liệu thuộc các ngành khác (Kinh tế, Luật, Ngoại ngữ, Khoa học, Xã hội...): Trích xuất 1 định nghĩa, quy luật, điều khoản hoặc quy trình gồm 4-6 mệnh đề, sau đó cố tình làm sai lệch DUY NHẤT 1 chi tiết quan trọng (sai con số, ngược chiều tác động, sai thuật ngữ, sai ngữ pháp).

RÀNG BUỘC BẮT BUỘC VỀ CẤU TRÚC:
1. Chia câu/đoạn mã thành mảng "tokens" gồm 4 đến 6 phần tử có độ dài cân đối để hiển thị thành các khối bấm ngang.
2. Chỉ có DUY NHẤT 1 phần tử tại vị trí "bugIndex" (tính từ 0) chứa lỗi; các phần tử còn lại phải hoàn toàn chính xác.
3. Phương án tại "fixOptions[correctFixIndex]" PHẢI sửa trực tiếp và triệt để đúng lỗi nằm trong "tokens[bugIndex]", không được sửa sang ý khác.
4. Trả về thuần JSON theo đúng định dạng sau, không kèm markdown:

{
  "challenges": [
    {
      "prompt": "Câu dẫn ngắn gọn (VD: Tìm mệnh đề sai trong nguyên lý sau / Tìm lỗi trong đoạn mã...)",
      "tokens": ["Khối 1", "Khối 2", "Khối 3", "Khối 4"],
      "bugIndex": 1,
      "fixOptions": [
        "Phương án sửa 1",
        "Phương án sửa 2",
        "Phương án sửa 3"
      ],
      "correctFixIndex": 0,
      "explanation": "Giải thích ngắn gọn 1-2 câu tại sao khối đó sai và cách sửa đúng."
    }
  ]
}

TÀI LIỆU MÔN HỌC:
${materialContext.slice(0, 6000)}
`;
}

export function buildPromptByType(
  type: PlayableType,
  courseName: string,
  context: string
): string {
  const baseHeader = `Bạn là chuyên gia thiết kế trò chơi học thuật cho môn "${courseName}". Dựa vào tài liệu dưới đây, hãy tạo dữ liệu trò chơi bằng tiếng Việt (giữ nguyên thuật ngữ chuyên ngành tiếng Anh nếu cần).\nTÀI LIỆU:\n${context || `Môn học: ${courseName}`}\n\nYÊU CẦU BẮT BUỘC: Chỉ trả về duy nhất 1 object JSON hợp lệ, không markdown, không giải thích thêm.\n`;

  switch (type) {
    case 'quiz':
      return `${baseHeader}
Tạo đúng 3 câu hỏi trắc nghiệm kiểm tra nhanh kiến thức trọng tâm (check-in trước khi học) cho môn ${courseName}. Mỗi câu có 4 phương án lựa chọn và 1 đáp án đúng (hoặc dạng Đúng/Sai).

QUY TẮC CHỐNG CÂU HỎI CHUNG CHUNG:
- Mỗi câu hỏi phải kiểm tra một chi tiết cụ thể trong tài liệu: thuật ngữ, định nghĩa, công nghệ, quy trình, ví dụ, đoạn mã, con số hoặc mối quan hệ giữa các khái niệm.
- Không tạo câu hỏi về phương pháp học, mục tiêu học tập, ôn bài, xem điểm, "nên làm gì trước", hoặc lời khuyên chung chung.
- Không dùng các câu hỏi có thể áp dụng nguyên xi cho mọi môn học.
- Nếu không tìm thấy đủ dữ kiện cụ thể trong tài liệu, hãy tạo ít câu hơn thay vì bịa hoặc dùng kiến thức chung.
- PHÂN LOẠI THEO DẤU CÂU: mọi câu "multiple_choice" BẮT BUỘC kết thúc bằng dấu "?" và có đúng 4 lựa chọn A/B/C/D.
- Mọi câu "true_false" BẮT BUỘC là mệnh đề khẳng định hoàn chỉnh KHÔNG có dấu "?" (ví dụ: "MVC tách Model, View và Controller thành các thành phần độc lập."), tuyệt đối không hỏi "Câu nào/Điều nào..."; "choices" luôn là ["Đúng", "Sai"].

Schema JSON:
{
  "questions": [
    {
      "q": "Nội dung câu hỏi ngắn gọn?",
      "type": "multiple_choice",
      "choices": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "answer": 0,
      "explanation": "Giải thích ngắn gọn 1-2 câu vì sao đáp án này đúng."
    }
  ]
}`;

    case 'mystery_concept':
      return `${baseHeader}
Chọn DUY NHẤT 1 đối tượng kiến thức cốt lõi trong tài liệu (khái niệm, thuật toán, giao thức, học thuyết, quy định, cấu trúc hoặc hiện tượng) làm đáp án bí mật.
QUY TẮC BẮT BUỘC:
1. "vagueQuestion": 1 câu hỏi mở đầu thật mơ hồ, mang tính đố vui để khơi gợi tò mò, tuyệt đối không lộ tên hay từ khóa đặc trưng.
2. "clues": ĐÚNG 10 gợi ý, mỗi gợi ý 1 câu ngắn, sắp xếp tăng dần độ rõ ràng: gợi ý 1-3 rất mơ hồ (bối cảnh, vai trò chung, lĩnh vực áp dụng); gợi ý 4-7 thu hẹp dần (đặc điểm hoạt động, cấu trúc, khác biệt với khái niệm tương tự); gợi ý 8-10 rất sát đáp án (tình huống sử dụng điển hình, dấu hiệu nhận biết đặc thù nhất).
3. TUYỆT ĐỐI KHÔNG chứa từ khóa đáp án hoặc từ viết tắt của nó trong "vagueQuestion" và cả 10 "clues".
4. "target" ngắn gọn 1-4 từ (tối đa 30 ký tự). "acceptedAnswers" liệt kê đầy đủ biến thể viết thường, viết tắt hoặc thuật ngữ tương đương.
Schema JSON:
{
  "vagueQuestion": "Câu hỏi mở đầu thật mơ hồ...",
  "target": "Tên đáp án chuẩn",
  "acceptedAnswers": ["ten viet thuong", "ten viet tat hoac dong nghia"],
  "category": "Nhóm chủ đề ngắn gọn (VD: Cơ sở dữ liệu, Kinh tế vi mô, Luật dân sự)",
  "clues": ["Gợi ý 1 (mơ hồ nhất)", "Gợi ý 2", "Gợi ý 3", "Gợi ý 4", "Gợi ý 5", "Gợi ý 6", "Gợi ý 7", "Gợi ý 8", "Gợi ý 9", "Gợi ý 10 (sát đáp án nhất)"],
  "explanation": "Giải thích súc tích 1-2 câu tổng kết khái niệm này."
}`;

    case 'speed_matching':
      return `${baseHeader}
Tạo đúng 8 cặp thuật ngữ - định nghĩa ngắn gọn để chơi nối cặp tốc độ 45 giây.
QUY TẮC BẮT BUỘC:
- Mỗi thuật ngữ xuất hiện đúng 1 lần và chỉ có DUY NHẤT 1 định nghĩa đúng trong bộ 8 cặp.
- Định nghĩa phải nêu đặc điểm phân biệt riêng của thuật ngữ đó; tuyệt đối không dùng mô tả chung chung có thể đúng với nhiều thuật ngữ khác trong cùng bộ (ví dụ tránh "khung MVC cho ứng dụng web", "thư viện xây dựng UI", "framework phổ biến").
- Không chọn hai thuật ngữ đồng nghĩa, gần nghĩa hoặc có định nghĩa chồng lấn.
- Ưu tiên thuật ngữ và chi tiết xuất hiện trực tiếp trong tài liệu.
- Vế phải tối đa 10 từ, giữ nguyên tên riêng tiếng Anh của thuật ngữ.
Schema JSON:
{
  "pairs": [
    { "id": "1", "left": "Thuật ngữ / Hàm", "right": "Định nghĩa riêng biệt <= 10 từ" }
  ]
}`;

    case 'spot_the_bug':
      return buildSpotTheBugPrompt(courseName, context);

    case 'rapid_swipe':
      return `${baseHeader}
Tạo 12 mệnh đề nhận định ngắn (1 câu/mệnh đề) để chơi quẹt Đúng/Sai trong 30 giây. Tỷ lệ 6 câu đúng, 6 câu sai.
Schema JSON:
{
  "cards": [
    {
      "id": "1",
      "statement": "Mệnh đề nhận định ngắn gọn",
      "isTrue": true,
      "explanation": "Giải thích ngắn gọn."
    }
  ]
}`;

    case 'crossword':
      return `${baseHeader}
Tạo 12 từ khóa quan trọng trong tài liệu để xếp ô chữ (hệ thống sẽ chọn ngẫu nhiên một phần). Từ khóa BẮT BUỘC viết IN HOA, liền không dấu, không khoảng trắng, không ký tự đặc biệt, độ dài 4-12 ký tự.
Schema JSON:
{
  "words": [
    { "word": "CAPACITOR", "clue": "Gợi ý định nghĩa ngắn gọn" }
  ]
}`;

    case 'concept_bingo':
      return `${baseHeader}
Tạo bàn chơi Bingo phân loại gồm đúng 12 nhóm tiêu chí (categories) riêng biệt và 15 thẻ khái niệm/ví dụ (cards) thuộc về các nhóm đó (12 thẻ khớp 12 ô + 3 thẻ dự phòng khi người chơi bấm Skip).
Schema JSON:
{
  "categories": [
    { "id": "c1", "label": "Tên nhóm tiêu chí ngắn" }
  ],
  "cards": [
    {
      "id": "k1",
      "term": "Tên khái niệm / ví dụ",
      "validCategoryIds": ["c1"],
      "explanation": "Giải thích ngắn vì sao thuộc nhóm này."
    }
  ]
}`;
  }
}

const inFlightPlayables = new Map<string, Promise<unknown>>();

export async function generatePlayableData<T>(
  type: PlayableType,
  courseName: string,
  materialContext: string,
  userId?: number
): Promise<T> {
  const context = (materialContext || '').slice(0, 6000);
  const dedupeKey = `${type}::${courseName}::${userId ?? 'anon'}::${context.length}`;
  const existing = inFlightPlayables.get(dedupeKey);
  if (existing) {
    return existing as Promise<T>;
  }

  const task = (async (): Promise<T> => {
    const prompt = buildPromptByType(type, courseName, context);

    // Only query Puter client-side if the user is ALREADY signed into Puter.
    // Otherwise, skip calling window.puter.ai.chat to avoid triggering unwanted sign-in popups.
    if (typeof window !== 'undefined' && window.puter?.ai?.chat && isPuterSignedIn()) {
      try {
        const response = await window.puter.ai.chat(prompt, { model: 'gpt-4o-mini' });
        return parseAIJson<T>(response);
      } catch {
        // fallback
      }
    }

    // Fallback via server API if Puter fails or is not available
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          mode: 'concise',
          taskCategory: 'playable',
          userId,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { reply?: string; text?: string; message?: { content?: string } };
        const content = data.reply || data.text || data.message?.content || JSON.stringify(data);
        return parseAIJson<T>(content);
      }
    } catch {
      // fallback to static defaults
    }

    throw new Error('Không thể kết nối đến mô hình để sinh dữ liệu trò chơi.');
  })();

  inFlightPlayables.set(dedupeKey, task);
  try {
    return await task;
  } finally {
    inFlightPlayables.delete(dedupeKey);
  }
}
