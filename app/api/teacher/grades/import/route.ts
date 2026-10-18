import { NextResponse } from 'next/server';
import * as xlsx from 'xlsx';
import { getGeminiClient, GEMINI_MODEL } from '@/models/gemini';
import { getOpenAIClient } from '@/models/openai';

export interface ExtractedGradeItem {
  identifier: string;
  name?: string;
  score: number;
  feedback?: string;
}

/**
 * Heuristics to find columns in 2D table or object array from Excel
 */
function parseExcelData(buffer: Buffer): ExtractedGradeItem[] {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  if (!worksheet) return [];

  // Parse as array of rows
  const rows = xlsx.utils.sheet_to_json<Array<string | number>>(worksheet, { header: 1 });
  if (!rows || rows.length === 0) return [];

  // Look for header row
  let headerIndex = -1;
  let idCol = -1;
  let nameCol = -1;
  let scoreCol = -1;
  let feedbackCol = -1;

  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] ?? '').trim().toLowerCase();
      if (!cell) continue;

      if (idCol === -1 && (cell.includes('email') || cell.includes('mssv') || cell.includes('mã số') || cell.includes('mã sv') || cell.includes('username') || cell.includes('mã'))) {
        idCol = c;
      }
      if (nameCol === -1 && (cell.includes('họ tên') || cell.includes('họ và tên') || cell.includes('tên') || cell.includes('fullname') || cell.includes('sinh viên'))) {
        nameCol = c;
      }
      if (scoreCol === -1 && (cell.includes('điểm') || cell.includes('score') || cell.includes('grade') || cell.includes('kết quả'))) {
        scoreCol = c;
      }
      if (feedbackCol === -1 && (cell.includes('nhận xét') || cell.includes('ghi chú') || cell.includes('feedback') || cell.includes('note'))) {
        feedbackCol = c;
      }
    }

    if (scoreCol !== -1 && (idCol !== -1 || nameCol !== -1)) {
      headerIndex = r;
      break;
    }
  }

  const results: ExtractedGradeItem[] = [];

  if (headerIndex !== -1 && scoreCol !== -1) {
    for (let r = headerIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      const rawScore = row[scoreCol];
      if (rawScore === undefined || rawScore === null || rawScore === '') continue;

      const numScore = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore).replace(',', '.'));
      if (isNaN(numScore)) continue;

      const rawId = idCol !== -1 ? String(row[idCol] ?? '').trim() : '';
      const rawName = nameCol !== -1 ? String(row[nameCol] ?? '').trim() : '';
      const rawFeedback = feedbackCol !== -1 ? String(row[feedbackCol] ?? '').trim() : '';

      if (!rawId && !rawName) continue;

      results.push({
        identifier: rawId || rawName,
        name: rawName || rawId,
        score: Math.min(100, Math.max(0, numScore)),
        feedback: rawFeedback,
      });
    }
  }

  // Fallback: if header detection failed, try scanning all rows for patterns
  if (results.length === 0) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;

      let score: number | null = null;
      let emailOrId = '';
      let name = '';

      for (let c = 0; c < row.length; c++) {
        const val = row[c];
        if (val === undefined || val === null) continue;
        const strVal = String(val).trim();

        // Check if email
        if (strVal.includes('@') && !emailOrId) {
          emailOrId = strVal;
        } else if (typeof val === 'number' && score === null && val >= 0 && val <= 100) {
          score = val;
        } else if (score === null && /^[0-9]+([.,][0-9]+)?$/.test(strVal)) {
          const parsed = parseFloat(strVal.replace(',', '.'));
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
            score = parsed;
          }
        } else if (strVal.length > 2 && !name && !strVal.match(/^[0-9]+$/)) {
          name = strVal;
        }
      }

      if (score !== null && (emailOrId || name)) {
        results.push({
          identifier: emailOrId || name,
          name: name || emailOrId,
          score,
        });
      }
    }
  }

  return results;
}

/**
 * Extract grades from handwritten/printed photos or PDFs using Multimodal AI
 */
