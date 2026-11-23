import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { toPng } from 'html-to-image';
import { cleanSummaryData } from '@/lib/summary-cleaner';

export async function exportSummaryToDocx(
  rawSummary: { title: string; overview: string; points: string[] },
  courseTitle: string
) {
  const summary = cleanSummaryData(rawSummary);
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: summary.title || `BẢN TÓM TẮT HỌC TẬP - ${courseTitle.toUpperCase()}`,
            heading: HeadingLevel.TITLE,
            spacing: { after: 200 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Môn học: ${courseTitle}`,
                italics: true,
                color: '666666',
              }),
            ],
            spacing: { after: 300 },
          }),
          new Paragraph({
            text: 'I. TỔNG QUAN NỘI DUNG',
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 120 },
          }),
          new Paragraph({
            text: summary.overview || 'Không có mô tả tổng quan.',
            spacing: { after: 300 },
          }),
          new Paragraph({
            text: 'II. CÁC NỘI DUNG & Ý CHÍNH TRỌNG TÂM',
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 120 },
          }),
          ...(summary.points || []).map(
            point =>
              new Paragraph({
                text: point,
                bullet: { level: 0 },
                spacing: { after: 100 },
              })
          ),
          new Paragraph({
            children: [
              new TextRun({
                text: '\n---\nTài liệu được tổng hợp tự động bởi LMS Assistant AI.',
                italics: true,
                size: 18,
                color: '888888',
              }),
            ],
            spacing: { before: 400 },
          }),
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const sanitizedName = (summary.title || courseTitle || 'Tom_Tat')
    .replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]/g, '_')
    .slice(0, 40);
  a.download = `${sanitizedName}_TomTat.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface ExportPngOptions {
  cropToNodes?: boolean;
  padding?: number;
  backgroundColor?: string;
  pixelRatio?: number;
}

export async function exportElementToPng(
  element: HTMLElement,
  filename: string,
  options?: ExportPngOptions
) {
  try {
    const padding = options?.padding ?? 40;
    const backgroundColor = options?.backgroundColor ?? '#0c0a1f';
    const pixelRatio = options?.pixelRatio ?? 2;

    let width: number | undefined;
    let height: number | undefined;
    let customStyle: Record<string, string> | undefined;

    if (options?.cropToNodes) {
      const nodeElements = element.querySelectorAll<HTMLElement>('.notebook-node');
      if (nodeElements.length > 0) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        nodeElements.forEach(el => {
          const left = el.offsetLeft;
          const top = el.offsetTop;
          const elWidth = el.offsetWidth;
          const elHeight = el.offsetHeight;

          if (left < minX) minX = left;
          if (top < minY) minY = top;
          if (left + elWidth > maxX) maxX = left + elWidth;
          if (top + elHeight > maxY) maxY = top + elHeight;
        });

        if (minX !== Infinity && maxX > minX && minY !== Infinity && maxY > minY) {
          const contentWidth = maxX - minX;
          const contentHeight = maxY - minY;
          const exportWidth = Math.ceil(contentWidth + padding * 2);
          const exportHeight = Math.ceil(contentHeight + padding * 2);

          width = exportWidth;
          height = exportHeight;
          customStyle = {
            transform: `translate(${-minX + padding}px, ${-minY + padding}px) scale(1)`,
            transformOrigin: '0 0',
            width: `${exportWidth}px`,
            height: `${exportHeight}px`,
            minHeight: `${exportHeight}px`,
            left: '0px',
            top: '0px',
            margin: '0px',
          };
        }
      }
    }

    const dataUrl = await toPng(element, {
      quality: 0.98,
      backgroundColor,
      pixelRatio,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(customStyle ? { style: customStyle } : {}),
    });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${filename}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (error) {
    console.error('Failed to export element to PNG:', error);
    throw error;
  }
}

/**
 * Copies rich HTML formatted specifically for Microsoft Word / Google Docs.
 * Preserves tables, headers, lists, bold text, and styles when pasted with Ctrl+V into Word.
 */
export async function copyRichHtmlForWord(element: HTMLElement, fallbackPlainText: string): Promise<boolean> {
  try {
    const clone = element.cloneNode(true) as HTMLElement;

    // Remove buttons, toolbars, and citations from the copy payload
    clone.querySelectorAll('.message-toolbar, button, .citations, .bot-avatar').forEach(el => el.remove());

    // Format all tables with borders and styles that Word's HTML importer expects
    clone.querySelectorAll('table').forEach(tbl => {
      tbl.setAttribute('border', '1');
      tbl.setAttribute('cellpadding', '6');
      tbl.setAttribute('cellspacing', '0');
      tbl.style.borderCollapse = 'collapse';
      tbl.style.width = '100%';
      tbl.style.border = '1px solid #94a3b8';
      tbl.style.margin = '12pt 0';
    });

    clone.querySelectorAll('th').forEach(th => {
      th.setAttribute('bgcolor', '#f1f5f9');
      th.style.backgroundColor = '#f1f5f9';
      th.style.fontWeight = 'bold';
      th.style.border = '1px solid #94a3b8';
      th.style.padding = '6pt 8pt';
      th.style.textAlign = 'left';
      th.style.color = '#0f172a';
    });

    clone.querySelectorAll('td').forEach(td => {
      td.style.border = '1px solid #cbd5e1';
      td.style.padding = '6pt 8pt';
      td.style.verticalAlign = 'top';
    });

    clone.querySelectorAll('h1, h2, h3, h4').forEach(h => {
      (h as HTMLElement).style.color = '#1e1b4b';
      (h as HTMLElement).style.fontWeight = 'bold';
      (h as HTMLElement).style.marginTop = '12pt';
      (h as HTMLElement).style.marginBottom = '4pt';
    });

    clone.querySelectorAll('ul, ol').forEach(list => {
      (list as HTMLElement).style.margin = '6pt 0';
      (list as HTMLElement).style.paddingLeft = '20pt';
    });

    clone.querySelectorAll('li').forEach(li => {
      (li as HTMLElement).style.marginBottom = '3pt';
    });

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; font-size: 11pt; color: #1e293b; line-height: 1.5; }
  table { border-collapse: collapse; width: 100%; border: 1px solid #94a3b8; }
  th { background-color: #f1f5f9; font-weight: bold; border: 1px solid #94a3b8; padding: 6pt 8pt; text-align: left; }
  td { border: 1px solid #cbd5e1; padding: 6pt 8pt; vertical-align: top; }
  h1, h2, h3, h4 { color: #1e1b4b; font-weight: bold; }
  ul, ol { margin: 6pt 0; padding-left: 20pt; }
  li { margin-bottom: 3pt; }
  strong, b { font-weight: bold; }
  code { font-family: Consolas, monospace; background-color: #f1f5f9; padding: 1pt 3pt; }
</style>
</head>
<body>
${clone.innerHTML}
</body>
</html>`;

    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blobHtml = new Blob([fullHtml], { type: 'text/html' });
      const blobText = new Blob([fallbackPlainText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blobHtml,
          'text/plain': blobText,
        }),
      ]);
      return true;
    }
  } catch (err) {
    console.warn('Rich HTML clipboard write failed, falling back to plaintext:', err);
  }

  // Fallback to plain text
  await navigator.clipboard.writeText(fallbackPlainText);
  return false;
}

export async function exportChatMessageToDocx(text: string, courseTitle: string) {
  const lines = text.split('\n');
  const paragraphs: Paragraph[] = [
    new Paragraph({
      text: `TRỢ LÝ HỌC TẬP AI - ${courseTitle.toUpperCase()}`,
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 200 },
    }),
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      paragraphs.push(new Paragraph({ spacing: { after: 100 } }));
    } else if (trimmed.startsWith('# ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    } else if (trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 80 } }));
    } else if (trimmed.startsWith('### ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_3, spacing: { before: 140, after: 60 } }));
    } else if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      paragraphs.push(new Paragraph({ text: trimmed.slice(2), bullet: { level: 0 }, spacing: { after: 80 } }));
    } else {
      paragraphs.push(new Paragraph({ text: trimmed, spacing: { after: 100 } }));
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const sanitizedName = courseTitle.replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]/g, '_').slice(0, 40);
  a.download = `Phan_Hoi_AI_${sanitizedName}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export * from './pptx-export';



