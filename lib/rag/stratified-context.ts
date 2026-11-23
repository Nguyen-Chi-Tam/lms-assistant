import { chunkDocument } from '@/lib/rag';

export interface StratifiedContextDoc {
  title: string;
  text: string;
}

export interface StratifiedContextOptions {
  /** Tổng ngân sách ký tự cho toàn bộ ngữ cảnh (mặc định 10.000). */
  budget?: number;
  /** Chủ đề trọng tâm để ưu tiên chunk khớp từ khóa. */
  topic?: string;
}

export interface StratifiedContextResult {
  preparedContext: string;
  totalChars: number;
  budgetPerDoc: number;
  docs: Array<{ title: string; includedChunks: number; usedChars: number }>;
}

/** Bỏ dấu + thường hóa để so khớp từ khóa tiếng Việt ổn định. */
function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreChunk(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const normalized = normalizeForMatch(text);
  let score = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) score += token.length;
  }
  return score;
}

/**
 * Lấy mẫu phân tầng: mỗi tài liệu được tick chọn đều nhận một phần ngân sách
 * như nhau, luôn giữ chunk_0 (mục lục/định nghĩa) rồi mới thêm chunk khớp chủ đề.
 * Trái ngược với Vector Top-K vốn chỉ bốc vài đoạn của 1-2 file.
 */
export function buildStratifiedContext(
  docs: StratifiedContextDoc[],
  options: StratifiedContextOptions = {}
): StratifiedContextResult {
  const budget = Math.max(2_000, Math.min(30_000, options.budget ?? 10_000));
  const validDocs = docs.filter(doc => doc.title && doc.text && doc.text.trim().length > 30);

  if (validDocs.length === 0) {
    return { preparedContext: '', totalChars: 0, budgetPerDoc: 0, docs: [] };
  }

  const budgetPerDoc = Math.floor(budget / validDocs.length);
  const topicTokens = normalizeForMatch(options.topic || '')
    .split(' ')
    .filter(token => token.length >= 3);

  const sections: string[] = [];
  const stats: StratifiedContextResult['docs'] = [];
  let totalChars = 0;

  for (const doc of validDocs) {
    const chunks = chunkDocument(doc.text, doc.title, {
      chunkSize: Math.max(320, Math.min(700, Math.floor(budgetPerDoc / 2) || 500)),
      chunkOverlap: 0,
    });
    if (chunks.length === 0) continue;

    const picked = [chunks[0]];
    let usedChars = chunks[0].text.length;

    const ranked = chunks
      .slice(1)
      .map(chunk => ({
        chunk,
        // Ưu tiên nhẹ các chunk đầu tài liệu (thường là định nghĩa nền tảng).
        score: scoreChunk(chunk.text, topicTokens) + Math.max(0, 4 - chunk.chunkIndex),
      }))
      .sort((a, b) => b.score - a.score);

    for (const { chunk } of ranked) {
      if (usedChars + chunk.text.length > budgetPerDoc) continue;
      picked.push(chunk);
      usedChars += chunk.text.length;
      if (usedChars >= budgetPerDoc * 0.9) break;
    }

    // Trả lại thứ tự đọc tự nhiên để AI không bị rối mạch lập luận.
    picked.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const body = picked.map(chunk => chunk.text.trim()).join('\n\n');
    sections.push(`[${doc.title}]\n${body}`);
    totalChars += body.length + doc.title.length + 3;
    stats.push({ title: doc.title, includedChunks: picked.length, usedChars });
  }

  return {
    preparedContext: sections.join('\n\n'),
    totalChars,
    budgetPerDoc,
    docs: stats,
  };
}

/** Phần chỉ thị prompt riêng cho Hybrid: 70% giáo trình + 30% thực tiễn. */
export const HYBRID_CONTEXT_GUIDANCE = `[CẤU TRÚC NỘI DUNG BẮT BUỘC]
- TẦNG 1 (~70%): Bám sát các trích đoạn giáo trình ở trên. Trình bày chính xác khái niệm, kiến trúc và luận điểm, gắn nhãn nguồn [Tên file] khi cần đối chiếu.
- TẦNG 2 (~30%): Thêm một mục RIÊNG "${'Thực tiễn triển khai & Lưu ý nâng cao'}" với ví dụ thực tế (code/cấu hình), so sánh ưu-nhược điểm và các lưu ý mà slide bài giảng thường lược bỏ. Không lặp lại nội dung TẦNG 1.`;
