import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';

interface WrongQuestion {
  q: string;
  type?: string;
  choices?: string[];
  answer?: number | string;
  answers?: number[] | string[];
  /** Human-readable label sent by the client ("B. ...", "Đúng", "Sai"). */
  userAnswer: string;
  /** Human-readable correct answer; falls back to formatting "answer". */
  correctAnswer?: string;
  explanation?: string;
}

function formatUserAnswer(item: WrongQuestion): string {
  const raw = String(item.userAnswer ?? '').trim();
  if (!raw) return '(chưa trả lời)';
  // Already a readable label from the client.
  if (/^[A-Da-d][.)]/.test(raw) || raw === 'Đúng' || raw === 'Sai') return raw;

  const index = Number(raw);
  if (!Number.isInteger(index)) return raw;
  if (item.type === 'true_false') {
    if (index === 0) return 'Đúng';
    if (index === 1) return 'Sai';
    return raw;
  }
  if (item.choices && item.choices[index]) {
    return `${String.fromCharCode(65 + index)}. ${item.choices[index]}`;
  }
  return raw;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      courseName?: string;
      courseId?: number;
      userId?: number;
      total?: number;
      wrongCount?: number;
      wrongQuestions?: WrongQuestion[];
    };

    const wrong = Array.isArray(body.wrongQuestions) ? body.wrongQuestions : [];
    if (wrong.length === 0) {
      return NextResponse.json({ error: 'Không có câu hỏi sai để phân tích.' }, { status: 400 });
    }

    const scoreLine = body.total ? `${wrong.length}/${body.total}` : String(wrong.length);

    const summary = wrong
      .map(
        (item, idx) => `[Câu ${idx + 1}]
- Câu hỏi: ${item.q}
- Loại: ${item.type === 'true_false' ? 'Đúng/Sai' : 'Trắc nghiệm 4 lựa chọn'}
${item.choices ? `- Các lựa chọn: ${item.choices.map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`).join(', ')}` : ''}
- Đáp án đúng: ${item.correctAnswer || formatAnswer(item)}
- Sinh viên đã chọn: ${formatUserAnswer(item)}
${item.explanation ? `- Giải thích từ tài liệu: ${item.explanation}` : ''}`
      )
      .join('\n\n');

    const prompt = `Bạn là Cố vấn Học tập Thích ứng (Adaptive Learning Tutor). Dưới đây là ${scoreLine} câu hỏi check-in nhanh mà sinh viên trả lời chưa đúng trên khóa học "${body.courseName || 'Khóa học'}":

DANH SÁCH CÂU HỎI SINH VIÊN TRẢ LỜI CHƯA ĐÚNG:
${summary}

YÊU CẦU: Hãy phân tích ngắn gọn (2-3 đoạn, tối đa 280 từ), tập trung đúng các câu chưa đúng. Với mỗi câu, hãy:
1. Nêu tên khái niệm/thuật ngữ cụ thể bị nhầm (không gọi chung chung là "kiến thức nền").
2. Giải thích bản chất của khái niệm đó bằng 1-2 câu ngắn, dễ hiểu, dựa trên giải thích từ tài liệu.
3. Đưa ra một hành động ôn tập cụ thể để khắc phục lỗ hổng đó.
Không lặp lại nguyên văn toàn bộ câu hỏi.

Trả về đoạn văn nhận xét bằng tiếng Việt, rõ ràng, định hướng và không dùng markdown.`;

    let feedback = '';
    try {
      const aiResult = await generateText(undefined, {
        system:
          'Bạn là Cố vấn Học tập Thích ứng chuyên sâu về Sư phạm và Khảo thí. Luôn phân tích chính xác nguyên nhân sai sót và đề xuất giải pháp trọng tâm bằng CHÍNH XÁC ngôn ngữ (Tiếng Việt). Trả về đoạn văn nhận xét bằng tiếng Việt, rõ ràng, định hướng và không dùng markdown.',
        userPrompt: prompt,
        userId: body.userId ? Number(body.userId) : undefined,
        temperature: 0.3,
        jsonMode: false,
        taskCategory: 'complex',
      });

      feedback = aiResult.text?.trim() || '';
    } catch (aiErr) {
      console.warn('Quick feedback AI error:', aiErr);
    }

    if (!feedback) {
      feedback = 'Các câu hỏi bạn chưa đúng phản ánh một vài lỗ hổng khái niệm. Hãy xem lại phần giải thích của từng câu và ôn lại các khái niệm nền trước khi học tiếp.';
    }

    return NextResponse.json({ feedback });
  } catch (error) {
    console.error('Error in /api/quiz/analysis/quick-feedback:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Có lỗi khi tạo nhận xét từ AI.' },
      { status: 500 }
    );
  }
}

function formatAnswer(item: WrongQuestion): string {
  if (item.type === 'true_false') {
    const ans = typeof item.answer === 'number' ? item.answer : 0;
    return ans === 0 ? 'Đúng' : 'Sai';
  }
  if (typeof item.answer === 'number' && item.choices) {
    return String(item.choices[item.answer] ?? item.answer);
  }
  if (Array.isArray(item.answers)) {
    return item.answers.map(a => String(a)).join(', ');
  }
  return String(item.answer ?? '');
}