import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';
import { parseDocumentFromUrl } from '@/lib/document-parser';
import { retrieveRelevantChunks, formatChunksForPrompt } from '@/lib/rag';
import { getLatestQuizAnalysis } from '@/lib/learning-artifacts';
import { getPersonalMaterials } from '@/lib/firebase-data';
import { stripFluff } from '@/lib/anti-fluff';

interface SourceItem {
  name: string;
  url?: string;
  type?: string;
}

export interface MatchingPair {
  left: string;
  right: string;
}

export interface QuizQuestion {
  id?: string;
  q: string;
  type?: 'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer';
  choices?: string[];
  answer?: number | string; // 0-based index for single / true_false, or string for short answer
  answers?: number[] | string[]; // array of 0-based indices for multiple_select, or acceptable string variants for short_answer
  pairs?: MatchingPair[]; // array of { left, right } pairs for matching
  explanation: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      topic?: string;
      course?: string;
      courseCode?: string;
      courseId?: string | number;
      userId?: number;
      sourceNames?: string[];
      sources?: SourceItem[];
      count?: number;
      difficulty?: 'easy' | 'normal' | 'hard';
      questionType?: 'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer' | 'mixed';
      questionTypes?: Array<'multiple_choice' | 'true_false' | 'multiple_select' | 'matching' | 'short_answer'>;
      generatorMode?: 'comprehensive' | 'targeted';
      focusWeakAreas?: boolean;
      weakTopics?: string[];
      allowExternalSource?: boolean;
      ragMode?: 'strict' | 'hybrid' | 'creative';
      model?: string;
    };

    // Validate count: minimum 10, maximum 50
    const rawCount = typeof body.count === 'number' ? body.count : 10;
    const count = Math.min(50, Math.max(10, rawCount));

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
        selectedTypes = ['multiple_choice'];
      }
    }

    const difficulty = body.difficulty || 'normal';
    const questionType = body.questionType || (selectedTypes.length === 1 ? selectedTypes[0] : 'mixed');
    const topic = body.topic || 'Kiểm tra kiến thức môn học';
    const ragMode: 'strict' | 'hybrid' | 'creative' =
      body.ragMode || (body.allowExternalSource ? 'creative' : 'hybrid');
    const allowExternalSource = ragMode === 'creative';

    const effectiveSources: SourceItem[] =
      body.sources && body.sources.length > 0
        ? body.sources
        : (body.sourceNames || []).map(name => ({ name }));

    const effectiveSourceNames = effectiveSources.map(s => s.name);

    // 1. Gather document context from personal_materials / Moodle
    let documentContext = '';
    const docMap = new Map<string, string>();
    const moodleCourseId = Number(body.courseId) || undefined;

    if (moodleCourseId) {
      try {
        const mats = await getPersonalMaterials({ moodleCourseId, limit: 10 });
        if (mats) {
          for (const mat of mats) {
            if (mat.storage_url && mat.title && !docMap.has(String(mat.title).toLowerCase())) {
              try {
                const text = await parseDocumentFromUrl(String(mat.storage_url), String(mat.title));
                if (text && text.length > 50) docMap.set(String(mat.title).toLowerCase(), text);
              } catch {
                // ignore unavailable material
              }
            }
          }
        }
      } catch (firebaseError) {
        console.warn('Firebase personal_materials query in quiz route:', firebaseError);
      }
    }

    // Parse URL documents if needed
    for (const src of effectiveSources) {
      const lowerName = src.name.toLowerCase();
      if (!docMap.has(lowerName) && src.url) {
        try {
          const extractedText = await parseDocumentFromUrl(src.url, src.name);
          if (extractedText && extractedText.trim()) {
            docMap.set(lowerName, extractedText);
          }
        } catch {
          // ignore
        }
      }
    }

    const compiledDocs: Array<{ title: string; text: string }> = [];
    for (const src of effectiveSources) {
      const lowerName = src.name.toLowerCase();
      let text = docMap.get(lowerName) || '';
      if (!text) {
        for (const [key, val] of docMap.entries()) {
          if (key.includes(lowerName) || lowerName.includes(key)) {
            text = val;
            break;
          }
        }
      }
      if (text && text.trim() && !compiledDocs.some(d => d.title === src.name)) {
        compiledDocs.push({ title: src.name, text });
      }
    }

    if (ragMode === 'strict' && compiledDocs.length === 0) {
      return NextResponse.json(
        {
          error:
            'Chế độ Bám sát tài liệu (Strict RAG) yêu cầu tài liệu môn học. Hiện chưa có tài liệu nào được cung cấp. Vui lòng chuyển sang chế độ Hybrid hoặc Creative để tiếp tục.',
        },
        { status: 400 }
      );
    }

    if (compiledDocs.length > 0) {
      try {
        const relevantChunks = await retrieveRelevantChunks(topic, compiledDocs, {
          topK: 8,
          maxTotalChars: 18000,
          minSimilarity: 0.15,
        });

        if (relevantChunks.length > 0) {
          documentContext = formatChunksForPrompt(relevantChunks);
        } else {
          const maxPerDoc = Math.max(2500, Math.floor(25000 / compiledDocs.length));
          documentContext = compiledDocs
            .map((doc, idx) => `[TÀI LIỆU ${idx + 1}: "${doc.title}"]\n${doc.text.slice(0, maxPerDoc)}`)
            .join('\n\n');
        }
      } catch (ragErr) {
        console.warn('RAG retrieval warning in quiz route:', ragErr);
        const maxPerDoc = Math.max(2500, Math.floor(25000 / compiledDocs.length));
        documentContext = compiledDocs
          .map((doc, idx) => `[TÀI LIỆU ${idx + 1}: "${doc.title}"]\n${doc.text.slice(0, maxPerDoc)}`)
          .join('\n\n');
      }
    }

    // Difficulty Prompting
    let difficultyDesc = '';
    if (difficulty === 'easy') {
      difficultyDesc = 'ĐỘ KHÓ: DỄ (Câu hỏi nhận biết khái niệm cơ bản, định nghĩa trực tiếp, không bẫy phức tạp).';
    } else if (difficulty === 'hard') {
      difficultyDesc = 'ĐỘ KHÓ: KHÓ / NÂNG CAO (Câu hỏi vận dụng cao, phân tích tình huống thực tế, so sánh chi tiết, công thức, bẫy trắc nghiệm sâu sắc).';
    } else {
      difficultyDesc = 'ĐỘ KHÓ: TRUNG BÌNH (Cân đối giữa câu hỏi lý thuyết hiểu bản chất và bài tập vận dụng vừa phải).';
    }

    // Type Prompting
    const typeDescriptions: Record<string, string> = {
      multiple_choice: '1. TRẮC NGHIỆM 4 LỰA CHỌN (Single Choice): "type": "multiple_choice", "choices": đúng 4 lựa chọn, "answer": số nguyên 0..3 (1 đáp án đúng duy nhất).',
      true_false: '2. ĐÚNG / SAI (True/False): "type": "true_false", "choices": ["Đúng", "Sai"], "answer": 0 nếu Đúng, 1 nếu Sai.',
      multiple_select: '3. CHỌN NHIỀU ĐÁP ÁN (Multiple Select): "type": "multiple_select", "choices": 4-5 lựa chọn, "answers": mảng chứa từ 2 ĐẾN 3 chỉ số đúng (ví dụ [0, 2] hoặc [1, 2, 3]). BẮT BUỘC chỉ có 2 hoặc 3 đáp án đúng, TUYỆT ĐỐI KHÔNG chọn tất cả và KHÔNG chọn chỉ 1.',
      matching: '4. NỐI CẶP TƯƠNG ỨNG (Matching): "type": "matching", "q": "Yêu cầu nối thuật ngữ với định nghĩa phù hợp...", "pairs": mảng 3 đến 5 cặp [{"left": "Khái niệm A", "right": "Định nghĩa chính xác của A"}, ...]. Vế phải phải tương ứng chuẩn xác với vế trái.',
      short_answer: '5. TRẢ LỜI NGẮN (Short Answer): "type": "short_answer", "q": "Nội dung câu hỏi yêu cầu điền thuật ngữ/từ khóa/con số ngắn...", "answers": mảng 1 đến 3 biến thể đáp án đúng chấp nhận được (ví dụ ["TCP", "Transmission Control Protocol"]).',
    };

    let typeDesc = '';
    if (selectedTypes.length === 1) {
      typeDesc = `LOẠI CÂU HỎI BẮT BUỘC (100%): Hãy tạo 100% câu hỏi theo đúng định dạng sau:\n${typeDescriptions[selectedTypes[0]]}`;
    } else {
      typeDesc = `LOẠI CÂU HỎI: HÃY PHÂN BỔ ĐỀU VÀ XEN KẼ CHÍNH XÁC GIỮA ${selectedTypes.length} ĐỊNH DẠNG ĐƯỢC CHỌN SAU ĐÂY:\n${selectedTypes.map(t => typeDescriptions[t]).join('\n')}\nLƯU Ý QUAN TRỌNG: TUYỆT ĐỐI CHỈ TẠO CÂU HỎI THUỘC CÁC ĐỊNH DẠNG ĐÃ CHỌN TRÊN, KHÔNG TẠO DẠNG NGOÀI DANH SÁCH!`;
    }

    let contextSection = '';
    if (documentContext.trim()) {
      contextSection = `DƯỚI ĐÂY LÀ VĂN BẢN TRÍCH XUẤT TỪ TÀI LIỆU MÔN HỌC:\n${documentContext}\n\n`;
    } else {
      contextSection = `MÔN HỌC: ${body.course || 'Khóa học'}\nTÀI LIỆU: ${effectiveSourceNames.join(', ') || 'Giáo trình môn học'}\n\n`;
    }

    let externalRule = '';
    if (ragMode === 'strict') {
      externalRule = `CHẾ ĐỘ BÁM SÁT TÀI LIỆU NGHIÊM NGẶT (STRICT RAG - 100% GIÁO TRÌNH):
- Câu hỏi BẮT BUỘC bám sát tuyệt đối 100% nội dung tài liệu môn học được cung cấp.
- Tuyệt đối không tự suy diễn, không đưa kiến thức hoặc thuật ngữ nằm ngoài tài liệu giáo trình.
- Mọi đáp án đúng và lời giải thích ("explanation") PHẢI có căn cứ trực tiếp trích xuất từ tài liệu đã cung cấp.`;
    } else if (ragMode === 'hybrid') {
      externalRule = `CHẾ ĐỘ RAG LAI GHÉP (HYBRID RAG - ƯU TIÊN GIÁO TRÌNH & BÙ ĐẮP KHI THIẾU):
- Ưu tiên tối đa khai thác nội dung tài liệu môn học được cung cấp.
- Nếu tài liệu ngắn hoặc thiếu dữ kiện, bạn ĐƯỢC PHÉP vận dụng kiến thức chuyên ngành chuẩn mực để mở rộng câu hỏi tình huống thực tế và bài tập áp dụng.
- Trong phần giải thích ("explanation"), nếu câu hỏi sử dụng kiến thức mở rộng ngoài tài liệu, hãy mở đầu bằng: "[Kiến thức mở rộng]: ..."`;
    } else {
      externalRule = `CHẾ ĐỘ SÁNG TẠO & MỞ RỘNG (CREATIVE / OPEN WEB):
- Bạn ĐƯỢC TOÀN QUYỀN đưa thêm các câu hỏi tình huống thực tế ngành, câu hỏi ứng dụng hiện đại, case study thực tế và câu hỏi mở rộng tư duy sáng tạo ngoài giáo trình.`;
    }

    // Adaptive Learning Remediation Mode
    const generatorMode = body.generatorMode || (body.focusWeakAreas ? 'targeted' : 'comprehensive');
    let effectiveWeakTopics: string[] = body.weakTopics || [];

    if (generatorMode === 'targeted' && effectiveWeakTopics.length === 0) {
      try {
        const courseIdNum = typeof body.courseId === 'number' ? body.courseId : Number(body.courseId);
        const latestAnalysis = await getLatestQuizAnalysis({
          moodleCourseId: !isNaN(courseIdNum) ? courseIdNum : undefined,
          userId: body.userId ? Number(body.userId) : undefined,
        });
        if (latestAnalysis?.weakTopics?.length) {
          effectiveWeakTopics = latestAnalysis.weakTopics;
        }
      } catch (err) {
        console.warn('Could not retrieve weak topics from learning_artifacts:', err);
      }
    }

    let adaptiveSection = '';
    if (generatorMode === 'targeted' && effectiveWeakTopics.length > 0) {
      adaptiveSection = `\nĐẶC BIỆT - CHẾ ĐỘ HỌC TẬP THÍCH ỨNG (ADAPTIVE REMEDIATION):
Sinh viên này đang bị hổng kiến thức hoặc liên tục làm sai ở các chủ đề sau:
${effectiveWeakTopics.map((t, idx) => `  ${idx + 1}. ${t}`).join('\n')}
YÊU CẦU BẮT BUỘC: Hãy tập trung 100% câu hỏi xoáy sâu vào các chủ đề trên! Tăng cường các câu hỏi tình huống thực tế, câu hỏi phân biệt bản chất dễ nhầm lẫn để giúp sinh viên rà soát và khắc phục triệt để lỗ hổng.\n`;
    }

    const prompt = `${contextSection}YÊU CẦU SOẠN ĐỀ TRẮC NGHIỆM:
Hãy tạo chính xác ${count} câu hỏi trắc nghiệm theo chủ đề: "${topic}".
${difficultyDesc}
${typeDesc}
${externalRule}
${adaptiveSection}

QUY TẮC BẮT BUỘC CHO TỪNG LOẠI CÂU HỎI:
1. "multiple_choice": "choices" có 4 phương án, "answer": số nguyên 0..3 (1 đáp án đúng).
2. "true_false": "choices": ["Đúng", "Sai"], "answer": 0 (nếu Đúng) hoặc 1 (nếu Sai).
3. "multiple_select": "choices" có 4-5 phương án, "answers": mảng chứa từ 2 đến 3 chỉ số đúng (ví dụ [0, 2]). KHÔNG chọn tất cả, KHÔNG chọn chỉ 1.
4. "matching": "pairs" mảng 3 đến 5 cặp ghép đúng [{"left": "Khái niệm", "right": "Định nghĩa tương ứng"}].
5. "short_answer": "answers" mảng 1 đến 3 biến thể chuỗi ngắn gọn được chấp nhận.
6. "explanation": Lời giải thích ngắn gọn nhưng đủ ý khoa học.
7. NGÔN NGỮ ĐỀ THI (LANGUAGE CONFORMANCE): Bộ câu hỏi, phương án, đáp án và giải thích BẮT BUỘC dùng CHÍNH XÁC ngôn ngữ của chủ đề/yêu cầu (ví dụ: English nếu chủ đề bằng tiếng Anh, Español nếu bằng tiếng Tây Ban Nha...). Tiếng Việt luôn là ngôn ngữ mặc định nếu chủ đề bằng tiếng Việt hoặc không rõ ngôn ngữ.
8. Trả về đúng JSON object duy nhất có thuộc tính "questions":
{
  "questions": [
    {
      "type": "multiple_choice",
      "q": "Nội dung câu hỏi 1 lựa chọn?",
      "choices": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "answer": 0,
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "true_false",
      "q": "Nhận định này đúng hay sai?",
      "choices": ["Đúng", "Sai"],
      "answer": 0,
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "multiple_select",
      "q": "Những khẳng định nào sau đây là ĐÚNG? (Chọn 2 hoặc 3 đáp án)",
      "choices": ["Lựa chọn A", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
      "answers": [0, 2],
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "matching",
      "q": "Nối các khái niệm ở cột trái với nội dung tương ứng ở cột phải:",
      "pairs": [
        { "left": "Khái niệm 1", "right": "Nội dung 1" },
        { "left": "Khái niệm 2", "right": "Nội dung 2" },
        { "left": "Khái niệm 3", "right": "Nội dung 3" }
      ],
      "explanation": "Giải thích chi tiết..."
    },
    {
      "type": "short_answer",
      "q": "Giao thức nào hoạt động ở tầng Giao vận cung cấp truyền dữ liệu tin cậy?",
      "answers": ["TCP", "Transmission Control Protocol"],
      "explanation": "TCP là giao thức hướng kết nối tin cậy..."
    }
  ]
}
Không bao gồm markdown hay văn bản ngoài JSON.`;

    // 3. AI Execution via unified model registry (Quiz: Basic Speed Task -> Groq forward in Strict RAG)
    try {
      const result = await generateText(body.model, {
        system: 'Bạn là chuyên gia khảo thí và sư phạm đại học. Luôn đảm bảo tuyệt đối tính chính xác của câu hỏi, đáp án đúng và lời giải thích dựa trên sự thật lịch sử và khoa học, chống ảo giác 100%. Trả về đúng JSON schema.',
        userPrompt: prompt,
        temperature: ragMode === 'strict' ? 0.0 : ragMode === 'hybrid' ? 0.3 : 0.7,
        topP: ragMode === 'strict' ? 0.001 : ragMode === 'hybrid' ? 0.7 : 0.9,
        jsonMode: true,
        googleSearchGrounding: ragMode === 'creative',
        allowExternalSource: ragMode === 'creative',
        ragMode,
        taskCategory: 'basic',
        signal: request.signal,
      });

      if (result.text) {
        const parsed = JSON.parse(result.text);
        const questionsList = parsed.questions || parsed.quiz || (Array.isArray(parsed) ? parsed : []);
        if (Array.isArray(questionsList) && questionsList.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const normalized = questionsList.slice(0, count).map((item: any, idx: number) => {
            const rawChoices = item.choices || item.options || [];

            // 1. Matching
            if (item.type === 'matching' || (Array.isArray(item.pairs) && item.pairs.length >= 2)) {
              const rawPairs = Array.isArray(item.pairs) ? item.pairs : [];
              const validPairs = rawPairs
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((p: any) => ({
                  left: String(p.left || p.question || p.term || '').trim(),
                  right: String(p.right || p.answer || p.definition || '').trim(),
                }))
                .filter((p: { left: string; right: string }) => p.left && p.right);

              if (validPairs.length >= 2) {
                return {
                  id: `sq-${idx + 1}-${Date.now()}`,
                  type: 'matching' as const,
                  q: item.q || item.questionText || `Nối các cặp khái niệm tương ứng sau:`,
                  pairs: validPairs,
                  explanation: item.explanation || '',
                };
              }
            }

            // 2. Short answer
            if (item.type === 'short_answer' || item.type === 'shortanswer' || item.type === 'short_ans') {
              const rawAnswers = Array.isArray(item.answers)
                ? item.answers
                : Array.isArray(item.acceptedAnswers)
                ? item.acceptedAnswers
                : item.answer !== undefined
                ? [String(item.answer)]
                : ['Đáp án'];
              const validAnswers = (rawAnswers as unknown[]).map(s => String(s).trim()).filter(Boolean);

              return {
                id: `sq-${idx + 1}-${Date.now()}`,
                type: 'short_answer' as const,
                q: item.q || item.questionText || `Câu hỏi ${idx + 1}`,
                answers: validAnswers.length > 0 ? validAnswers : ['Đáp án đúng'],
                answer: validAnswers[0] || 'Đáp án đúng',
                explanation: item.explanation ? stripFluff(item.explanation) : '',
              };
            }

            // 3. True / False
            if (
              item.type === 'true_false' ||
              item.type === 'truefalse' ||
              (rawChoices.length === 2 && (rawChoices[0].toLowerCase().includes('đúng') || rawChoices[0].toLowerCase().includes('true')))
            ) {
              const ans = typeof item.answer === 'number' ? item.answer : 0;
              return {
                id: `sq-${idx + 1}-${Date.now()}`,
                type: 'true_false' as const,
                q: item.q || item.questionText || `Câu hỏi ${idx + 1}`,
                choices: ['Đúng', 'Sai'],
                answer: ans === 1 ? 1 : 0,
                explanation: item.explanation ? stripFluff(item.explanation) : '',
              };
            }

            // 4. Multiple select
            if (
              item.type === 'multiple_select' ||
              item.type === 'multiselect' ||
              (Array.isArray(item.answers) && item.answers.length > 1) ||
              (Array.isArray(item.answer) && item.answer.length > 1)
            ) {
              const rawAnswers = Array.isArray(item.answers)
                ? item.answers
                : Array.isArray(item.answer)
                ? item.answer
                : [0, 1];
              const choices = rawChoices.length >= 2 ? rawChoices : ['Lựa chọn A', 'Lựa chọn B', 'Lựa chọn C', 'Lựa chọn D'];
              let validAnswers = rawAnswers
                .map(Number)
                .filter((n: number) => !isNaN(n) && n >= 0 && n < choices.length);

              // Enforce 2 or 3 correct answers, not all and not 1
              if (validAnswers.length <= 1) {
                const remaining = [0, 1, 2, 3].filter(i => i < choices.length && !validAnswers.includes(i));
                validAnswers = [...validAnswers, remaining[0] ?? 1].slice(0, 2);
              } else if (validAnswers.length >= choices.length) {
                validAnswers = validAnswers.slice(0, Math.min(3, choices.length - 1));
              } else if (validAnswers.length > 3) {
                validAnswers = validAnswers.slice(0, 3);
              }

              return {
                id: `sq-${idx + 1}-${Date.now()}`,
                type: 'multiple_select' as const,
                q: item.q || item.questionText || `Câu hỏi ${idx + 1}`,
                choices,
                answers: validAnswers,
                explanation: item.explanation ? stripFluff(item.explanation) : '',
              };
            }

            // 5. Default: Multiple choice (single)
            const choices = rawChoices.length >= 4 ? rawChoices.slice(0, 4) : [...rawChoices, 'Lựa chọn 1', 'Lựa chọn 2'].slice(0, 4);
            const ans = typeof item.answer === 'number' ? item.answer : 0;
            return {
              id: `sq-${idx + 1}-${Date.now()}`,
              type: 'multiple_choice' as const,
              q: item.q || item.questionText || `Câu hỏi ${idx + 1}`,
              choices,
              answer: Math.min(choices.length - 1, Math.max(0, ans)),
              explanation: item.explanation ? stripFluff(item.explanation) : '',
            };
          });

          return NextResponse.json({
            questions: normalized,
            count: normalized.length,
            difficulty,
            questionType,
            questionTypes: selectedTypes,
            generatorMode,
            weakTopics: effectiveWeakTopics,
            mode: 'ai',
          });
        }
      }
    } catch (err) {
      console.warn('AI quiz generation failed:', err);
    }

    return NextResponse.json({ error: 'Không thể tạo đề trắc nghiệm lúc này.' }, { status: 500 });
  } catch (error) {
    console.error('Quiz route error:', error);
    return NextResponse.json({ error: 'Lỗi khi tạo đề trắc nghiệm.' }, { status: 500 });
  }
}
