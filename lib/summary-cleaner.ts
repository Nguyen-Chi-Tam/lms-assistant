/**
 * Utility to strip citation tags, document reference numbers,
 * and meta-commentary from AI-generated summary content.
 */

export function cleanSummaryText(text: string): string {
  if (!text || typeof text !== 'string') return '';
  let out = text;

  // 1. Meta commentary: "Mặc dù không trực tiếp được đề cập trong tài liệu, ..."
  out = out.replace(/(:\s*|^|\.\s+)[Mm]ặc dù không (?:trực tiếp\s+)?được đề cập trong tài liệu(?: môn học| đã cho)?[,:]?\s*/g, '$1');

  // 2. Meta commentary: "Theo tài liệu môn học, ..." or "Dựa trên tài liệu, ..." or "Tài liệu cho thấy..."
  out = out.replace(/(:\s*|^|\.\s+)(?:[Tt]heo|[Dd]ựa (?:trên|vào)) (?:các\s+)?tài liệu(?: môn học| đã cho| được cung cấp| tham khảo)?[,:]?\s*/g, '$1');
  out = out.replace(/(:\s*|^|\.\s+)[Tt]ài liệu (?:này )?(?:cho thấy|chỉ ra|đề cập rằng|nêu rõ rằng)[,:]?\s*/g, '$1');

  // 3. Parenthetical citations: (tài liệu [8]), (tài liệu 5), (nguồn: tài liệu [1]), (nguồn: tài liệu), etc.
  out = out.replace(/\s*\(\s*(?:nguồn\s*:?\s*|theo\s+|xem\s+(?:thêm\s+)?|tham khảo\s*:?\s*)?tài liệu(?:\s*(?:môn học|đã cho|cung cấp|tham khảo))?(?:\s*\[?\d+\]?)*(?:\s*[,;]\s*(?:tài liệu\s*)?\[?\d+\]?)*\s*\)/gi, '');

  // 4. Dash citations: " - tài liệu [6]", " – tài liệu 4", " - tài liệu tham khảo"
  out = out.replace(/\s*[-–—]\s*(?:theo\s+|xem\s+|tham khảo\s+)?tài liệu(?:\s*(?:môn học|đã cho|cung cấp|tham khảo))?(?:\s*\[?\d+\]?)?/gi, '');

  // 5. Standalone bracket citations: "[8]", "[tài liệu 5]"
  out = out.replace(/\s*\[\s*(?:tài liệu\s*)?\d+\s*\]/gi, '');

  // 6. Clean dangling empty parens, spaces, and punctuation
  out = out.replace(/\(\s*\)/g, '');
  out = out.replace(/\s{2,}/g, ' ');
  out = out.replace(/\s+([,.:;?!])/g, '$1');
  out = out.trim();

  // Capitalize first character if made lowercase after removing sentence starter
  if (out.length > 0 && /^[a-zà-ỹ]/.test(out)) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }

  return out;
}

export function cleanSummaryData<T extends { title?: string; overview?: string; points?: string[] }>(summary: T): T {
  if (!summary) return summary;
  return {
    ...summary,
    title: summary.title ? cleanSummaryText(summary.title) : summary.title,
    overview: summary.overview ? cleanSummaryText(summary.overview) : summary.overview,
    points: Array.isArray(summary.points) ? summary.points.map(cleanSummaryText) : summary.points,
  };
}

