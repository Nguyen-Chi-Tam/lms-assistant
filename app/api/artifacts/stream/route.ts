import { generateTextStream, type AIProvider } from '@/models/registry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type ToolType = 'summary' | 'flashcards' | 'mindmap' | 'slides';
type Level = 'simple' | 'standard' | 'complex';

const GROQ_70B = 'llama-3.3-70b-versatile';

interface ToolConfig {
  taskCategory: 'basic' | 'complex';
  allowedProviders: AIProvider[];
  groqModel?: string;
  jsonMode: boolean;
  maxTokens: number;
  temperature: number;
  system: string;
}

const CONTENT_RULES = `Hãy trả ngay kết quả cuối cùng bằng tiếng Việt. Tài liệu có thể tiếng Anh nhưng câu trả lời vẫn là tiếng Việt.
Không bàn về yêu cầu, không phân tích câu lệnh, không giải thích bạn đang làm gì. Không viết lại câu lệnh, nhãn hay đoạn tài liệu thô. Không dịch word by word; hãy tự tổng hợp.`;

/** Bóc các nhiễu thường gặp trong ngữ cảnh RAG trước khi đưa vào prompt. */
function sanitizeContext(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[Trang\s*\d+\]/gi, '')
    .replace(/Bản dịch từ[^\n]*/gi, '')
    .replace(/NGỮ CẢNH TÀI LIỆU ĐÃ CHUẨN BỊ:?/gi, '')
    .replace(/CHỦ ĐỀ:?[^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Một số model reasoning phát suy nghĩ ra ngoài <think>; lọc trước khi đẩy SSE. */
function createStreamFilter(emit: (text: string) => void) {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let buffer = '';
  let insideThink = false;

  return {
    push(delta: string) {
      buffer += delta;
      while (true) {
        if (insideThink) {
          const end = buffer.indexOf(CLOSE);
          if (end === -1) {
            buffer = '';
            return;
          }
          buffer = buffer.slice(end + CLOSE.length);
          insideThink = false;
          continue;
        }
        const start = buffer.indexOf(OPEN);
        if (start === -1) {
          const keep = Math.min(buffer.length, OPEN.length - 1);
          const out = buffer.slice(0, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          if (out) emit(out);
          return;
        }
        const out = buffer.slice(0, start);
        if (out) emit(out);
        buffer = buffer.slice(start + OPEN.length);
        insideThink = true;
      }
    },
    flush() {
      if (!insideThink && buffer) emit(buffer);
      buffer = '';
    },
  };
}

function buildConfig(
  tool: ToolType,
  level: Level,
  ragMode: 'strict' | 'hybrid' | 'creative',
  phase: 'outline' | 'detail',
  topic: string,
  outline: string,
  retryStrict: boolean
): ToolConfig {
  const temperature = ragMode === 'strict' ? 0.1 : ragMode === 'hybrid' ? 0.3 : 0.7;

  switch (tool) {
    case 'summary':
      return {
        taskCategory: 'basic',
        allowedProviders: ['groq', 'gemini', 'openrouter', 'orcarouter', 'aionlabs', 'cloudflare', 'airforce'],
        groqModel: GROQ_70B,
        jsonMode: true,
        maxTokens: level === 'simple' ? 900 : level === 'complex' ? 3000 : 1800,
        temperature,
        system: `Bạn là giảng viên đại học. Hãy viết bản tóm tắt học thuật bằng tiếng Việt.
Trả về DUY NHẤT một JSON object hợp lệ theo chính xác schema này: {"overview":"một đoạn tổng quan ngắn","paragraphs":["đoạn nội dung 1","đoạn nội dung 2","đoạn nội dung 3","đoạn nội dung 4"]}.
Không thêm khóa nào khác, không thêm văn bản ngoài JSON, không bọc Markdown. Mảng paragraphs có từ bốn đến sáu đoạn văn hoàn chỉnh. Một đoạn bắt đầu bằng "Thực tiễn triển khai và lưu ý nâng cao" và nêu ví dụ thực tế cùng so sánh ưu, nhược điểm.
${retryStrict ? 'Dùng đúng bốn đoạn trong mảng paragraphs.' : 'Dùng từ bốn đến sáu đoạn trong mảng paragraphs.'}
Không viết bản nháp, suy nghĩ thành tiếng hoặc chỉ dẫn hệ thống. ${CONTENT_RULES}`,
      };

    case 'flashcards':
      return {
        taskCategory: 'basic',
        allowedProviders: ['groq', 'gemini', 'openrouter', 'orcarouter', 'cloudflare', 'airforce'],
        jsonMode: true,
        maxTokens: level === 'simple' ? 1600 : 2800,
        temperature,
        system: `Tạo bộ flashcard. Trả về DUY NHẤT một mảng JSON phẳng 1 cấp, không object bọc ngoài:\n[{"q":"câu hỏi","a":"đáp án ngắn","tag":"chủ đề"}]\nKhông markdown, không giải thích. ${CONTENT_RULES}`,
      };

    case 'mindmap':
      return {
        taskCategory: 'complex',
        allowedProviders: ['gemini', 'openrouter', 'groq', 'orcarouter', 'pollinations'],
        groqModel: GROQ_70B,
        jsonMode: false,
        maxTokens: level === 'complex' ? 4000 : 2800,
        temperature,
        system: `Biểu diễn kiến thức bằng văn bản thuần có thụt lề để client dựng cây Mindmap.
Dòng đầu tiên đúng là MAP_START, dòng cuối cùng đúng là MAP_END. Chỉ trả nội dung nằm giữa hai nhãn này.
Trong đó, dòng đầu không thụt lề là tên chủ đề gốc. Mỗi cấp sâu hơn thụt thêm đúng hai dấu cách. Mỗi dòng là một node, tối đa bốn cấp. Không dùng dấu thăng, dấu sao, dấu gạch đầu dòng hay JSON. Không viết bản nháp hay suy nghĩ thành tiếng. ${CONTENT_RULES}`,
      };

    case 'slides': {
      const layoutGuide = `LAYOUTS HỢP LỆ (chọn đa dạng, không lặp quá 2 slide liên tiếp):
- "bullets": { "bullets": ["..."] } (không cần visual)
- "comparison": visual = { "leftLabel": "...", "leftPoints": ["..."], "rightLabel": "...", "rightPoints": ["..."] }
- "timeline" hoặc "process": visual = { "steps": [{ "label": "Bước/Mốc", "description": "Mô tả ngắn" }] }
- "stat": visual = { "value": "Con số/Kết luận nổi bật", "context": "Bối cảnh ngắn" }
- "quote": visual = { "quote": "Định nghĩa/Phát biểu cốt lõi", "author": "Nguồn/Tác giả" }
- "cards": visual = { "cards": [{ "title": "...", "description": "..." }] } (2-4 thẻ)
- "quadrant": visual = { "quadrants": [{ "title": "...", "description": "..." }] } (4 góc phần tư 2x2)`;

      if (level === 'simple') {
        return phase === 'outline'
          ? {
              taskCategory: 'basic',
              allowedProviders: ['groq', 'gemini', 'openrouter', 'orcarouter', 'cloudflare', 'airforce'],
              groqModel: GROQ_70B,
              jsonMode: true,
              maxTokens: 700,
              temperature: 0.1,
              system: `PHA 1 — DÀN Ý SLIDE CƠ BẢN (TIẾT KIỆM TOKEN). Trả về DUY NHẤT JSON: {"slides":[{"title":"Tiêu đề slide 1","layout":"bullets"},{"title":"Tiêu đề slide 2","layout":"bullets"},...]}. BẮT BUỘC tạo từ 5 đến 6 phần tử trong mảng "slides". Chỉ ghi title và layout, không viết bullets hay nội dung chi tiết. ${CONTENT_RULES}`,
            }
          : {
              taskCategory: 'basic',
              allowedProviders: ['groq', 'gemini', 'openrouter', 'orcarouter', 'cloudflare', 'airforce'],
              groqModel: GROQ_70B,
              jsonMode: true,
              maxTokens: 1600,
              temperature: 0.2,
              system: `PHA 2 — CHI TIẾT SLIDE CƠ BẢN (TIẾT KIỆM TOKEN). Dựa vào dàn ý:\n${outline || ''}\n\nTrả về DUY NHẤT JSON với ĐÚNG số lượng slide trong dàn ý:\n{"slides":[{"title":"...","bullets":["ý 1","ý 2","ý 3"],"keyTakeaway":"1 câu cốt lõi","notes":"1 câu ghi chú ngắn","layout":"bullets"}]}. Giữ ngắn gọn, súc tích để tiết kiệm token. ${CONTENT_RULES}`,
            };
      }

      if (level === 'complex') {
        return phase === 'outline'
          ? {
              taskCategory: 'complex',
              allowedProviders: ['groq', 'gemini', 'openrouter', 'orcarouter'],
              groqModel: GROQ_70B,
              jsonMode: true,
              maxTokens: 1600,
              temperature: 0.2,
              system: `PHA 1 — DÀN Ý SLIDE CHUYÊN SÂU. Trả về DUY NHẤT JSON:\n{"slides":[{"title":"Slide 1: ...","layout":"quote"},{"title":"Slide 2: ...","layout":"cards"},... (tổng 15 đến 18 phần tử)]}\nBẮT BUỘC mảng "slides" phải có ÍT NHẤT 15 phần tử (15-18 slide) bao phủ toàn diện từ nền tảng, nguyên lý, cơ chế, so sánh, ví dụ thực tế đến tổng kết. Đa dạng hóa "layout" (bullets, comparison, timeline, process, stat, quote, cards, quadrant — không lặp cùng layout quá 2 slide liên tiếp). Chỉ ghi "title" và "layout", không viết bullets để tối ưu tốc độ. ${CONTENT_RULES}`,
            }
          : {
              taskCategory: 'complex',
              allowedProviders: ['gemini', 'openrouter', 'groq', 'orcarouter'],
              groqModel: GROQ_70B,
              jsonMode: true,
              maxTokens: 4200,
              temperature,
              system: `PHA 2 — CHI TIẾT SLIDE CHUYÊN SÂU THEO LÔ. Dựa vào dàn ý:\n${outline || ''}\n\n${layoutGuide}\n\nHãy viết nội dung chuyên sâu cho TẤT CẢ các slide trong lô được yêu cầu (giữ nguyên số lượng và thứ tự, giữ đúng layout đã phân công và điền đầy đủ "visual" khớp với layout đó).\nTrả về DUY NHẤT JSON: {"slides":[{"title":"...","subtitle":"ngữ cảnh ngắn","layout":"...","bullets":["ý 1","ý 2","ý 3"],"visual":{...},"keyTakeaway":"đúc kết chuyên sâu","notes":"lời giảng 2-3 câu giàu chiều sâu thực tiễn"}]}. ${CONTENT_RULES}`,
            };
      }

      // standard: shorter slide count (7-9) with variable layouts
      return phase === 'outline'
        ? {
            taskCategory: 'complex',
            allowedProviders: ['groq', 'gemini', 'openrouter', 'orcarouter'],
            groqModel: GROQ_70B,
            jsonMode: true,
            maxTokens: 1000,
            temperature: 0.15,
            system: `PHA 1 — DÀN Ý SLIDE TIÊU CHUẨN. Trả về DUY NHẤT JSON: {"slides":[{"title":"Slide 1: ...","layout":"stat"},{"title":"Slide 2: ...","layout":"cards"},... (tổng 7 đến 9 phần tử)]}. BẮT BUỘC mảng "slides" có 7 đến 9 phần tử, phân bổ đa dạng layout (bullets, comparison, timeline, process, stat, quote, cards, quadrant — không lặp cùng layout quá 2 slide liên tiếp). Chỉ ghi "title" và "layout". ${CONTENT_RULES}`,
          }
        : {
            taskCategory: 'complex',
            allowedProviders: ['gemini', 'openrouter', 'groq', 'orcarouter'],
            groqModel: GROQ_70B,
            jsonMode: true,
            maxTokens: 3200,
            temperature,
            system: `PHA 2 — CHI TIẾT SLIDE TIÊU CHUẨN THEO LÔ. Dựa vào dàn ý:\n${outline || ''}\n\n${layoutGuide}\n\nViết đầy đủ nội dung cho TẤT CẢ các slide trong lô được yêu cầu với layout đa dạng và trường "visual" khớp layout.\nTrả về DUY NHẤT JSON: {"slides":[{"title":"...","subtitle":"ngữ cảnh ngắn","layout":"...","bullets":["..."],"visual":{...},"keyTakeaway":"điểm cốt lõi","notes":"ghi chú thuyết trình 2-3 câu"}]}. ${CONTENT_RULES}`,
          };
    }
  }
}

export async function POST(request: Request) {
  let body: {
    type?: ToolType;
    level?: Level;
    ragMode?: 'strict' | 'hybrid' | 'creative';
    topic?: string;
    preparedContext?: string;
    guidance?: string;
    phase?: 'outline' | 'detail';
    outline?: string;
    batch?: string;
    model?: string;
    strictModel?: boolean;
    userId?: number;
    /** Chỉ truyền khi người dùng yêu cầu rõ ngôn ngữ khác tiếng Việt. */
    languageHint?: string;
    /** Prompt rút gọn khi phát hiện model đang lặp lại câu lệnh. */
    retryStrict?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const tool = body.type || 'summary';
  if (!['summary', 'flashcards', 'mindmap', 'slides'].includes(tool)) {
    return Response.json({ error: `Unsupported artifact type: ${tool}` }, { status: 400 });
  }

  const topic = body.topic?.trim() || 'Nội dung học tập';
  const preparedContext = body.preparedContext?.trim();
  if (!preparedContext) {
    return Response.json(
      { error: 'Thiếu preparedContext. Hãy gọi POST /api/artifacts/context trước.' },
      { status: 400 }
    );
  }

  const config = buildConfig(
    tool,
    body.level || 'standard',
    body.ragMode || 'hybrid',
    body.phase === 'detail' ? 'detail' : 'outline',
    topic,
    body.outline || '',
    body.retryStrict === true
  );

  const cleanContext = sanitizeContext(preparedContext);
  const userPrompt = `${body.batch ? `NHIỆM VỤ HIỆN TẠI: ${body.batch}\n\n` : ''}CHỦ ĐỀ: ${topic}\n\nNGỮ CẢNH TÀI LIỆU ĐÃ CHUẨN BỊ:\n${cleanContext}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        const timeout = AbortSignal.timeout(55_000);
        const signal = AbortSignal.any([request.signal, timeout]);
        let metaSent = false;
        let textChars = 0;
        const filter = createStreamFilter(text => {
          textChars += text.length;
          send({ type: 'delta', text });
        });

        await generateTextStream(body.model || undefined, {
          ...config,
          userPrompt,
          userId: body.userId ? Number(body.userId) : undefined,
          strictModel: Boolean(body.strictModel) && Boolean(body.model && body.model !== 'auto'),
          signal,
          ragMode: body.ragMode || 'hybrid',
          // Mặc định tiếng Việt; chỉ đổi khi người dùng yêu cầu rõ ngôn ngữ khác.
          languageHint: body.languageHint || 'tiếng Việt',
          onMeta: meta => {
            if (metaSent) return;
            metaSent = true;
            send({
              type: 'meta',
              provider: meta.provider,
              modelId: meta.modelId,
              modelName: meta.modelName,
              keySource: meta.keySource,
            });
          },
          onDelta: delta => {
            if (delta) filter.push(delta);
          },
        });

        filter.flush();
        send({ type: 'done', textChars });
      } catch (error) {
        if (!request.signal.aborted) {
          console.error('[artifacts/stream] failed:', error);
          send({
            type: 'error',
            message: error instanceof Error ? error.message : 'Không thể sinh nội dung.',
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
