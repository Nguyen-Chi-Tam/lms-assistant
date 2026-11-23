import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';
import type { SlideLayoutKind } from '@/lib/export/pptx-export';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const VALID_LAYOUTS: SlideLayoutKind[] = [
  'bullets',
  'comparison',
  'timeline',
  'process',
  'stat',
  'quote',
  'cards',
  'quadrant',
];

export interface SlideOutlineItem {
  index: number;
  title: string;
  layout: SlideLayoutKind;
  keyFocus: string;
}

function parseOutlinesLoose(text: string): SlideOutlineItem[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const tryParse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  let parsed = tryParse(cleaned);
  if (!parsed) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      parsed = tryParse(cleaned.slice(first, last + 1).replace(/,\s*([}\]])/g, '$1'));
    }
  }

  let rawItems: Array<Record<string, unknown>> = [];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.outlines)) rawItems = obj.outlines;
    else if (Array.isArray(obj.slides)) rawItems = obj.slides;
  } else if (Array.isArray(parsed)) {
    rawItems = parsed as Array<Record<string, unknown>>;
  }

  // Rescue complete objects from truncated array
  if (rawItems.length === 0) {
    const arrStart = cleaned.indexOf('[');
    if (arrStart >= 0) {
      let depth = 0;
      let objStart = -1;
      let inStr = false;
      let esc = false;
      for (let i = arrStart + 1; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') {
          if (depth === 0) objStart = i;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0 && objStart >= 0) {
            const obj = tryParse(cleaned.slice(objStart, i + 1));
            if (obj && typeof obj === 'object') rawItems.push(obj as Record<string, unknown>);
            objStart = -1;
          }
        }
      }
    }
  }

  return rawItems
    .filter(item => item && typeof item.title === 'string' && item.title.trim())
    .map((item, i) => {
      const rawLayout = String(item.layout || 'bullets').toLowerCase() as SlideLayoutKind;
      const layout = VALID_LAYOUTS.includes(rawLayout) ? rawLayout : 'bullets';
      return {
        index: Number(item.index) || i + 1,
        title: String(item.title).trim(),
        layout,
        keyFocus: String(item.keyFocus || item.subtitle || item.title).trim(),
      };
    });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      contextText?: string;
      topic?: string;
      complexity?: 'simple' | 'standard' | 'complex';
      ragMode?: 'strict' | 'hybrid' | 'creative';
      model?: string;
      strictModel?: boolean;
      userId?: number;
      languageHint?: string;
    };

    const topic = body.topic?.trim() || 'Nội dung học tập';
    const complexity = body.complexity || 'standard';
    const contextText = (body.contextText || '').trim().slice(0, 6_000);
    const targetCount = complexity === 'complex' ? 15 : complexity === 'standard' ? 8 : 5;

    const layoutRule =
      complexity === 'simple'
        ? 'Mọi slide đều dùng layout "bullets" để tối ưu tốc độ và tiết kiệm token.'
        : 'Phân bổ đa dạng "layout" trong: bullets, comparison, timeline, process, stat, quote, cards, quadrant. KHÔNG lặp cùng 1 layout quá 2 slide liên tiếp. Slide 1 nên dùng "quote" hoặc "stat"; slide cuối nên dùng "cards" hoặc "bullets" để tổng kết.';

    const system = `Bạn là kiến trúc sư bài giảng đại học. Hãy lập DÀN Ý KHUNG XƯƠNG cho bộ slide bằng ${body.languageHint || 'tiếng Việt'}.
Trả về DUY NHẤT một JSON object hợp lệ:
{"outlines":[{"index":1,"title":"Tiêu đề ngắn <= 8 từ","layout":"quote","keyFocus":"1 câu luận điểm cốt lõi"}]}

YÊU CẦU BẮT BUỘC:
1. Tạo ĐÚNG ${targetCount} phần tử trong mảng "outlines" (index từ 1 đến ${targetCount}).
2. ${layoutRule}
3. Mỗi "title" <= 8 từ, mỗi "keyFocus" <= 18 từ. Không giải thích dài dòng, không markdown.`;

    const userPrompt = `CHỦ ĐỀ: ${topic}\nCẤP ĐỘ: ${complexity}\n\nNGỮ CẢNH TÀI LIỆU:\n${contextText || '(Tổng hợp kiến thức chuẩn mực theo chủ đề)'}`;

    const result = await generateText(body.model && body.model !== 'auto' ? body.model : undefined, {
      system,
      userPrompt,
      userId: body.userId ? Number(body.userId) : undefined,
      strictModel: Boolean(body.strictModel) && Boolean(body.model && body.model !== 'auto'),
      taskCategory: complexity === 'simple' ? 'basic' : 'complex',
      jsonMode: true,
      maxTokens: complexity === 'complex' ? 1300 : complexity === 'standard' ? 800 : 500,
      temperature: body.ragMode === 'strict' ? 0.1 : 0.25,
      ragMode: body.ragMode || 'hybrid',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(50_000)]),
    });

    const outlines = parseOutlinesLoose(result.text || '');
    if (outlines.length === 0) {
      return NextResponse.json({ error: 'AI không trả về dàn ý slide hợp lệ.' }, { status: 502 });
    }

    return NextResponse.json({
      outlines,
      provider: result.provider,
      modelId: result.modelId,
    });
  } catch (err) {
    if (request.signal.aborted) throw err;
    console.error('[slides/outline] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Không thể khởi tạo dàn ý slide.' },
      { status: 500 }
    );
  }
}
