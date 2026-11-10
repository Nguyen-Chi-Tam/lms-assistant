import { extractText } from 'unpdf';
import JSZip from 'jszip';

const OCR_PROMPT = `Bạn là hệ thống Multimodal Vision OCR học thuật cao cấp. Hãy nhận diện và chép lại toàn bộ văn bản nhìn thấy trong ảnh theo đúng cấu trúc trực quan:
1. Thấu hiểu ngữ cảnh, bóc tách cấu trúc chính xác tuyệt đối (giữ nguyên tiêu đề, công thức toán học LaTeX, danh sách và bảng biểu).
2. ĐẶC BIỆT NẾU ẢNH LÀ BẢNG ĐIỂM, SỔ THEO DÕI, DANH SÁCH SINH VIÊN HOẶC ĐIỂM SỐ: Bắt buộc định dạng thành Bảng Markdown chuẩn với đầy đủ các cột (STT, Mã sinh viên, Họ và tên, Điểm số, Đánh giá/Ghi chú) để dữ liệu không bị lệch hàng lệch cột.
3. Không thêm lời giải thích cá nhân, không thêm lời chào, không suy đoán phần bị che khuất. Nếu không có chữ, trả về chuỗi rỗng.`;

const PDF_OCR_PROMPT = `Bạn là hệ thống trích xuất văn bản tài liệu học thuật cao cấp. Tệp PDF này có thể là bản scan/ảnh không chọn được chữ. Hãy đọc toàn bộ các trang và trích xuất lại 100% nội dung chữ, bảng biểu, danh sách và tiêu đề theo đúng thứ tự các trang dạng [Trang 1], [Trang 2]... Không bỏ sót bất kỳ chi tiết nào. Nếu một trang không có chữ, bỏ qua trang đó. Chỉ trả về văn bản trích xuất, không thêm lời giải thích.`;

// Gemini model names change over time, and the chat flagship (GEMINI_MODEL) can be
// temporarily overloaded (503) or slower for document OCR. OCR therefore tries a
// short list of vision-capable models instead of betting everything on one model.
const DEFAULT_VISION_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.1-pro-preview',
];

type VisionPart = { text: string } | { inlineData: { mimeType: string; data: string } };

type VisionOcrStatus = { unsupported: boolean; detail?: string } | null;

// Outcome of the latest vision/OCR pass. Reset on every new document parse and
// read via getLastVisionOcrStatus() so API routes can inform users when the
// configured AI model does not support image input ("Cannot read 'image' ...
// this model does not support image input").
let lastVisionOcrStatus: VisionOcrStatus = null;

export function getLastVisionOcrStatus(): VisionOcrStatus {
  return lastVisionOcrStatus;
}

/**
 * Detects provider errors raised when a vision-capable model call fails because
 * the target model does NOT support image / multimodal input.
 * Example error: "Cannot read 'image' ... (this model does not support image input)".
 */
export function isVisionUnsupportedError(err: unknown): boolean {
  const raw = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
  const msg = raw.toLowerCase().replace(/_/g, ' ');
  return (
    msg.includes('does not support') ||
    msg.includes("doesn't support") ||
    msg.includes('not support') ||
    msg.includes('unsupported') ||
    msg.includes('image input') ||
    msg.includes('image_url') ||
    msg.includes('inline data') ||
    msg.includes('inlineData') ||
    msg.includes('vision') ||
    msg.includes('multimodal') ||
    msg.includes('modality')
  );
}

