import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';
import type { SlideItem, SlideLayoutKind } from '@/lib/pptx-export';
import type { SlideOutlineItem } from '@/app/api/slides/outline/route';

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

function parseSlidesLoose(text: string): Array<Record<string, unknown>> {
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

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.slides)) return obj.slides as Array<Record<string, unknown>>;
  } else if (Array.isArray(parsed)) {
    return parsed as Array<Record<string, unknown>>;
  }

  // Rescue complete slide objects if truncated
  const arrStart = cleaned.indexOf('[');
  if (arrStart >= 0) {
    const rescued: Array<Record<string, unknown>> = [];
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
          const item = tryParse(cleaned.slice(objStart, i + 1));
          if (item && typeof item === 'object') rescued.push(item as Record<string, unknown>);
          objStart = -1;
        }
      }
    }
    if (rescued.length > 0) return rescued;
  }

  return [];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      contextText?: string;
      topic?: string;
      complexity?: 'simple' | 'standard' | 'complex';
      ragMode?: 'strict' | 'hybrid' | 'creative';
      batchItems?: SlideOutlineItem[];
      model?: string;
      strictModel?: boolean;
      userId?: number;
      languageHint?: string;
    };

    const batchItems = Array.isArray(body.batchItems) ? body.batchItems : [];
    if (batchItems.length === 0) {
      return NextResponse.json({ error: 'Thiếu batchItems.' }, { status: 400 });
    }

    const topic = body.topic?.trim() || 'Nội dung học tập';
    const complexity = body.complexity || 'standard';
    const contextText = (body.contextText || '').trim().slice(0, 12_000);
    const isSimple = complexity === 'simple';

    const layoutGuide = isSimple
      ? 'Dùng layout "bullets", không cần trường "visual".'
      : `BẮT BUỘC giữ đúng "layout" đã giao cho từng slide và điền "visual" khớp layout:
- "bullets": không cần visual, chỉ cần 3-4 bullets.
- "comparison": visual = {"leftLabel":"...","leftPoints":["...","..."],"rightLabel":"...","rightPoints":["...","..."]}
- "timeline" hoặc "process": visual = {"steps":[{"label":"Bước/Mốc","description":"<= 15 từ"}]} (3-4 bước)
- "stat": visual = {"value":"Con số/Kết luận nổi bật","context":"<= 15 từ"}
- "quote": visual = {"quote":"Câu trích dẫn/Định nghĩa cốt lõi","author":"Nguồn/Ngữ cảnh"}
- "cards": visual = {"cards":[{"title":"...","description":"<= 16 từ"}]} (2-4 thẻ)
- "quadrant": visual = {"quadrants":[{"title":"...","description":"<= 15 từ"}]} (4 ô 2x2)`;

    const system = `Bạn là giảng viên đại học đang hoàn thiện chi tiết cho ĐÚNG ${batchItems.length} slide dưới đây bằng ${body.languageHint || 'tiếng Việt'}.
${layoutGuide}

GIỚI HẠN ĐỘ DÀI ĐỂ TỐI ƯU HIỂN THỊ & JSON:
- title <= 8 từ, subtitle <= 12 từ
- bullets: 2-4 ý dự phòng (mỗi ý <= 12 từ)
- mỗi node/card trong visual <= 18 từ
- keyTakeaway: 1 câu đúc kết cốt lõi
- notes: ${isSimple ? '1 câu ngắn gọn (<= 25 từ)' : '2-3 câu lời giảng đắt giá (<= 45 từ)'}

Trả về DUY NHẤT JSON:
{"slides":[{"slideNumber":1,"title":"...","subtitle":"...","layout":"...","bullets":["..."],"visual":{...},"keyTakeaway":"...","notes":"..."}]}`;

    const userPrompt = `CHỦ ĐỀ: ${topic}
DANH SÁCH ${batchItems.length} SLIDE CẦN HOÀN THIỆN:
${JSON.stringify(batchItems)}

NGỮ CẢNH TÀI LIỆU:
${contextText || '(Tổng hợp kiến thức chuẩn mực theo chủ đề)'}`;

    const result = await generateText(body.model && body.model !== 'auto' ? body.model : undefined, {
      system,
      userPrompt,
      userId: body.userId ? Number(body.userId) : undefined,
      strictModel: Boolean(body.strictModel) && Boolean(body.model && body.model !== 'auto'),
      taskCategory: isSimple ? 'basic' : 'complex',
      jsonMode: true,
      maxTokens: isSimple ? 1050 : 1650,
      temperature: body.ragMode === 'strict' ? 0.1 : 0.3,
      ragMode: body.ragMode || 'hybrid',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(50_000)]),
    });

    const rawSlides = parseSlidesLoose(result.text || '');
    const hydrated: SlideItem[] = batchItems.map((outline, idx) => {
      const match =
        rawSlides.find(s => Number(s.slideNumber ?? s.index) === outline.index) || rawSlides[idx];
      if (!match) {
        return {
          slideNumber: outline.index,
          title: outline.title,
          subtitle: outline.keyFocus,
          bullets: [outline.keyFocus],
          keyTakeaway: outline.keyFocus,
          notes: outline.keyFocus,
          layout: 'bullets',
        };
      }
      const rawLayout = String(match.layout || outline.layout || 'bullets').toLowerCase() as SlideLayoutKind;
      const layout = isSimple ? 'bullets' : VALID_LAYOUTS.includes(rawLayout) ? rawLayout : outline.layout;
      const bullets = Array.isArray(match.bullets)
        ? match.bullets.map(b => String(b).trim()).filter(Boolean)
        : [outline.keyFocus];

      return {
        slideNumber: outline.index,
        title: String(match.title || outline.title).trim(),
        subtitle: String(match.subtitle || outline.keyFocus).trim(),
        bullets: bullets.length > 0 ? bullets : [outline.keyFocus],
        keyTakeaway: String(match.keyTakeaway || bullets[0] || outline.keyFocus).trim(),
        notes: String(match.notes || outline.keyFocus).trim(),
        layout,
        visual:
          !isSimple && match.visual && typeof match.visual === 'object'
            ? (match.visual as SlideItem['visual'])
            : undefined,
      };
    });

    return NextResponse.json({
      slides: hydrated,
      provider: result.provider,
      modelId: result.modelId,
    });
  } catch (err) {
    if (request.signal.aborted) throw err;
    console.error('[slides/batch] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Không thể tạo chi tiết lô slide.' },
      { status: 500 }
    );
  }
}