async function extractGradesFromMultimodal(
  base64Data: string,
  mimeType: string
): Promise<ExtractedGradeItem[]> {
  const prompt = `Bạn là trợ lý giảng viên chuyên trích xuất bảng điểm lớp học.
Hãy trích xuất toàn bộ danh sách sinh viên và điểm số từ tài liệu/ảnh này.

QUY TẮC BẮT BUỘC:
1. Trả về định dạng JSON DUY NHẤT:
{
  "grades": [
    {
      "identifier": "Email, MSSV, hoặc Username (nếu không có thì ghi Họ và Tên sinh viên)",
      "name": "Họ và tên đầy đủ của sinh viên",
      "score": 8.5,
      "feedback": ""
    }
  ]
}
2. Điểm số ("score") phải là số thực (ví dụ 10, 8.5, 7.0, 3.0), không để chuỗi ký tự.
3. Nếu là bảng điểm viết tay hoặc mờ, hãy phân tích kỹ từng dòng, đảm bảo không bỏ sót sinh viên nào.
4. Nếu trong tài liệu/ảnh KHÔNG có cột nhận xét hoặc nhận xét để trống, BẮT BUỘC đặt "feedback": "" (chuỗi rỗng), TUYỆT ĐỐI KHÔNG TỰ BỊA NHẬN XÉT.
5. Tuyệt đối không trả về giải thích, chỉ trả về JSON hợp lệ.`;

  // 1. Try Gemini
  const gemini = getGeminiClient();
  if (gemini) {
    try {
      const response = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
              { text: prompt },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const text = response.text?.trim() || '';
      if (text) {
        const parsed = JSON.parse(text);
        const list = parsed.grades || (Array.isArray(parsed) ? parsed : []);
        if (Array.isArray(list) && list.length > 0) {
          return list.map((item: { identifier?: string; name?: string; score?: number | string; feedback?: string }) => ({
            identifier: String(item.identifier || item.name || '').trim(),
            name: String(item.name || item.identifier || '').trim(),
            score: typeof item.score === 'number' ? item.score : parseFloat(String(item.score || 0).replace(',', '.')),
            feedback: item.feedback ? String(item.feedback) : undefined,
          }));
        }
      }
    } catch (err) {
      console.warn('Gemini multimodal extraction error:', err);
    }
  }

  // 2. Try OpenAI Vision if available
  const openai = getOpenAIClient();
  if (openai && mimeType.startsWith('image/')) {
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Data}` },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const text = completion.choices[0]?.message?.content?.trim() || '';
      if (text) {
        const parsed = JSON.parse(text);
        const list = parsed.grades || (Array.isArray(parsed) ? parsed : []);
        if (Array.isArray(list) && list.length > 0) {
          return list.map((item: { identifier?: string; name?: string; score?: number | string; feedback?: string }) => ({
            identifier: String(item.identifier || item.name || '').trim(),
            name: String(item.name || item.identifier || '').trim(),
            score: typeof item.score === 'number' ? item.score : parseFloat(String(item.score || 0).replace(',', '.')),
            feedback: item.feedback ? String(item.feedback) : undefined,
          }));
        }
      }
    } catch (err) {
      console.warn('OpenAI vision extraction error:', err);
    }
  }

  return [];
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';

    // A. Multipart Form Data (File Upload)
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      const rawText = (formData.get('rawText') as string) || '';

      if (rawText && !file) {
        // Parse raw text paste
        const lines = rawText.split('\n');
        const grades: ExtractedGradeItem[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^([^,:\t\-]+?)\s*[,:\t\-]+\s*([0-9]+(?:[.,][0-9]+)?)\s*$/);
          if (match) {
            grades.push({
              identifier: match[1].trim(),
              name: match[1].trim(),
              score: parseFloat(match[2].replace(',', '.')),
            });
          }
        }
        return NextResponse.json({ success: true, count: grades.length, grades });
      }

      if (!file) {
        return NextResponse.json({ error: 'Vui lòng chọn file bảng điểm.' }, { status: 400 });
      }

      const fileName = file.name.toLowerCase();
      const fileBuffer = Buffer.from(await file.arrayBuffer());

      // 1. Excel / CSV files
      if (
        fileName.endsWith('.xlsx') ||
        fileName.endsWith('.xls') ||
        fileName.endsWith('.csv') ||
        fileName.endsWith('.tsv') ||
        file.type.includes('spreadsheet') ||
        file.type.includes('excel') ||
        file.type.includes('csv')
      ) {
        const grades = parseExcelData(fileBuffer);
        return NextResponse.json({
          success: true,
          method: 'xlsx',
          count: grades.length,
          grades,
        });
      }

      // 2. Images or PDF documents (Multimodal AI)
      let mimeType = file.type || 'image/jpeg';
      if (fileName.endsWith('.png')) mimeType = 'image/png';
      if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) mimeType = 'image/jpeg';
      if (fileName.endsWith('.webp')) mimeType = 'image/webp';
      if (fileName.endsWith('.pdf')) mimeType = 'application/pdf';

      const base64Data = fileBuffer.toString('base64');
      const grades = await extractGradesFromMultimodal(base64Data, mimeType);

      return NextResponse.json({
        success: true,
        method: 'multimodal_ai',
        count: grades.length,
        grades,
      });
    }

    // B. JSON Body (Base64 file or raw text)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await request.json()) as any;
    if (body.base64 && body.mimeType) {
      const grades = await extractGradesFromMultimodal(body.base64, body.mimeType);
      return NextResponse.json({
        success: true,
        method: 'multimodal_ai',
        count: grades.length,
        grades,
      });
    }

    if (body.rawText) {
      const lines = String(body.rawText).split('\n');
      const grades: ExtractedGradeItem[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^([^,:\t\-]+?)\s*[,:\t\-]+\s*([0-9]+(?:[.,][0-9]+)?)\s*$/);
        if (match) {
          grades.push({
            identifier: match[1].trim(),
            name: match[1].trim(),
            score: parseFloat(match[2].replace(',', '.')),
          });
        }
      }
      return NextResponse.json({ success: true, count: grades.length, grades });
    }

    return NextResponse.json({ error: 'Định dạng dữ liệu không hợp lệ.' }, { status: 400 });
  } catch (error) {
    console.error('Grades import route error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi khi trích xuất điểm.' },
      { status: 500 }
    );
  }
}
