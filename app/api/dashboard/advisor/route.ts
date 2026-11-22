import { NextResponse } from 'next/server';
import { generateText, generateTextStream } from '@/models/registry';
import { isPuterModelSelector, parsePuterModelSelector } from '@/app/lib/puter-models';

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
      model?: string;
      stream?: boolean;
    };

    const question = (body.question || '').trim();
    if (!question) {
      return NextResponse.json({ error: 'Vui lòng nhập câu hỏi cho AI Helper.' }, { status: 400 });
    }

    const selectedModel = body.model && body.model !== 'auto' ? body.model : undefined;
    const history = (body.history || []).slice(-8).map(m => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text,
    }));

    const system = `Bạn là AI Helper của hệ thống LMS Assistant.
Bạn nắm rõ toàn bộ bảng điểm trực tiếp từ Moodle LMS (điểm trung bình các môn, điểm từng bài lab/bài tập/kiểm tra), điểm mạnh, điểm yếu, lịch sử điểm danh và trạng thái nộp bài tập của sinh viên dưới đây.

DỮ LIỆU HỌC VỤ THỰC TẾ CỦA SINH VIÊN:
${body.academicContext || 'Chưa có dữ liệu đồng bộ.'}

NGUYÊN TẮC TRẢ LỜI:
1. ĐI THẲNG VÀO VẤN ĐỀ. Không chào hỏi rườm rà, không mở bài dài dòng, trả lời trực diện ngay từ câu đầu tiên.
2. Dựa 100% trên số liệu thật ở trên (nêu rõ tên môn học, mã môn, tên bài kiểm tra/bài tập, điểm số cụ thể, số buổi vắng hoặc bài tập chưa nộp nếu có). Không bịa số liệu. Không dùng thuật ngữ "GPA" — gọi là "điểm trung bình" hoặc "điểm LMS".
3. Khi sinh viên hỏi về điểm mạnh / điểm yếu / điểm mục tiêu:
   - Chỉ rõ môn đạt điểm cao và môn thấp/thiếu bài.
   - Tính cụ thể cần tăng bao nhiêu điểm ở môn nào để đạt điểm mục tiêu.
   - Đề xuất bước hành động cụ thể, ngắn gọn.
4. Nếu có môn vắng >= 2 buổi hoặc bài tập quá hạn chưa nộp, nhắc ngắn gọn và nêu cách xử lý.
5. Dùng Markdown rõ ràng (in đậm, bullet, bảng khi cần), trả lời cùng ngôn ngữ với câu hỏi của sinh viên.`;

    // Puter.js models run directly in the browser — return the prepared prompt payload.
    if (selectedModel && isPuterModelSelector(selectedModel)) {
      const modelId = parsePuterModelSelector(selectedModel);
      if (!modelId) {
        return NextResponse.json({ error: 'Model Puter không hợp lệ.' }, { status: 400 });
      }
      const historyText = history
        .map(m => `${m.role === 'user' ? 'Sinh viên' : 'AI Helper'}: ${m.content}`)
        .join('\n\n');
      const userPrompt = historyText
        ? `Lịch sử gần đây:\n${historyText}\n\nCâu hỏi: ${question}`
        : question;

      return NextResponse.json({
        puterJob: {
          modelId,
          system,
          userPrompt,
        },
      });
    }

    const commonOpts = {
      system,
      userPrompt: question,
      history,
      userId: body.userId ? Number(body.userId) : undefined,
      strictModel: Boolean(selectedModel),
      taskCategory: 'quick' as const,
      temperature: 0.3,
      maxTokens: 1400,
      signal: request.signal,
    };

    // Streaming SSE mode (matches course chat window)
    if (body.stream !== false) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          const send = (payload: Record<string, unknown>) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            } catch {
              // stream closed
            }
          };

          try {
            const result = await generateTextStream(selectedModel, {
              ...commonOpts,
              onDelta: delta => {
                send({ delta });
              },
            });

            if (!result.text) {
              send({ error: 'AI Helper chưa thể phản hồi lúc này.' });
            } else {
              send({
                done: true,
                model: result.modelId,
                provider: result.provider,
                finishReason: result.finishReason,
              });
            }
          } catch (err) {
            if (!request.signal.aborted) {
              send({
                error: err instanceof Error ? err.message : 'Không thể kết nối AI Helper.',
              });
            }
          } finally {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    const result = await generateText(selectedModel, commonOpts);

    if (!result.text) {
      return NextResponse.json({ error: 'AI Helper chưa thể phản hồi lúc này.' }, { status: 502 });
    }

    return NextResponse.json({
      answer: result.text.trim(),
      model: result.modelId,
      provider: result.provider,
      finishReason: result.finishReason,
    });
  } catch (err) {
    if (request.signal.aborted) throw err;
    console.error('[dashboard/advisor] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Không thể kết nối AI Helper.' },
      { status: 500 }
    );
  }
}
