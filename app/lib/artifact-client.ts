/**
 * Client helper cho kiến trúc artifact 2 bước:
 *   1. POST /api/artifacts/context  → preparedContext (lấy mẫu phân tầng, không gọi AI)
 *   2. POST /api/artifacts/stream   → SSE (Puter.js được ưu tiên ở UI trước khi gọi helper này)
 *
 * Output của AI được thiết kế tối ưu token (Markdown / flat JSON) rồi convert
 * sang shape mà UI hiện tại đang dùng, nên stream bị ngắt vẫn cứu được dữ liệu.
 */

export type ArtifactType = 'summary' | 'flashcards' | 'mindmap' | 'slides';
export type ArtifactLevel = 'simple' | 'standard' | 'complex';
export type ArtifactRagMode = 'strict' | 'hybrid' | 'creative';

type SourceItem = {
  name: string;
  url?: string;
  type?: string;
  fileId?: number;
  moduleId?: number;
  sectionId?: number;
  sectionName?: string;
  chapter?: string | number;
  isStudentUpload?: boolean;
};

export interface ArtifactContextInput {
  sources?: SourceItem[];
  sourceNames?: string[];
  topic: string;
  courseId?: string | number;
  userId?: number;
  budget?: number;
  ragMode?: ArtifactRagMode;
}

export interface ArtifactContextResult {
  preparedContext: string;
  guidance: string;
  stats: {
    docCount: number;
    totalChars: number;
    budgetPerDoc: number;
    perDoc: Array<{ title: string; includedChunks: number; usedChars: number }>;
    elapsedMs: number;
  };
}

export interface StreamArtifactInput {
  type: ArtifactType;
  topic: string;
  preparedContext: string;
  guidance?: string;
  level?: ArtifactLevel;
  ragMode?: ArtifactRagMode;
  phase?: 'outline' | 'detail';
  outline?: string;
  batch?: string;
  model?: string;
  strictModel?: boolean;
  userId?: number;
  /** Chỉ đặt khi người dùng yêu cầu ngôn ngữ khác tiếng Việt. */
  languageHint?: string;
  retryStrict?: boolean;
}

const PROMPT_LEAK_MARKERS = [
  '<1 đoạn',
  'Length 5-7',
  'Structure mandatory',
  'But output must be exactly',
  'TẦNG 1 (~70%)',
  'Need content:',
  'Độ dài 5-7',
  'gồm đúng 2 phần',
  'Dòng đầu tiên đúng là',
  'followed by a short paragraph',
  'followed by four to six paragraphs',
];

export interface StreamHandlers {
  onMeta?: (meta: { provider: string; modelId: string; modelName: string; keySource?: string }) => void;
  onDelta?: (delta: string, accumulated: string) => void;
  onProgress?: (info: { phase: 'outline' | 'detail'; completed: number; total: number }) => void;
  onPartialData?: (partial: unknown) => void;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const payload = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

export function prepareArtifactContext(
  input: ArtifactContextInput,
  signal?: AbortSignal
): Promise<ArtifactContextResult> {
  return postJson<ArtifactContextResult>('/api/artifacts/context', input, signal);
}

/** Đọc SSE và gọi handler theo từng event. Trả về toàn bộ text đã nhận. */
export async function streamArtifact(
  input: StreamArtifactInput,
  handlers: StreamHandlers = {},
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch('/api/artifacts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `SSE HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumulated = '';
  let streamError = '';

  const handleEvent = (raw: string) => {
    const line = raw.split('\n').find(part => part.startsWith('data:'));
    if (!line) return;
    const event = JSON.parse(line.slice(5).trim()) as {
      type: 'meta' | 'delta' | 'done' | 'error';
      text?: string;
      message?: string;
      provider?: string;
      modelId?: string;
      modelName?: string;
      keySource?: string;
    };
    if (event.type === 'meta') {
      handlers.onMeta?.({
        provider: event.provider || '',
        modelId: event.modelId || '',
        modelName: event.modelName || '',
        keySource: event.keySource,
      });
    } else if (event.type === 'delta' && event.text) {
      accumulated += event.text;
      handlers.onDelta?.(event.text, accumulated);
    } else if (event.type === 'error') {
      streamError = event.message || 'Lỗi stream';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const boundary = buffer.lastIndexOf('\n\n');
    if (boundary === -1) continue;
    const complete = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    for (const raw of complete.split('\n\n')) handleEvent(raw);
  }
  if (buffer.trim()) handleEvent(buffer);

  if (streamError) throw new Error(streamError);
  // Model đang in lại câu lệnh / suy luận thay vì nội dung → thử lại với prompt rút gọn.
  if (PROMPT_LEAK_MARKERS.some(marker => accumulated.includes(marker))) {
    throw new Error('PROMPT_LEAK');
  }
  return accumulated;
}

/** Cứu các object hoàn chỉnh trong mảng JSON bị cụt giữa chừng. */
export function repairTruncatedJsonArray<T = Record<string, unknown>>(text: string): T[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed as T[];
  } catch {
    // fallback bên dưới
  }

  const start = cleaned.indexOf('[');
  if (start === -1) return [];
  const results: T[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          results.push(JSON.parse(cleaned.slice(objStart, i + 1)) as T);
        } catch {
          // bỏ object hỏng, giữ các object trước đó
        }
        objStart = -1;
      }
    }
  }
  return results;
}

