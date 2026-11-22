import { NextResponse } from 'next/server';
import { getPersonalMaterials } from '@/lib/firebase-data';
import { parseDocumentFromUrl } from '@/lib/document-parser';
import { buildStratifiedContext, HYBRID_CONTEXT_GUIDANCE } from '@/lib/stratified-context';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    })
  );
  return results;
}

/**
 * Bước 1 của kiến trúc artifact: chỉ gom + cân bằng ngữ cảnh, KHÔNG gọi AI.
 * Trả về preparedContext đã lấy mẫu phân tầng để client đưa thẳng vào
 * Puter.js (ưu tiên) hoặc /api/artifacts/stream (SSE server fallback).
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const body = (await request.json()) as {
      sources?: SourceItem[];
      sourceNames?: string[];
      topic?: string;
      courseId?: string | number;
      userId?: number;
      budget?: number;
      ragMode?: 'strict' | 'hybrid' | 'creative';
    };

    const sources: SourceItem[] =
      body.sources && body.sources.length > 0
        ? body.sources
        : (body.sourceNames || []).map(name => ({ name }));
    const selectedNames = new Set(sources.map(s => s.name.toLowerCase()));
    const moodleCourseId = Number(body.courseId) || undefined;
    const docMap = new Map<string, string>();
    const signal = AbortSignal.timeout(12_000);

    // 1. Tài liệu cá nhân / Moodle đã chọn.
    if (moodleCourseId) {
      try {
        const materials = await getPersonalMaterials({ moodleCourseId, limit: 10 });
        const toParse = (materials || []).filter(
          mat =>
            mat.storage_url &&
            mat.title &&
            (selectedNames.size === 0 || selectedNames.has(String(mat.title).toLowerCase()))
        );
        const parsed = await mapLimit(toParse, 3, async mat => {
          try {
            const text = await parseDocumentFromUrl(String(mat.storage_url), String(mat.title), {
              signal,
              skipVisionOcr: true,
            });
            return { key: String(mat.title).toLowerCase(), text };
          } catch {
            return { key: String(mat.title).toLowerCase(), text: '' };
          }
        });
        for (const item of parsed) {
          if (item.text.trim().length > 30) docMap.set(item.key, item.text);
        }
      } catch (err) {
        console.warn('[artifacts/context] personal materials skipped:', err);
      }
    }

    // 2. URL công khai / liên kết web.
    const urlSources = sources.filter(src => src.url && !docMap.has(src.name.toLowerCase()));
    const parsedUrls = await mapLimit(urlSources, 6, async src => {
      try {
        const text = await parseDocumentFromUrl(src.url!, src.name, {
          signal,
          skipVisionOcr: true,
        });
        return { key: src.name.toLowerCase(), text };
      } catch {
        return { key: src.name.toLowerCase(), text: '' };
      }
    });
    for (const item of parsedUrls) {
      if (item.text.trim().length > 30) docMap.set(item.key, item.text);
    }

    // 3. Ghép theo đúng danh sách nguồn được tick (giữ thứ tự UI).
    const docs: Array<{ title: string; text: string }> = [];
    for (const src of sources) {
      const lower = src.name.toLowerCase();
      let text = docMap.get(lower) || '';
      if (!text) {
        for (const [key, value] of docMap.entries()) {
          if (key.includes(lower) || lower.includes(key)) {
            text = value;
            break;
          }
        }
      }
      if (text.trim().length > 30 && !docs.some(d => d.title === src.name)) {
        docs.push({ title: src.name, text });
      }
    }

    const result = buildStratifiedContext(docs, {
      budget: body.budget,
      topic: body.topic,
    });

    const ragMode = body.ragMode || 'hybrid';
    console.log(
      `[artifacts/context] ${Date.now() - startedAt}ms — ${docs.length} doc(s), ${result.totalChars} chars, budget/doc ${result.budgetPerDoc}`
    );

    return NextResponse.json({
      preparedContext: result.preparedContext,
      guidance: ragMode === 'hybrid' ? HYBRID_CONTEXT_GUIDANCE : '',
      stats: {
        docCount: docs.length,
        totalChars: result.totalChars,
        budgetPerDoc: result.budgetPerDoc,
        perDoc: result.docs,
        elapsedMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    console.error('[artifacts/context] failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Không thể chuẩn bị ngữ cảnh tài nguyên.' },
      { status: 500 }
    );
  }
}