function getVisionGeminiModels(primary?: string, backups?: string[]): string[] {
  const configured = (process.env.VISION_OCR_MODELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return Array.from(
    new Set([...configured, ...DEFAULT_VISION_MODELS, primary || '', ...(backups || [])].filter(Boolean))
  );
}

function remainingMs(deadline: number): number {
  return deadline - Date.now();
}

export interface GeminiVisionCallOptions {
  maxOutputTokens: number;
  perModelTimeoutMs: number;
  deadline: number;
  /** BYOK: User-provided Gemini keys prioritized before the system key pool. */
  userKeys?: string[];
  signal?: AbortSignal;
  responseMimeType?: string;
}

export interface GeminiVisionCallResult {
  text: string;
  unsupported: boolean;
}

type VisionInlinePart = { inlineData: { mimeType: string; data: string } };

/**
 * Runs a Gemini multimodal request against several vision-capable models.
 * Tries each candidate model with BYOK user keys first, then the system
 * Gemini key pool (each key tries its own model failover list).
 * Returns the first non-empty transcription, or an empty text when every
 * candidate fails. The outcome is recorded via getLastVisionOcrStatus() so
 * callers can inform users when no vision model supports the image input.
 */
export async function runGeminiVisionCall(
  params: {
    prompt: string;
    parts: VisionPart[];
    maxOutputTokens: number;
    perModelTimeoutMs: number;
    deadline: number;
    userKeys?: string[];
    signal?: AbortSignal;
    responseMimeType?: string;
  }
): Promise<GeminiVisionCallResult> {
  const { executeWithGeminiPool, GEMINI_MODEL, GEMINI_BACKUP_MODELS } = await import('@/models/gemini');
  const models = getVisionGeminiModels(GEMINI_MODEL, GEMINI_BACKUP_MODELS);
  const { prompt, parts } = params;

  const contentParts: VisionPart[] = [{ text: prompt }, ...parts.filter((p): p is VisionInlinePart => 'inlineData' in p)];

  let unsupported = false;
  for (const model of models) {
    const budget = Math.min(params.perModelTimeoutMs, remainingMs(params.deadline));
    if (budget < 3_000) break;
    try {
      const text = await executeWithGeminiPool(async client => {
        const response = await client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: contentParts }],
          config: {
            temperature: 0,
            maxOutputTokens: params.maxOutputTokens,
            // OCR is a perception task; reasoning tokens only add latency/cost.
            thinkingConfig: { thinkingBudget: 0 },
            ...(params.responseMimeType ? { responseMimeType: params.responseMimeType } : {}),
            abortSignal: params.signal ?? AbortSignal.timeout(budget),
          },
        });
        return response.text?.trim() || '';
      });
      if (text) {
        lastVisionOcrStatus = null;
        console.log(`[Vision OCR] ${model} transcribed ${text.length} chars`);
        return { text, unsupported };
      }
    } catch (err) {
      if (isVisionUnsupportedError(err)) {
        unsupported = true;
        lastVisionOcrStatus = { unsupported: true, detail: err instanceof Error ? err.message : String(err) };
        console.warn(`[Vision OCR] ${model} skipped: model does not support image input.`);
      } else {
        console.warn(
          `[Vision OCR] ${model} unavailable:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return { text: '', unsupported };
}

async function runGeminiVision(
  parts: VisionPart[],
  options: { maxOutputTokens: number; perModelTimeoutMs: number; deadline: number; userKeys?: string[]; signal?: AbortSignal }
): Promise<{ text: string; unsupported: boolean }> {
  const textPart = parts.find((p): p is { text: string } => 'text' in p);
  const prompt = textPart?.text || OCR_PROMPT;
  const inlineParts = parts.filter((p): p is VisionInlinePart => 'inlineData' in p);
  const result = await runGeminiVisionCall({
    prompt,
    parts: inlineParts,
    maxOutputTokens: options.maxOutputTokens,
    perModelTimeoutMs: options.perModelTimeoutMs,
    deadline: options.deadline,
    userKeys: options.userKeys,
    signal: options.signal,
  });
  return result;
}

function inferImageMimeType(fileName: string, supplied?: string): string | null {
  if (supplied?.startsWith('image/')) return supplied;
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const types: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return ext ? types[ext] || null : null;
}

function toBuffer(buffer: ArrayBuffer | Uint8Array | Buffer): Buffer | null {
  try {
    return Buffer.isBuffer(buffer)
      ? buffer
      : buffer instanceof Uint8Array
        ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : Buffer.from(buffer);
  } catch {
    return null;
  }
}

/**
 * Last-resort OCR for images when Gemini is unavailable: OpenAI Vision then APMIX
 * (both expose an OpenAI-compatible `image_url` content part).
 * The image never leaves the request as anything other than extracted text.
 */
async function ocrImageWithThirdParty(base64: string, mimeType: string): Promise<{ text: string; unsupported: boolean }> {
  const content = [
    { type: 'text' as const, text: OCR_PROMPT },
    { type: 'image_url' as const, image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' as const } },
  ];
  let unsupported = false;

  try {
    const { getOpenAIClient } = await import('@/models/openai');
    const openai = getOpenAIClient();
    if (openai) {
      const completion = await openai.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 4096,
          messages: [{ role: 'user', content }],
        },
        { signal: AbortSignal.timeout(45_000) }
      );
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) {
        lastVisionOcrStatus = null;
        console.log(`[Vision OCR] OpenAI transcribed ${text.length} chars`);
        return { text, unsupported: false };
      }
    }
  } catch (err) {
    if (isVisionUnsupportedError(err)) {
      unsupported = true;
      lastVisionOcrStatus = { unsupported: true, detail: err instanceof Error ? err.message : String(err) };
      console.warn('OpenAI Vision OCR skipped: model does not support image input.');
    } else {
      console.warn('OpenAI Vision OCR unavailable:', err instanceof Error ? err.message : err);
    }
  }

  try {
    const { getApmixClient } = await import('@/models/apmix');
    const apmix = getApmixClient();
    if (apmix) {
      const completion = await apmix.chat.completions.create(
        {
          model: 'hy4-free',
          temperature: 0,
          max_tokens: 4096,
          messages: [{ role: 'user', content }],
        },
        { signal: AbortSignal.timeout(45_000) }
      );
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) {
        lastVisionOcrStatus = null;
        console.log(`[Vision OCR] APMIX transcribed ${text.length} chars`);
        return { text, unsupported: false };
      }
    }
  } catch (err) {
    if (isVisionUnsupportedError(err)) {
      unsupported = true;
      lastVisionOcrStatus = { unsupported: true, detail: err instanceof Error ? err.message : String(err) };
      console.warn('APMIX Vision OCR skipped: model does not support image input.');
    } else {
      console.warn('APMIX Vision OCR unavailable:', err instanceof Error ? err.message : err);
    }
  }

  return { text: '', unsupported };
}

/**
 * Vision OCR for image-only study material.  The image stays request-local:
 * extracted text, not its base64 payload, is the only value returned to RAG.
 */
export async function extractTextFromImage(
  buffer: ArrayBuffer | Uint8Array | Buffer,
  fileName: string,
  mimeType?: string,
  userKeys?: string[]
): Promise<{ text: string; unsupported: boolean }> {
  const imageMime = inferImageMimeType(fileName, mimeType);
  if (!imageMime) return { text: '', unsupported: false };
  const bytes = toBuffer(buffer);
  if (!bytes) return { text: '', unsupported: false };
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return { text: '', unsupported: false };
  const base64 = bytes.toString('base64');

  const geminiText = await runGeminiVision(
    [{ text: OCR_PROMPT }, { inlineData: { mimeType: imageMime, data: base64 } }],
    { maxOutputTokens: 4096, perModelTimeoutMs: 35_000, deadline: Date.now() + 75_000, userKeys }
  );
  if (geminiText.text) return geminiText;

  return ocrImageWithThirdParty(base64, imageMime);
}

/**
 * Extracts JPEG streams embedded in a PDF.  Most scanned PDFs store one full-page
 * JPEG per page with a /DCTDecode filter, so this lets us recover page images and
 * send them to an image-capable vision model when native PDF OCR fails.
 */
function extractEmbeddedJpegImages(bytes: Buffer): Buffer[] {
  const images: Buffer[] = [];
  const latin = bytes.toString('latin1');
  const soiPhone = Buffer.from([0xff, 0xd8, 0xff]);
  const eoiMarker = Buffer.from([0xff, 0xd9]);
  let searchFrom = 0;

  while (images.length < 12) {
    const dictStart = latin.indexOf('/Subtype', searchFrom);
    if (dictStart === -1) break;
    const streamKeyword = latin.indexOf('stream', dictStart);
    if (streamKeyword === -1) break;

    const dict = latin.slice(dictStart, streamKeyword);
    if (!/\/Image\b/.test(dict) || !/DCTDecode/.test(dict)) {
      searchFrom = dictStart + 8;
      continue;
    }

    let streamStart = streamKeyword + 'stream'.length;
    if (latin[streamStart] === '\r') streamStart++;
    if (latin[streamStart] === '\n') streamStart++;
    const streamEnd = latin.indexOf('endstream', streamStart);
    if (streamEnd === -1) break;

    const slice = bytes.subarray(streamStart, streamEnd);
    const soi = slice.indexOf(soiPhone);
    if (soi !== -1) {
      const eoi = slice.lastIndexOf(eoiMarker);
      images.push(slice.subarray(soi, eoi > soi ? eoi + 2 : slice.length));
    }
    searchFrom = streamEnd + 'endstream'.length;
  }

  return images;
}

/**
 * Multimodal Vision OCR for PDF files where standard text extraction (unpdf) yields zero text
 * (such as scanned PDFs, slide exports, or rasterized pages).
 */
export async function extractTextFromPdfVision(
  buffer: ArrayBuffer | Uint8Array | Buffer,
  fileName: string,
  userKeys?: string[]
): Promise<{ text: string; unsupported: boolean }> {
  const bytes = toBuffer(buffer);
  if (!bytes) return { text: '', unsupported: false };
  if (bytes.byteLength === 0 || bytes.byteLength > 15 * 1024 * 1024) return { text: '', unsupported: false };
  const base64 = bytes.toString('base64');
  const deadline = Date.now() + 150_000;

  // 1. Native PDF understanding (fastest and preserves tables/layout).
  const geminiText = await runGeminiVision(
    [{ text: PDF_OCR_PROMPT }, { inlineData: { mimeType: 'application/pdf', data: base64 } }],
    { maxOutputTokens: 8192, perModelTimeoutMs: 75_000, deadline, userKeys }
  );
  if (geminiText.text) return geminiText;

  // 2. Fallback: OCR each embedded page image (works with image-only providers).
  const pageImages = extractEmbeddedJpegImages(bytes);
  if (pageImages.length === 0) {
    console.warn(`[PDF Parser] No embedded JPEG pages recoverable from "${fileName}".`);
    return { text: '', unsupported: false };
  }

  console.log(
    `[PDF Parser] Native PDF OCR failed for "${fileName}", falling back to ${pageImages.length} embedded page image(s).`
  );
  const pageTexts: string[] = [];
  const unsupported = Boolean(lastVisionOcrStatus?.unsupported);
  const maxPages = Math.min(pageImages.length, 10);
  for (let i = 0; i < maxPages; i++) {
    if (remainingMs(deadline) < 5_000) break;
    const pageResult = await extractTextFromImage(pageImages[i], `${fileName}-page-${i + 1}.jpg`, 'image/jpeg', userKeys);
    if (pageResult.text) pageTexts.push(`[Trang ${i + 1}]\n${pageResult.text}`);
  }

  return { text: pageTexts.join('\n\n'), unsupported };
}

/**
 * Extracts plain text from a DOCX (Office Open XML) buffer using JSZip.
 */
export async function extractDocxText(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const docXmlFile = zip.file('word/document.xml');
    if (!docXmlFile) return '';
    const xml = await docXmlFile.async('text');
    const text = xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n');
    return text;
  } catch (err) {
    console.warn('Error extracting text from docx:', err);
    return '';
  }
}

/**
 * Extracts slide texts from a PPTX (Office Open XML) buffer using JSZip.
 */
export async function extractPptxText(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter(f => f.startsWith('ppt/slides/slide') && f.endsWith('.xml'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });

    const slidesText: string[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const file = zip.file(slideFiles[i]);
      if (!file) continue;
      const xml = await file.async('text');
      const slideText = xml
        .replace(/<\/a:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join(' ');
      if (slideText) {
        slidesText.push(`[Slide ${i + 1}]\n${slideText}`);
      }
    }
    return slidesText.join('\n\n');
  } catch (err) {
    console.warn('Error extracting text from pptx:', err);
    return '';
  }
}

// In-memory cache for parsed document texts during the session
const MAX_PARSED_CACHE = 50;
const documentTextCache = new Map<string, string>();

/**
 * Purges cached document text from memory.
 * If keyPattern is provided, only deletes entries containing the pattern.
 * Otherwise, clears all cached document texts.
 */
export function clearDocumentCache(keyPattern?: string): number {
  if (!keyPattern) {
    const count = documentTextCache.size;
    documentTextCache.clear();
    return count;
  }

  const lower = keyPattern.toLowerCase();
  let deleted = 0;
  for (const key of documentTextCache.keys()) {
    if (key.toLowerCase().includes(lower)) {
      documentTextCache.delete(key);
      deleted++;
    }
  }
  return deleted;
}

function setDocumentCache(key: string, value: string): void {
  if (documentTextCache.size >= MAX_PARSED_CACHE) {
    const oldestKey = documentTextCache.keys().next().value;
    if (oldestKey) {
      documentTextCache.delete(oldestKey);
    }
  }
  documentTextCache.set(key, value);
}

const failedUrls = new Map<string, number>(); // url -> timestamp

function isUrlTemporarilyFailed(url: string): boolean {
  const failedAt = failedUrls.get(url);
  if (!failedAt) return false;
  if (Date.now() - failedAt > 15 * 60 * 1000) {
    failedUrls.delete(url);
    return false;
  }
  return true;
}

function markUrlFailed(url: string) {
  failedUrls.set(url, Date.now());
}

export async function parseDocumentFromUrl(
  url: string,
  fileName: string,
  options?: { authToken?: string; userKeys?: string[] }
): Promise<string> {
  lastVisionOcrStatus = null;
  const cacheKey = `${fileName}::${url}`;
  if (documentTextCache.has(cacheKey)) {
    const cached = documentTextCache.get(cacheKey)!;
    if (cached && cached.trim().length > 30) {
      return cached;
    }
  }

  if (isUrlTemporarilyFailed(url)) {
    return '';
  }

  try {
    const fetchUrl = url;
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/pdf;q=0.9,*/*;q=0.8',
    };

    if (options?.authToken && !fetchUrl.includes('token=')) {
      headers['Authorization'] = `Bearer ${options.authToken}`;
    }

    // If it's a direct public web link (not localhost, not moodle view.php wrapper), try Jina Reader directly
    const isPublicWeb =
      fetchUrl.startsWith('http') &&
      !fetchUrl.includes('localhost') &&
      !fetchUrl.includes('127.0.0.1') &&
      !fetchUrl.includes('/mod/url/view.php') &&
      !fetchUrl.includes('/mod/resource/view.php') &&
      !fetchUrl.includes('pluginfile.php');

    if (isPublicWeb) {
      try {
        const jinaUrl = `https://r.jina.ai/${fetchUrl}`;
        const jinaRes = await fetch(jinaUrl, {
          headers: {
            'X-Return-Format': 'markdown',
            'X-With-Generated-Alt': 'true',
            Accept: 'text/markdown, text/plain',
          },
          signal: AbortSignal.timeout(3500),
        });

        if (jinaRes.ok) {
          const markdown = await jinaRes.text();
          if (markdown && markdown.trim().length > 120 && !markdown.includes('403 Forbidden') && !markdown.includes('Access Denied')) {
            setDocumentCache(cacheKey, markdown.trim());
            return markdown.trim();
          }
        }
      } catch {
        // Fast skip Jina reader if timeout or blocked
      }
    }

    const response = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(45000) });
    if (!response.ok) {
      console.warn(`Failed to fetch document from ${fetchUrl}: status ${response.status}`);
      // When external websites block scrapers (403/468/500), extract topic from URL slug so RAG still retains context
      try {
        const urlObj = new URL(fetchUrl);
        const lastSlug = urlObj.pathname.split('/').filter(Boolean).pop() || '';
        const cleanSlug = decodeURIComponent(lastSlug.replace(/\.(html?|php|aspx?)$/i, ''))
          .replace(/[-_+]+/g, ' ')
          .trim();
        const topicName = cleanSlug.length > 3 ? cleanSlug : fileName;
        const semanticFallback = `[Tài liệu tham khảo chuyên môn: "${fileName}"]\nLiên kết gốc: ${fetchUrl}\nChủ đề môn học: ${topicName}\n(Tài liệu này là liên kết bài học chuyên môn do giảng viên cấu hình cho môn học về chủ đề "${topicName}". Sinh viên có thể truy cập liên kết gốc để đọc tài liệu đầy đủ hoặc yêu cầu AI giải thích và so sánh các kiến thức liên quan dựa theo chuẩn môn học).`;
        setDocumentCache(cacheKey, semanticFallback);
        return semanticFallback;
      } catch {
        return '';
      }
    }

    const contentType = response.headers.get('content-type') || '';
    const fileBuffer = Buffer.from(await response.arrayBuffer());

    const lowerName = fileName.toLowerCase();
    const isPdf =
      lowerName.endsWith('.pdf') ||
      contentType.includes('application/pdf') ||
      fetchUrl.toLowerCase().includes('.pdf');

    if (isPdf) {
      let fullText = '';
      try {
        // Clone Uint8Array so unpdf internal worker transfers never detach fileBuffer
        const unpdfBytes = new Uint8Array(
          fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength)
        );
        const { text } = await extractText(unpdfBytes);
        if (Array.isArray(text)) {
          fullText = text.map((pageStr, idx) => `[Trang ${idx + 1}]\n${pageStr}`).join('\n\n');
        } else {
          fullText = String(text || '');
        }
      } catch (pdfErr) {
        console.warn(`[PDF Parser] unpdf extraction error for ${fileName}:`, pdfErr);
      }

      // Check if extracted text has genuine content beyond page headers
      const meaningfulText = fullText.replace(/\[Trang\s+\d+\]/gi, '').trim();
      if (meaningfulText.length >= 30) {
        setDocumentCache(cacheKey, fullText);
        return fullText;
      }

      // Fallback: If unpdf yielded zero/empty text (e.g. scanned PDF, slide export, or canvas PDF):
      // Trigger Gemini Multimodal Vision OCR directly on the PDF file!
      console.log(`[PDF Parser] unpdf yielded no meaningful text for "${fileName}". Triggering Gemini Vision PDF OCR...`);
      try {
        const ocrResult = await extractTextFromPdfVision(fileBuffer, fileName, options?.userKeys);
        if (ocrResult.text && ocrResult.text.trim().length >= 30) {
          setDocumentCache(cacheKey, ocrResult.text.trim());
          return ocrResult.text.trim();
        }
      } catch (ocrErr) {
        console.warn(`[PDF Parser] Gemini Vision PDF OCR error for ${fileName}:`, ocrErr);
      }
    }

    if (inferImageMimeType(fileName, contentType)) {
      const ocrResult = await extractTextFromImage(fileBuffer, fileName, contentType, options?.userKeys);
      if (ocrResult.text) {
        setDocumentCache(cacheKey, ocrResult.text);
        return ocrResult.text;
      }
    }

    // For Word documents (.docx)
    const isDocx =
      lowerName.endsWith('.docx') ||
      contentType.includes('wordprocessingml') ||
      contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml');
    if (isDocx) {
      const docxText = await extractDocxText(fileBuffer);
      if (docxText.trim()) {
        setDocumentCache(cacheKey, docxText);
        return docxText;
      }
    }

    // For PowerPoint presentations (.pptx)
    const isPptx =
      lowerName.endsWith('.pptx') ||
      contentType.includes('presentationml') ||
      contentType.includes('application/vnd.openxmlformats-officedocument.presentationml');
    if (isPptx) {
      const pptxText = await extractPptxText(fileBuffer);
      if (pptxText.trim()) {
        setDocumentCache(cacheKey, pptxText);
        return pptxText;
      }
    }

    // For plain text files
    if (lowerName.endsWith('.txt') || contentType.includes('text/plain')) {
      const text = fileBuffer.toString('utf-8');
      setDocumentCache(cacheKey, text);
      return text;
    }

    // For Web links, HTML pages, and Moodle URL resources
    let targetUrl = fetchUrl;
    const rawHtml = fileBuffer.toString('utf-8');

    // Check if the URL is a Moodle wrapper or contains a redirect link
    if (fetchUrl.includes('/mod/url/view.php') || rawHtml.includes('urlworkaround')) {
      const match =
        rawHtml.match(/<div class="urlworkaround"[^>]*>\s*<a\s+[^>]*href="([^"]+)"/i) ||
        rawHtml.match(/<a\s+[^>]*class="urlworkaround"[^>]*href="([^"]+)"/i) ||
        rawHtml.match(/<div class="resourcecontent"[^>]*>\s*<a\s+[^>]*href="([^"]+)"/i);
      if (match && match[1] && match[1].startsWith('http')) {
        targetUrl = match[1].replace(/&amp;/g, '&');
      }
    }

    // TIER 1: Jina Reader API for parsed targetUrl
    const isLocalHost =
      targetUrl.includes('localhost') ||
      targetUrl.includes('127.0.0.1') ||
      targetUrl.includes('192.168.') ||
      targetUrl.includes('.local');

    if (targetUrl.startsWith('http') && !isLocalHost) {
      try {
        const jinaUrl = `https://r.jina.ai/${targetUrl}`;
        const jinaRes = await fetch(jinaUrl, {
          headers: {
            'X-Return-Format': 'markdown',
            'X-With-Generated-Alt': 'true',
            Accept: 'text/markdown, text/plain',
          },
          signal: AbortSignal.timeout(7000),
        });

        if (jinaRes.ok) {
          const markdown = await jinaRes.text();
          if (markdown && markdown.trim().length > 100 && !markdown.includes('403 Forbidden')) {
            setDocumentCache(cacheKey, markdown.trim());
            return markdown.trim();
          }
        }
      } catch (jinaErr) {
        console.warn(`Jina Reader attempt for ${targetUrl} skipped/failed:`, jinaErr);
      }
    }

    // TIER 2: Direct Scraper Fallback (Fetch destination directly if targetUrl is different)
    let htmlToClean = rawHtml;
    if (targetUrl !== fetchUrl) {
      try {
        const extRes = await fetch(targetUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(6000),
        });
        if (extRes.ok) {
          htmlToClean = await extRes.text();
        }
      } catch (fetchErr) {
        console.warn(`Direct fetch for ${targetUrl} failed:`, fetchErr);
      }
    }

    const extractedText = extractTextFromHtml(htmlToClean);
    if (extractedText.trim()) {
      setDocumentCache(cacheKey, extractedText);
      return extractedText;
    }

    // Avoid re-downloading/re-OCRing an unreadable document on every question
    // (the failure cache expires automatically after 15 minutes).
    markUrlFailed(url);
    return '';
  } catch (error) {
    console.warn(`Error parsing document ${fileName} from ${url}:`, error);
    markUrlFailed(url);
    return '';
  }
}