function parseJsonObjectLoose(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
      } catch {
        const repaired = cleaned.slice(first, last + 1).replace(/,\s*([}\]])/g, '$1');
        try {
          return JSON.parse(repaired) as Record<string, unknown>;
        } catch {
          // rơi xuống object rỗng
        }
      }
    }
  }
  return {};
}

export interface MindmapNode {
  id: string;
  label: string;
  children: MindmapNode[];
}

/** Markdown thụt lề → cây. Stream ngắt dòng 40 vẫn dựng được cây từ 39 dòng đầu. */
export function parseMarkdownToMindmap(markdown: string): MindmapNode {
  const lines = markdown
    .split('\n')
    .map(line => line.replace(/\r/g, ''))
    .filter(line => line.trim().length > 0);

  const root: MindmapNode = { id: 'node-0', label: 'Chủ đề trọng tâm', children: [] };
  const stack: Array<{ level: number; node: MindmapNode }> = [{ level: -1, node: root }];
  const hasHeadings = lines.some(line => /^#{1,6}\s/.test(line.trim()));

  // Output text thuần: dòng đầu không thụt lề là tên gốc, các cấp sau thụt 2 dấu cách.
  if (!hasHeadings && lines.length > 0) {
    root.label = lines[0].trim().replace(/\*\*/g, '').trim() || root.label;
    lines.shift();
  }

  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    let level = 0;
    let label = trimmed;

    if (trimmed.startsWith('# ')) {
      root.label = trimmed.replace(/^#\s+/, '').replace(/\*\*/g, '');
      return;
    } else if (trimmed.startsWith('## ')) {
      level = 1;
      label = trimmed.replace(/^##\s+/, '');
    } else if (trimmed.startsWith('### ')) {
      level = 2;
      label = trimmed.replace(/^###\s+/, '');
    } else {
      const leadingSpaces = rawLine.search(/\S/);
      level = (hasHeadings ? 3 : 1) + Math.floor(Math.max(0, leadingSpaces) / 2);
      label = trimmed.replace(/^[-*+]\s+/, '');
    }

    label = label.replace(/\*\*/g, '').trim();
    if (!label) return;

    const newNode: MindmapNode = { id: `node-${index + 1}`, label, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].node.children.push(newNode);
    stack.push({ level, node: newNode });
  });

  return root;
}

function toUiMindmapNode(node: MindmapNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.label,
    ...(node.children.length > 0
      ? { children: node.children.map(toUiMindmapNode) }
      : { items: [] }),
  };
}

/** Văn bản thuần (2 nhãn TONG QUAN / NOI DUNG CHINH) → shape UI đang render. */
function parseSummary(text: string): { overview: string; paragraphs: string[] } | null {
  const parsed = parseJsonObjectLoose(text);
  const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
  const paragraphs = Array.isArray(parsed.paragraphs)
    ? parsed.paragraphs.filter((paragraph): paragraph is string => typeof paragraph === 'string').map(paragraph => paragraph.trim()).filter(Boolean)
    : [];
  return overview && paragraphs.length >= 4 ? { overview, paragraphs } : null;
}

function jsonToSummary(text: string, topic: string) {
  const summary = parseSummary(text);
  if (!summary) throw new Error('INVALID_SUMMARY_FORMAT');
  return { title: `Tóm tắt: ${topic}`, overview: summary.overview, points: summary.paragraphs };
}

/** Cắt phần suy nghĩ/bản nháp, chỉ giữ nội dung giữa hai nhãn do model phát ra. */
function extractArtifactBody(text: string, startTag: string, endTag: string, fallbackMarker?: string): string {
  const start = text.indexOf(startTag);
  if (start !== -1) {
    const bodyStart = start + startTag.length;
    const end = text.indexOf(endTag, bodyStart);
    return text.slice(bodyStart, end === -1 ? undefined : end).trim();
  }
  if (fallbackMarker) {
    const last = text.lastIndexOf(fallbackMarker);
    if (last !== -1) return text.slice(last).trim();
  }
  return text.trim();
}

function adaptOutput(type: ArtifactType, text: string, topic: string): unknown {
  if (type === 'summary') {
    return jsonToSummary(text, topic);
  }

  if (type === 'flashcards') {
    const cards = repairTruncatedJsonArray<{ q?: string; a?: string; front?: string; back?: string; tag?: string }>(text);
    // UI render: artifact.data là mảng [{ front, back }]
    return cards
      .filter(card => (card.q || card.front) && (card.a || card.back))
      .map(card => ({
        front: String(card.q || card.front || ''),
        back: String(card.a || card.back || ''),
      }));
  }

  if (type === 'mindmap') {
    const tree = parseMarkdownToMindmap(extractArtifactBody(text, 'MAP_START', 'MAP_END'));
    return {
      root: tree.label,
      branches: tree.children.map(toUiMindmapNode),
    };
  }

  // slides: fallback khi không dùng pipeline 2 pha
  const parsed = parseJsonObjectLoose(text);
  const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
  return { title: topic, topic, slides };
}

function extractSlidesArray(text: string): Array<Record<string, unknown>> {
  const obj = parseJsonObjectLoose(text);
  if (Array.isArray(obj.slides) && obj.slides.length > 0) {
    return obj.slides as Array<Record<string, unknown>>;
  }
  // Rescue complete slide objects if the JSON response was truncated before closing "]"
  const arrayStart = text.indexOf('[');
  if (arrayStart >= 0) {
    const rescued = repairTruncatedJsonArray<Record<string, unknown>>(text.slice(arrayStart));
    if (rescued.length > 0) return rescued;
  }
  return [];
}

/**
 * Client-Orchestrated Micro-Batching cho Slide:
 * 1. POST /api/slides/outline (~2.5s) -> dựng khung N slide (15 cho Chuyên sâu, 8 cho Tiêu chuẩn, 5 cho Cơ bản)
 * 2. Chia micro-batch 3 slide/lô, chạy 2 worker song song gọi POST /api/slides/batch
 * 3. Cập nhật UI theo thời gian thực qua handlers.onPartialData và cô lập lỗi từng lô.
 */
export async function generateSlideArtifact(
  input: StreamArtifactInput,
  handlers: StreamHandlers = {},
  options: { batchSize?: number; signal?: AbortSignal } = {}
): Promise<{ title: string; topic: string; slides: Array<Record<string, unknown>> }> {
  const batchSize = Math.max(2, Math.min(3, options.batchSize ?? 3));
  const signal = options.signal;
  const complexity = input.level || 'standard';
  const minSlides = complexity === 'complex' ? 15 : complexity === 'simple' ? 5 : 7;

  let outlineData = await postJson<{
    outlines: Array<{ index: number; title: string; layout: string; keyFocus: string }>;
    provider?: string;
    modelId?: string;
  }>(
    '/api/slides/outline',
    {
      contextText: input.preparedContext,
      topic: input.topic,
      complexity,
      ragMode: input.ragMode || 'hybrid',
      model: input.model,
      strictModel: input.strictModel,
      userId: input.userId,
      languageHint: input.languageHint,
    },
    signal
  );

  let outlines = Array.isArray(outlineData.outlines) ? outlineData.outlines : [];
  if (outlines.length < minSlides) {
    try {
      const retryOutline = await postJson<{
        outlines: Array<{ index: number; title: string; layout: string; keyFocus: string }>;
      }>(
        '/api/slides/outline',
        {
          contextText: input.preparedContext,
          topic: `${input.topic} (BẮT BUỘC đủ ${minSlides} slide)`,
          complexity,
          ragMode: input.ragMode || 'hybrid',
          model: input.model,
          strictModel: false,
          userId: input.userId,
          languageHint: input.languageHint,
        },
        signal
      );
      if (Array.isArray(retryOutline.outlines) && retryOutline.outlines.length > outlines.length) {
        outlines = retryOutline.outlines;
      }
    } catch {
      // keep initial outlines
    }
  }

  if (outlines.length === 0) throw new Error('AI không trả về dàn ý slide hợp lệ.');
  if (outlineData.provider) {
    handlers.onMeta?.({
      provider: outlineData.provider,
      modelId: outlineData.modelId || '',
      modelName: outlineData.modelId || outlineData.provider,
    });
  }

  // Normalize indices 1..N
  outlines = outlines.map((o, idx) => ({ ...o, index: idx + 1 }));

  let currentSlides: Array<Record<string, unknown>> = outlines.map(item => ({
    slideNumber: item.index,
    title: item.title,
    subtitle: item.keyFocus,
    bullets: [item.keyFocus, 'Đang biên soạn nội dung chi tiết…'],
    keyTakeaway: item.keyFocus,
    notes: 'Đang biên soạn nội dung chi tiết và ghi chú thuyết trình…',
    layout: complexity === 'simple' ? 'bullets' : item.layout || 'bullets',
  }));

  handlers.onProgress?.({ phase: 'outline', completed: outlines.length, total: outlines.length });
  handlers.onPartialData?.({ title: input.topic, topic: input.topic, slides: [...currentSlides] });

  const batches: Array<typeof outlines> = [];
  for (let i = 0; i < outlines.length; i += batchSize) {
    batches.push(outlines.slice(i, i + batchSize));
  }

  const CONCURRENCY = 2;
  let cursor = 0;
  let completedBatches = 0;

  async function worker() {
    while (cursor < batches.length) {
      if (signal?.aborted) return;
      const batchItems = batches[cursor++];

      try {
        const res = await postJson<{ slides: Array<Record<string, unknown>> }>(
          '/api/slides/batch',
          {
            contextText: input.preparedContext,
            topic: input.topic,
            complexity,
            ragMode: input.ragMode || 'hybrid',
            batchItems,
            model: input.model,
            strictModel: input.strictModel,
            userId: input.userId,
            languageHint: input.languageHint,
          },
          signal
        );

        for (const doneSlide of res.slides || []) {
          const num = Number(doneSlide.slideNumber);
          const pos = currentSlides.findIndex(s => Number(s.slideNumber) === num);
          if (pos !== -1) {
            currentSlides[pos] = doneSlide;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        // Isolate failure to this 3-slide batch only
        for (const item of batchItems) {
          const pos = currentSlides.findIndex(s => Number(s.slideNumber) === item.index);
          if (pos !== -1) {
            currentSlides[pos] = {
              slideNumber: item.index,
              title: item.title,
              subtitle: item.keyFocus,
              bullets: [item.keyFocus],
              keyTakeaway: item.keyFocus,
              notes: item.keyFocus,
              layout: 'bullets',
            };
          }
        }
      } finally {
        completedBatches++;
        handlers.onProgress?.({ phase: 'detail', completed: completedBatches, total: batches.length });
        handlers.onPartialData?.({ title: input.topic, topic: input.topic, slides: [...currentSlides] });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker())
  );

  return { title: input.topic, topic: input.topic, slides: currentSlides };
}

/** High-level: gom context → stream → convert sang shape UI đang dùng. */
export async function generateArtifact(
  input: ArtifactContextInput & {
    type: ArtifactType;
    level?: ArtifactLevel;
    model?: string;
    strictModel?: boolean;
    /** Chỉ đặt khi người dùng yêu cầu ngôn ngữ khác tiếng Việt. */
    languageHint?: string;
  },
  handlers: StreamHandlers = {},
  signal?: AbortSignal
): Promise<unknown> {
  const context = await prepareArtifactContext(input, signal);
  const streamInput: StreamArtifactInput = {
    type: input.type,
    topic: input.topic,
    preparedContext: context.preparedContext,
    guidance: context.guidance,
    level: input.level,
    ragMode: input.ragMode,
    model: input.model,
    strictModel: input.strictModel,
    userId: input.userId,
    languageHint: input.languageHint,
  };

  if (input.type === 'slides') {
    return generateSlideArtifact(streamInput, handlers, { signal });
  }

  let text: string;
  try {
    text = await streamArtifact(streamInput, handlers, signal);
  } catch (err) {
    if (err instanceof Error && err.message === 'PROMPT_LEAK') {
      text = await streamArtifact({ ...streamInput, retryStrict: true }, handlers, signal);
    } else {
      throw err;
    }
  }
  try {
    return adaptOutput(input.type, text, input.topic);
  } catch (err) {
    // Không bao giờ lưu phần chỉ dẫn hay bản nháp làm tóm tắt: thử lại một lần
    // với ràng buộc đầu ra chặt hơn, rồi báo lỗi nếu vẫn không hợp lệ.
    if (input.type === 'summary' && err instanceof Error && err.message === 'INVALID_SUMMARY_FORMAT' && !streamInput.retryStrict) {
      const retryText = await streamArtifact({ ...streamInput, retryStrict: true }, handlers, signal);
      return adaptOutput(input.type, retryText, input.topic);
    }
    throw err;
  }
}
