import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';
import { convertQuestionsToMoodleXml, type QuizQuestionItem } from '@/app/lib/moodle-xml';
import { parseDocumentFromUrl } from '@/lib/document-parser';
import { retrieveRelevantChunks, formatChunksForPrompt } from '@/lib/rag';
import { getPersonalMaterials } from '@/lib/firebase-data';
import { stripFluff } from '@/lib/anti-fluff';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      topic?: string;
      course?: string;
      courseId?: string | number;
      sources?: Array<{ name: string; url?: string }>;
      documentText?: string;
      count?: number;
      difficulty?: 'easy' | 'normal' | 'hard';
      questionType?: 'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer' | 'mixed';
      questionTypes?: Array<'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer'>;
      allowExternalSource?: boolean;
      ragMode?: 'strict' | 'hybrid' | 'creative';
      model?: string;
    };

    const allKnownTypes: Array<'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer'> = [
      'multiple_choice',
      'true_false',
      'multiple_select',
      'matching',
      'short_answer',
    ];

    let selectedTypes: Array<'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer'> = [];
    if (Array.isArray(body.questionTypes) && body.questionTypes.length > 0) {
      selectedTypes = body.questionTypes.filter(t => allKnownTypes.includes(t));
    }

    if (selectedTypes.length === 0) {
      if (body.questionType === 'mixed') {
        selectedTypes = [...allKnownTypes];
      } else if (body.questionType && allKnownTypes.includes(body.questionType as any)) {
        selectedTypes = [body.questionType as any];
      } else {
        selectedTypes = [...allKnownTypes];
      }
    }

    const count = Math.min(100, Math.max(1, typeof body.count === 'number' ? body.count : 10));
    const difficulty = body.difficulty || 'normal';
    const questionType = body.questionType || (selectedTypes.length === 1 ? selectedTypes[0] : 'mixed');
    const topic = body.topic || 'Kiểm tra kiến thức môn học';
    const ragMode: 'strict' | 'hybrid' | 'creative' =
      body.ragMode || (body.allowExternalSource ? 'creative' : 'hybrid');
    const allowExternalSource = ragMode === 'creative';

    const rawDocs: Array<{ title: string; text: string }> = [];

    if (body.documentText?.trim()) {
      rawDocs.push({ title: 'Tài liệu cung cấp', text: body.documentText.trim() });
    }

    // 1. Gather documents from DB if courseId is available
    const moodleCourseId = Number(body.courseId) || undefined;
    if (moodleCourseId) {
      try {
        const mats = await getPersonalMaterials({ moodleCourseId, limit: 5 });
        if (mats) {
          for (const m of mats) {
            if (m.storage_url) {
              try {
                const text = await parseDocumentFromUrl(String(m.storage_url), String(m.title || 'Tài liệu'));
                if (text && text.length > 50) rawDocs.push({ title: String(m.title || 'Tài liệu'), text });
              } catch {
                // ignore unavailable material
              }
            }
          }
        }
      } catch (firebaseError) {
        console.warn('Firebase fetch error in teacher quiz generate:', firebaseError);
      }
    }

    // 2. Fetch URLs from sources if provided
    if (body.sources && body.sources.length > 0) {
      for (const s of body.sources.slice(0, 5)) {
        if (s.url) {
          try {
            const parsed = await parseDocumentFromUrl(s.url, s.name);
            if (parsed && parsed.trim()) {
              rawDocs.push({ title: s.name, text: parsed });
            }
          } catch {
            // ignore
          }
        }
      }
    }

    if (ragMode === 'strict' && rawDocs.length === 0) {
      return NextResponse.json(
        {
          error:
            'Chế độ Bám sát tài liệu (Strict RAG) yêu cầu tài liệu môn học. Hiện chưa có tài liệu nào được cung cấp. Vui lòng cung cấp tài liệu hoặc chuyển sang chế độ Hybrid / Creative.',
        },
        { status: 400 }
      );
    }

    let context = '';
    if (rawDocs.length > 0) {
      try {
        const relevantChunks = await retrieveRelevantChunks(topic, rawDocs, {
          topK: 10,
          maxTotalChars: 22000,
          minSimilarity: 0.15,
        });
        if (relevantChunks.length > 0) {
          context = formatChunksForPrompt(relevantChunks);
        } else {
          context = rawDocs.map((d, i) => `[TÀI LIỆU ${i + 1}: ${d.title}]\n${d.text.slice(0, 5000)}`).join('\n\n');
        }
      } catch {
        context = rawDocs.map((d, i) => `[TÀI LIỆU ${i + 1}: ${d.title}]\n${d.text.slice(0, 5000)}`).join('\n\n');
      }
    }

    let difficultyGuide = 'ĐỘ KHÓ: TRUNG BÌNH (Cân đối lý thuyết và bài tập tư duy).';
    if (difficulty === 'easy') {
      difficultyGuide = 'ĐỘ KHÓ: DỄ (Nhận biết định nghĩa, khái niệm căn bản, rõ ràng).';
    } else if (difficulty === 'hard') {
      difficultyGuide = 'ĐỘ KHÓ: KHÓ / NÂNG CAO (Câu hỏi vận dụng cao, bẫy trắc nghiệm tinh vi, phân tích tình huống thực tế sâu sắc).';
    }

    const typeDescriptions: Record<string, string> = {
      multiple_choice: '1. TRẮC NGHIỆM 4 LỰA CHỌN (Single Choice): "type": "multichoice", "options": đúng 4 phương án, "correctAnswerIndex": số nguyên 0..3 (1 đáp án đúng duy nhất).',
      true_false: '2. ĐÚNG / SAI (True/False): "type": "truefalse", "options": ["Đúng", "Sai"], "correctAnswerIndex": 0 nếu Đúng hoặc 1 nếu Sai.',
      multiple_select: '3. CHỌN NHIỀU ĐÁP ÁN (Multiple Select): "type": "multiselect", "options": 4-5 phương án, "correctAnswerIndices": mảng 2 hoặc 3 số nguyên đúng (ví dụ [0, 2] hoặc [1, 2, 3]). BẮT BUỘC chỉ có 2 hoặc 3 đáp án đúng, TUYỆT ĐỐI KHÔNG chọn tất cả và KHÔNG chọn chỉ 1.',
      matching: '4. NỐI CẶP TƯƠNG ỨNG (Matching): "type": "matching", "questionText": "Nội dung câu hỏi nối cặp...", "pairs": mảng 3 đến 5 cặp ghép đúng [{"left": "Khái niệm A", "right": "Đặc tính tương ứng A"}, ...]. Vế phải phải tương ứng chuẩn xác với vế trái.',
      short_answer: '5. TRẢ LỜI NGẮN (Short Answer): "type": "shortanswer", "questionText": "Nội dung câu hỏi yêu cầu điền từ/thuật ngữ ngắn...", "acceptedAnswers": mảng 1 đến 3 biến thể đáp án đúng (ví dụ ["TCP", "Transmission Control Protocol"]).',
    };

    let typeGuide = '';
    if (selectedTypes.length === 1) {
      typeGuide = `LOẠI CÂU HỎI BẮT BUỘC (100%): Hãy tạo 100% câu hỏi theo đúng định dạng sau:\n${typeDescriptions[selectedTypes[0]]}`;
    } else {
      typeGuide = `LOẠI CÂU HỎI: HÃY PHÂN BỔ ĐỀU VÀ XEN KẼ CHÍNH XÁC GIỮA ${selectedTypes.length} ĐỊNH DẠNG ĐƯỢC CHỌN SAU ĐÂY:\n${selectedTypes.map(t => typeDescriptions[t]).join('\n')}\nLƯU Ý QUAN TRỌNG: TUYỆT ĐỐI CHỈ TẠO CÂU HỎI THUỘC CÁC ĐỊNH DẠNG ĐÃ CHỌN TRÊN, KHÔNG TẠO DẠNG NGOÀI DANH SÁCH!`;
    }

    let externalInstruction = '';
    if (ragMode === 'strict') {
      externalInstruction = `CHẾ ĐỘ BÁM SÁT TÀI LIỆU NGHIÊM NGẶT (STRICT RAG - 100% NỘI BỘ):
- Bộ câu hỏi BẮT BUỘC PHẢI BÁM SÁT TUYỆT ĐỐI 100% nội dung văn bản tài liệu môn học được cung cấp dưới đây.
- TUYỆT ĐỐI KHÔNG tự suy diễn, không đưa kiến thức hoặc thuật ngữ nằm ngoài tài liệu bài giảng.
- Mọi đáp án đúng và lời giải thích ("explanation") PHẢI có căn cứ trực tiếp trích xuất từ tài liệu đã cung cấp.`;
    } else if (ragMode === 'hybrid') {
      externalInstruction = `CHẾ ĐỘ RAG LAI GHÉP (HYBRID RAG - ƯU TIÊN GIÁO TRÌNH & BÙ ĐẮP KHI THIẾU):
- Hãy ưu tiên tối đa việc khai thác thông tin từ tài liệu môn học được cấp.
- Nếu tài liệu ngắn, thiếu dữ kiện hoặc để tăng tính ứng dụng, bạn ĐƯỢC PHÉP vận dụng kiến thức chuẩn mực chuyên ngành để biên soạn thêm các câu hỏi tình huống và bài tập vận dụng thực tế.
- Trong phần giải thích ("explanation"), nếu câu hỏi sử dụng kiến thức mở rộng ngoài tài liệu, hãy mở đầu phần giải thích bằng cụm từ: "[Kiến thức mở rộng]: ..."`;
    } else {
      externalInstruction = `CHẾ ĐỘ SÁNG TẠO & MỞ RỘNG (CREATIVE / OPEN WEB):
- Bạn ĐƯỢC TOÀN QUYỀN sử dụng tri thức mở rộng, liên hệ kiến thức thực tế ngành nghề, cập nhật các framework/công nghệ hiện đại và case study thực tiễn ngoài giáo trình.
- Tự do sáng tạo các câu hỏi tình huống thực tế phong phú, câu hỏi phản biện, so sánh đa chiều và bài tập ứng dụng sâu sắc.`;
    }

    const contextSection = context
      ? `TÀI LIỆU NGUỒN CỦA MÔN HỌC:\n${context.slice(0, 20000)}\n\n`
      : `MÔN HỌC: ${body.course || 'Khóa học đại học'}\nCHỦ ĐỀ: ${topic}\n\n`;

    const systemPrompt = `Bạn là chuyên gia khảo thí, sư phạm đại học và thiết kế đề thi trắc nghiệm theo chuẩn Moodle Question Bank.
Nhiệm vụ của bạn là soạn bộ câu hỏi trắc nghiệm chất lượng cao, chính xác 100%, không bị ảo giác.
BẮT BUỘC trả về đúng cấu trúc JSON, không markdown hay văn bản ngoài JSON.`;

    const userPrompt = `${contextSection}YÊU CẦU SOẠN BỘ CÂU HỎI TRẮC NGHIỆM MOODLE:
Hãy tạo CHÍNH XÁC ${count} câu hỏi trắc nghiệm (tuyệt đối không nhiều hơn và không ít hơn, đúng ${count} câu) theo chủ đề: "${topic}".
${difficultyGuide}
${typeGuide}
${externalInstruction}

QUY TẮC BẮT BUỘC CHO TỪNG LOẠI CÂU HỎI:
1. Đối với "type": "multichoice" (1 đáp án đúng): "options" có 4 phương án, "correctAnswerIndex": số nguyên 0..3.
2. Đối với "type": "truefalse" (Đúng/Sai): "options": ["Đúng", "Sai"], "correctAnswerIndex": 0 (nếu nhận định là Đúng) hoặc 1 (nếu nhận định là Sai).
3. Đối với "type": "multiselect" (Chọn nhiều đáp án đúng): "options" có 4-5 phương án, "correctAnswerIndices": mảng 2 hoặc 3 chỉ số đúng (ví dụ [0, 2] hoặc [1, 2, 3]). BẮT BUỘC 2 hoặc 3 đáp án đúng.
4. Đối với "type": "matching" (Nối cặp): "pairs" có 3 đến 5 cặp [{"left": "Khái niệm", "right": "Định nghĩa tương ứng"}].
5. Đối với "type": "shortanswer" (Trả lời ngắn): "acceptedAnswers" mảng 1 đến 3 biến thể chuỗi ngắn gọn đúng.
6. "explanation": Lời giải thích khoa học, rõ ràng tại sao các đáp án đó đúng/sai.
7. "questionText": Nội dung câu hỏi rõ ràng, không ghi sẵn chữ "A, B, C, D" hay "Câu 1".
8. NGÔN NGỮ ĐỀ THI (LANGUAGE CONFORMANCE):
- Toàn bộ câu hỏi ("questionText"), phương án ("options"), nối cặp ("pairs"), đáp án ("acceptedAnswers") và giải thích ("explanation") BẮT BUỘC dùng CHÍNH XÁC ngôn ngữ của chủ đề/yêu cầu (ví dụ: English nếu chủ đề bằng tiếng Anh, Español nếu bằng tiếng Tây Ban Nha...).
- TIẾNG VIỆT LUÔN LÀ NGÔN NGỮ MẶC ĐỊNH nếu chủ đề/tài liệu bằng tiếng Việt hoặc không rõ ngôn ngữ.

CẤU TRÚC JSON BẮT BUỘC:
{
  "questions": [
    {
      "type": "multichoice",
      "questionText": "Nội dung câu hỏi 1 lựa chọn?",
      "options": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "correctAnswerIndex": 0,
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "truefalse",
      "questionText": "Nhận định này đúng hay sai?",
      "options": ["Đúng", "Sai"],
      "correctAnswerIndex": 0,
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "multiselect",
      "questionText": "Những phát biểu nào sau đây là ĐÚNG? (Chọn 2 hoặc 3 đáp án)",
      "options": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "correctAnswerIndices": [0, 2],
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "matching",
      "questionText": "Nối các khái niệm ở cột trái với định nghĩa tương ứng ở cột phải:",
      "pairs": [
        { "left": "Thuật ngữ 1", "right": "Định nghĩa 1" },
        { "left": "Thuật ngữ 2", "right": "Định nghĩa 2" },
        { "left": "Thuật ngữ 3", "right": "Định nghĩa 3" }
      ],
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "shortanswer",
      "questionText": "Giao thức nào hoạt động ở tầng Giao vận cung cấp truyền dữ liệu tin cậy?",
      "acceptedAnswers": ["TCP", "Transmission Control Protocol"],
      "explanation": "TCP là giao thức hướng kết nối tin cậy..."
    }
  ]
}`;

    const isManualModel = Boolean(body.model && body.model !== 'auto');
    const modelToUse = isManualModel ? body.model : undefined;
    const result = await generateText(modelToUse, {
      system: systemPrompt,
      userPrompt,
      temperature: ragMode === 'strict' ? 0.0 : ragMode === 'hybrid' ? 0.3 : 0.7,
      topP: ragMode === 'strict' ? 0.001 : ragMode === 'hybrid' ? 0.7 : 0.9,
      jsonMode: true,
      googleSearchGrounding: ragMode === 'creative',
      allowExternalSource: ragMode === 'creative',
      ragMode,
      taskCategory: 'basic',
      strictModel: isManualModel,
    });

    if (!result.text) {
      return NextResponse.json({ error: 'Mô hình AI không trả về kết quả.' }, { status: 500 });
    }

    let parsedQuestions: Array<{
      type?: 'multichoice' | 'truefalse' | 'multiselect' | 'matching' | 'shortanswer' | string;
      questionText?: string;
      q?: string;
      options?: string[];
      choices?: string[];
      correctAnswerIndex?: number;
      correctAnswerIndices?: number[];
      acceptedAnswers?: string[];
      pairs?: Array<{ left: string; right: string }>;
      answer?: number | number[] | string | string[];
      answers?: number[] | string[];
      explanation?: string;
    }> = [];

    try {
      const parsed = JSON.parse(result.text);
      const list = parsed.questions || parsed.quiz || (Array.isArray(parsed) ? parsed : []);
      if (Array.isArray(list)) {
        parsedQuestions = list;
      }
    } catch {
      // Regex fallback if JSON contains markdown wrapper
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const list = parsed.questions || parsed.quiz || (Array.isArray(parsed) ? parsed : []);
          if (Array.isArray(list)) {
            parsedQuestions = list;
          }
        } catch {
          // ignore
        }
      }
    }

    if (parsedQuestions.length === 0) {
      return NextResponse.json({ error: 'Không thể phân tích dữ liệu câu hỏi từ AI.' }, { status: 500 });
    }

    const normalizedQuestions: QuizQuestionItem[] = parsedQuestions.slice(0, count).map((q, idx) => {
      const questionText = q.questionText || q.q || `Câu hỏi ${idx + 1}`;
      const rawOptions = q.options || q.choices || [];

      // 1. Matching
      if (q.type === 'matching' || (Array.isArray(q.pairs) && q.pairs.length >= 2)) {
        const rawPairs = Array.isArray(q.pairs) ? q.pairs : [];
        const validPairs = rawPairs
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((p: any) => ({
            left: String(p.left || p.question || p.term || '').trim(),
            right: String(p.right || p.answer || p.definition || '').trim(),
          }))
          .filter((p: { left: string; right: string }) => p.left && p.right);

        if (validPairs.length >= 2) {
          return {
            id: `q-${idx + 1}-${Date.now()}`,
            type: 'matching' as const,
            questionText,
            pairs: validPairs,
            explanation: q.explanation || 'Không có giải thích chi tiết.',
            defaultGrade: 1.0,
          };
        }
      }

      // 2. Short answer
      if (q.type === 'shortanswer' || q.type === 'short_answer') {
        const rawAnswers = Array.isArray(q.acceptedAnswers)
          ? q.acceptedAnswers
          : Array.isArray(q.answers)
          ? q.answers
          : q.answer !== undefined
          ? [String(q.answer)]
          : ['Đáp án'];
        const validAnswers = rawAnswers.map(String).map(s => s.trim()).filter(Boolean);

        return {
          id: `q-${idx + 1}-${Date.now()}`,
          type: 'shortanswer' as const,
          questionText,
          acceptedAnswers: validAnswers.length > 0 ? validAnswers : ['Đáp án đúng'],
          explanation: q.explanation || 'Không có giải thích chi tiết.',
          defaultGrade: 1.0,
        };
      }

      // 3. True/False
      if (
        q.type === 'truefalse' ||
        q.type === 'true_false' ||
        (rawOptions.length === 2 && (rawOptions[0].toLowerCase().includes('đúng') || rawOptions[0].toLowerCase().includes('true')))
      ) {
        const correctIdx = typeof q.correctAnswerIndex === 'number'
          ? q.correctAnswerIndex
          : typeof q.answer === 'number'
          ? q.answer
          : 0;

        return {
          id: `q-${idx + 1}-${Date.now()}`,
          type: 'truefalse' as const,
          questionText,
          options: ['Đúng', 'Sai'],
          correctAnswerIndex: correctIdx === 1 ? 1 : 0,
          explanation: q.explanation ? stripFluff(q.explanation) : 'Không có giải thích chi tiết.',
          defaultGrade: 1.0,
        };
      }

      // 4. Multiple Select
      if (
        q.type === 'multiselect' ||
        q.type === 'multiple_select' ||
        (Array.isArray(q.correctAnswerIndices) && q.correctAnswerIndices.length > 1) ||
        (Array.isArray(q.answer) && q.answer.length > 1)
      ) {
        const rawIndices = Array.isArray(q.correctAnswerIndices)
          ? q.correctAnswerIndices
          : Array.isArray(q.answer)
          ? q.answer
          : [0, 1];

        const options = rawOptions.length >= 2 ? rawOptions : ['Lựa chọn A', 'Lựa chọn B', 'Lựa chọn C', 'Lựa chọn D'];
        let validIndices = rawIndices
          .map(Number)
          .filter(n => !isNaN(n) && n >= 0 && n < options.length);

        // Enforce 2 or 3 correct answers
        if (validIndices.length <= 1) {
          const remaining = [0, 1, 2, 3].filter(i => i < options.length && !validIndices.includes(i));
          validIndices = [...validIndices, remaining[0] ?? 1].slice(0, 2);
        } else if (validIndices.length >= options.length) {
          validIndices = validIndices.slice(0, Math.min(3, options.length - 1));
        } else if (validIndices.length > 3) {
          validIndices = validIndices.slice(0, 3);
        }

        return {
          id: `q-${idx + 1}-${Date.now()}`,
          type: 'multiselect' as const,
          questionText,
          options,
          correctAnswerIndices: validIndices,
          explanation: q.explanation ? stripFluff(q.explanation) : 'Không có giải thích chi tiết.',
          defaultGrade: 1.0,
        };
      }

      // 5. Default: Single multichoice
      const options = rawOptions.length >= 4 ? rawOptions.slice(0, 4) : [...rawOptions, 'Đáp án khác 1', 'Đáp án khác 2'].slice(0, 4);
      const correctAnswerIndex = typeof q.correctAnswerIndex === 'number'
        ? q.correctAnswerIndex
        : typeof q.answer === 'number'
        ? q.answer
        : 0;

      return {
        id: `q-${idx + 1}-${Date.now()}`,
        type: 'multichoice',
        questionText,
        options,
        correctAnswerIndex: Math.min(options.length - 1, Math.max(0, correctAnswerIndex)),
        explanation: q.explanation ? stripFluff(q.explanation) : 'Không có giải thích chi tiết.',
        defaultGrade: 1.0,
      };
    });

    const categoryName = body.course ? `${body.course} - ${topic}` : topic;
    const moodleXml = convertQuestionsToMoodleXml(normalizedQuestions, categoryName);

    return NextResponse.json({
      success: true,
      count: normalizedQuestions.length,
      questions: normalizedQuestions,
      xmlContent: moodleXml,
      fileName: `quiz_${Date.now()}.xml`,
      categoryName,
    });
  } catch (error) {
    console.error('Teacher quiz generation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi khi tạo đề trắc nghiệm.' },
      { status: 500 }
    );
  }
}