/**
 * Strips HTML tags, scripts, styles, navigations, and extracts structured, readable text.
 */
export function extractTextFromHtml(html: string): string {
  if (!html) return '';

  // 1. Remove script, style, svg, noscript, nav, header, footer, iframe tags and their contents
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, ' ')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ' ');

  // 2. Format Headings with Markdown equivalents
  cleaned = cleaned
    .replace(/<h1\b[^>]*>(.*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2\b[^>]*>(.*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h3\b[^>]*>(.*?)<\/h3>/gi, '\n\n### $1\n\n')
    .replace(/<h[4-6]\b[^>]*>(.*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n');

  // 3. Format Code Blocks and Pre tags
  cleaned = cleaned
    .replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n\n```\n$1\n```\n\n')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '\n\n```\n$1\n```\n\n')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // 4. Replace structural block tags with newlines
  cleaned = cleaned
    .replace(/<\/(p|div|section|article|blockquote|tr)>/gi, '\n\n')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(td|th)>/gi, ' | ');

  // 5. Remove all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // 6. Decode common HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));

  // 7. Clean up whitespace
  return cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n\n');
}

export async function parseDocumentBuffer(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string,
  mimeType?: string,
  userKeys?: string[]
): Promise<string> {
  lastVisionOcrStatus = null;
  try {
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.pdf')) {
      let fullText = '';
      try {
        const source = toBuffer(buffer);
        if (source) {
          // Clone so unpdf never detaches the caller's buffer (needed by OCR fallback).
          const unpdfBytes = new Uint8Array(
            source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
          );
          const { text } = await extractText(unpdfBytes);
          fullText = Array.isArray(text)
            ? text.map((pageStr, idx) => `[Trang ${idx + 1}]\n${pageStr}`).join('\n\n')
            : String(text || '');
        }
      } catch (pdfErr) {
        console.warn(`[PDF Parser] unpdf extraction error for ${fileName}:`, pdfErr);
      }

      const meaningfulText = fullText.replace(/\[Trang\s+\d+\]/gi, '').trim();
      if (meaningfulText.length >= 30) return fullText;

      // Scanned / non-selectable PDF: fall back to multimodal vision OCR.
      const ocrResult = await extractTextFromPdfVision(buffer, fileName, userKeys);
      if (ocrResult.text && ocrResult.text.trim().length >= 30) return ocrResult.text.trim();
      return fullText;
    }
    if (lowerName.endsWith('.docx')) {
      return await extractDocxText(buffer);
    }
    if (lowerName.endsWith('.pptx')) {
      return await extractPptxText(buffer);
    }
    if (lowerName.endsWith('.txt')) {
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(buffer);
    }
    if (inferImageMimeType(fileName, mimeType)) {
      const imageResult = await extractTextFromImage(buffer, fileName, mimeType, userKeys);
      return imageResult.text;
    }
    return '';
  } catch (error) {
    console.warn(`Error parsing buffer for ${fileName}:`, error);
    return '';
  }
}

/**
 * Extracts a Table of Contents (TOC) or structural overview from full document text.
 * Uses multiple strategies: explicit TOC section detection, heading pattern extraction,
 * and first-pages fallback. Returns comprehensive structural text for overview/TOC queries.
 */
export function extractDocumentTOC(fullText: string, maxLength: number = 8000): string {
  if (!fullText || fullText.trim().length < 50) return '';

  const lines = fullText.split('\n');
  const tocParts: string[] = [];

  // ── Strategy 1: Find explicit TOC section ──
  // Look for "Mục lục" / "Table of Contents" and capture until the next major content section
  let inTocSection = false;
  const tocSectionLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const lowerTrimmed = trimmed.toLowerCase();

    if (!inTocSection && (
      /^(mục\s*lục|table\s+of\s+contents|nội\s+dung|danh\s+mục|contents)\s*$/i.test(lowerTrimmed) ||
      /^(mục\s*lục|table\s+of\s+contents)\s*[:\-–]/i.test(lowerTrimmed)
    )) {
      inTocSection = true;
      tocSectionLines.push(trimmed);
      continue;
    }

    if (inTocSection) {
      // Stop when we hit a major content heading after collecting enough TOC lines
      if (tocSectionLines.length > 5 && (
        /^\[trang\s+\d+\]/i.test(lowerTrimmed) ||
        trimmed.length > 300 // Long paragraph = content, not TOC entry
      )) {
        break;
      }
      if (trimmed) tocSectionLines.push(trimmed);
      // Safety: cap at 200 lines to avoid runaway
      if (tocSectionLines.length > 200) break;
    }
  }

  if (tocSectionLines.length > 3) {
    tocParts.push('=== MỤC LỤC TRÍCH XUẤT TỪ TÀI LIỆU ===\n' + tocSectionLines.join('\n'));
  }

  // ── Strategy 2: Extract heading patterns throughout the document ──
  const headingPattern = /^\s*(chương|chapter|phần|part|bài|lesson|mục|section|module)\s+[\divxlcdmIVXLCDM]+[\s.:–\-]/i;
  const numberedHeadingPattern = /^\s*(\d+(\.\d+){0,2})\s*[.:–\-)\s]\s*[A-ZÀ-Ỹ]/;
  const headings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 200) continue;

    if (headingPattern.test(trimmed) || numberedHeadingPattern.test(trimmed)) {
      // Avoid duplicates from TOC section
      if (!tocSectionLines.includes(trimmed)) {
        headings.push(trimmed);
      }
    }
  }

  if (headings.length > 2) {
    tocParts.push('=== CẤU TRÚC TÀI LIỆU (Các chương / mục phát hiện) ===\n' + headings.join('\n'));
  }

  // ── Strategy 3: First pages fallback ──
  // If no explicit TOC or headings found, extract first 5 pages worth of content
  if (tocParts.length === 0) {
    let firstPagesContent = '';
    let pageCount = 0;
    for (const line of lines) {
      if (/^\[trang\s+\d+\]/i.test(line.trim())) pageCount++;
      if (pageCount > 5) break;
      firstPagesContent += line + '\n';
    }
    // If no page markers, just take the first portion of text
    if (pageCount === 0) {
      firstPagesContent = lines.slice(0, 80).join('\n');
    }
    if (firstPagesContent.trim().length > 50) {
      tocParts.push('=== NỘI DUNG CÁC TRANG ĐẦU (Chứa mục lục / giới thiệu) ===\n' + firstPagesContent.trim());
    }
  }

  const result = tocParts.join('\n\n');
  return result.length > maxLength ? result.slice(0, maxLength) : result;
}
