import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

interface AdvisorChatMessage {
  role: 'user' | 'ai';
  text: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      question?: string;
      history?: AdvisorChatMessage[];
      academicContext?: string;
      userId?: number;
    };

    const question = (body.question || '').trim();
    if (!question) {
      return NextResponse.json({ error: 'Vui lòng nhập câu hỏi cho Cố vấn AI.' }, { status: 400 });
    }

    const historyText = (body.history || [])
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'Sinh viên' : 'Cố vấn AI'}: ${m.text}`)
      .join('\n\n');

    const system = `Bạn là Cố vấn Học tập AI cá nhân hóa của hệ thống LMS Assistant.
Bạn nắm rõ toàn bộ bảng điểm trực tiếp từ Moodle LMS (GPA tổng, điểm từng môn, từng bài lab/bài tập/kiểm tra), điểm mạnh, điểm yếu, lịch sử điểm danh (vắng bao nhiêu buổi) và trạng thái nộp bài tập của sinh viên dưới đây.

DỮ LIỆU HỌC VỤ THỰC TẾ CỦA SINH VIÊN:
${body.academicContext || 'Chưa có dữ liệu đồng bộ.'}

NGUYÊN TẮC TƯ VẤN:
1. Trả lời trực diện, cá nhân hóa 100% dựa trên số liệu thật ở trên (nêu rõ tên môn học, mã môn, tên bài kiểm tra/bài tập, điểm số cụ thể, số buổi vắng điểm danh hoặc bài tập chưa nộp nếu có).
2. Khi sinh viên hỏi về điểm mạnh / điểm yếu / GPA mong muốn:
   - Chỉ rõ môn nào đang đạt điểm cao (Điểm mạnh), môn nào điểm thấp hoặc chưa có điểm / thiếu bài tập (Điểm yếu).
   - Tính toán cụ thể sinh viên cần cải thiện bao nhiêu điểm ở các môn yếu để đạt mức GPA mục tiêu.
   - Đề xuất lộ trình ôn tập từng bước rõ ràng, kết hợp các công cụ trên LMS Assistant (như Không gian học tập, 3 câu hỏi Quick Test, Mini-games: Nối cặp tốc độ, Bắt lỗi 1 chạm, Thẻ quẹt Đúng/Sai 30s, Sơ đồ tư duy, Flashcards).
3. Nếu sinh viên có môn vắng điểm danh >= 2 buổi hoặc có bài tập quá hạn chưa nộp, hãy nhắc nhở rõ ràng và hướng dẫn cách khắc phục ngay.
4. Trình bày bằng tiếng Việt rõ ràng, dùng Markdown (in đậm, danh sách bullet, bảng nếu cần), thân thiện và khích lệ như một người thầy/cố vấn sát cánh cùng sinh viên.`;

    const userPrompt = historyText
      ? `Lịch sử trò chuyện gần đây:\n${historyText}\n\nCâu hỏi mới của sinh viên: ${question}`
      : question;

    const result = await generateText(undefined, {
      system,
      userPrompt,
      userId: body.userId ? Number(body.userId) : undefined,
      taskCategory: 'complex',
      maxTokens: 2500,
      signal: request.signal,
    });

    if (!result.text) {
      return NextResponse.json({ error: 'Cố vấn AI chưa thể phản hồi lúc này.' }, { status: 502 });
    }

    return NextResponse.json({
      answer: result.text.trim(),
      model: result.modelId,
      provider: result.provider,
    });
  } catch (err) {
    if (request.signal.aborted) throw err;
    console.error('[dashboard/advisor] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Không thể kết nối Cố vấn AI.' },
      { status: 500 }
    );
  }
}
