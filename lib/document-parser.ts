import { extractText } from 'unpdf';
import JSZip from 'jszip';

const OCR_PROMPT = `Bạn là hệ thống Multimodal Vision OCR học thuật cao cấp. Hãy nhận diện và chép lại toàn bộ văn bản nhìn thấy trong ảnh theo đúng cấu trúc trực quan:
1. Thấu hiểu ngữ cảnh, bóc tách cấu trúc chính xác tuyệt đối (giữ nguyên tiêu đề, công thức toán học LaTeX, danh sách và bảng biểu).
2. ĐẶC BIỆT NẾU ẢNH LÀ BẢNG ĐIỂM, SỔ THEO DÕI, DANH SÁCH SINH VIÊN HOẶC ĐIỂM SỐ: Bắt buộc định dạng thành Bảng Markdown chuẩn với đầy đủ các cột (STT, Mã sinh viên, Họ và tên, Điểm số, Đánh giá/Ghi chú) để dữ liệu không bị lệch hàng lệch cột.
3. Không thêm lời giải thích cá nhân, không thêm lời chào, không suy đoán phần bị che khuất. Nếu không có chữ, trả về chuỗi rỗng.`;

function inferImageMimeType(fileName: string, supplied?: string): string | null {
  if (supplied?.startsWith('image/')) return supplied;
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const types: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return ext ? types[ext] || null : null;
}

/**
 * Vision OCR for image-only study material.  The image stays request-local:
 * extracted text, not its base64 payload, is the only value returned to RAG.
 */
export async function extractTextFromImage(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string,
  mimeType?: string
): Promise<string> {
  const imageMime = inferImageMimeType(fileName, mimeType);
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!imageMime || bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return '';
  const base64 = Buffer.from(bytes).toString('base64');

  // Gemini is the primary multimodal OCR path; OpenAI Vision is a safe fallback.
  try {
    const { getGeminiClient, GEMINI_MODEL } = await import('@/models/gemini');
    const gemini = getGeminiClient();
    if (gemini) {
      const response = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: OCR_PROMPT }, { inlineData: { mimeType: imageMime, data: base64 } }] }],
        config: { temperature: 0, maxOutputTokens: 4096 },
      });
      const text = response.text?.trim();
      if (text) return text;
    }
  } catch (err) {
    console.warn('Gemini Vision OCR unavailable:', err);
  }

  try {
    const { getOpenAIClient } = await import('@/models/openai');
    const openai = getOpenAIClient();
    if (openai) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: `data:${imageMime};base64,${base64}`, detail: 'high' } },
        ] }],
      });
      return completion.choices[0]?.message?.content?.trim() || '';
    }
  } catch (err) {
    console.warn('OpenAI Vision OCR unavailable:', err);
  }
  return '';
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
  options?: { authToken?: string }
): Promise<string> {
  const cacheKey = `${fileName}::${url}`;
  if (documentTextCache.has(cacheKey)) {
    return documentTextCache.get(cacheKey)!;
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
    const arrayBuffer = await response.arrayBuffer();

    const lowerName = fileName.toLowerCase();
    const isPdf =
      lowerName.endsWith('.pdf') ||
      contentType.includes('application/pdf') ||
      fetchUrl.toLowerCase().includes('.pdf');

    if (isPdf) {
      const { text } = await extractText(new Uint8Array(arrayBuffer));
      let fullText = '';
      if (Array.isArray(text)) {
        fullText = text.map((pageStr, idx) => `[Trang ${idx + 1}]\n${pageStr}`).join('\n\n');
      } else {
        fullText = String(text || '');
      }
      if (fullText.trim()) {
        setDocumentCache(cacheKey, fullText);
        return fullText;
      }
    }

    if (inferImageMimeType(fileName, contentType)) {
      const ocrText = await extractTextFromImage(arrayBuffer, fileName, contentType);
      if (ocrText) {
        setDocumentCache(cacheKey, ocrText);
        return ocrText;
      }
    }

    // For Word documents (.docx)
    const isDocx =
      lowerName.endsWith('.docx') ||
      contentType.includes('wordprocessingml') ||
      contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml');
    if (isDocx) {
      const docxText = await extractDocxText(arrayBuffer);
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
      const pptxText = await extractPptxText(arrayBuffer);
      if (pptxText.trim()) {
        setDocumentCache(cacheKey, pptxText);
        return pptxText;
      }
    }

    // For plain text files
    if (lowerName.endsWith('.txt') || contentType.includes('text/plain')) {
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(arrayBuffer);
      setDocumentCache(cacheKey, text);
      return text;
    }

    // For Web links, HTML pages, and Moodle URL resources
    let targetUrl = fetchUrl;
    const decoder = new TextDecoder('utf-8');
    const rawHtml = decoder.decode(arrayBuffer);

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

    return '';
  } catch (error) {
    console.warn(`Error parsing document ${fileName} from ${url}:`, error);
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

export async function parseDocumentBuffer(buffer: ArrayBuffer | Uint8Array, fileName: string, mimeType?: string): Promise<string> {
  try {
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.pdf')) {
      const { text } = await extractText(new Uint8Array(buffer));
      if (Array.isArray(text)) {
        return text.map((pageStr, idx) => `[Trang ${idx + 1}]\n${pageStr}`).join('\n\n');
      }
      return String(text || '');
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
      return await extractTextFromImage(buffer, fileName, mimeType);
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
