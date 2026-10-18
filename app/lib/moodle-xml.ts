export interface MatchingPair {
  left: string;
  right: string;
}

export interface QuizQuestionItem {
  id?: string;
  type?: 'multichoice' | 'truefalse' | 'multiselect' | 'matching' | 'shortanswer';
  questionText: string;
  options?: string[];
  correctAnswerIndex?: number; // 0-based for single multichoice or truefalse
  correctAnswerIndices?: number[]; // 0-based array for multiselect
  acceptedAnswers?: string[]; // for shortanswer
  pairs?: MatchingPair[]; // for matching
  explanation?: string;
  defaultGrade?: number;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(content: string): string {
  const safe = content.replace(/\]\]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

export function convertQuestionsToMoodleXml(
  questions: QuizQuestionItem[],
  categoryName?: string
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<quiz>',
  ];

  if (categoryName) {
    lines.push('  <!-- Question Category -->');
    lines.push('  <question type="category">');
    lines.push('    <category>');
    lines.push(`      <text>$course$/top/${escapeXml(categoryName)}</text>`);
    lines.push('    </category>');
    lines.push('  </question>');
  }

  questions.forEach((q, idx) => {
    const qNum = idx + 1;
    const cleanTitle = q.questionText.replace(/<[^>]*>/g, '').trim();
    const shortName = cleanTitle.length > 50 ? `${cleanTitle.slice(0, 47)}...` : cleanTitle;
    const grade = q.defaultGrade ?? 1;
    const isMatching = q.type === 'matching' || (Array.isArray(q.pairs) && q.pairs.length > 0);
    const isShortAnswer = q.type === 'shortanswer' || (Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.length > 0);
    const isTrueFalse = q.type === 'truefalse' || (!isMatching && !isShortAnswer && (q.options?.length ?? 0) === 2 && ((q.options?.[0] || '').toLowerCase().includes('đúng') || (q.options?.[0] || '').toLowerCase().includes('true')));
    const isMultiSelect = q.type === 'multiselect' || (!isMatching && !isShortAnswer && Array.isArray(q.correctAnswerIndices) && q.correctAnswerIndices.length > 1);

    if (isMatching) {
      // ----------------------------------------------------------------------
      // 0. Matching Question
      // ----------------------------------------------------------------------
      lines.push(`  <!-- Question ${qNum}: Matching -->`);
      lines.push('  <question type="matching">');
      lines.push('    <name>');
      lines.push(`      <text>${cdata(`Câu ${qNum} [Nối cặp]: ${shortName || 'Matching'}`)}</text>`);
      lines.push('    </name>');
      lines.push('    <questiontext format="html">');
      lines.push(`      <text>${cdata(`<p>${q.questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (q.explanation && q.explanation.trim()) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${q.explanation.trim()}</p>`)}</text>`);
        lines.push('    </generalfeedback>');
      } else {
        lines.push('    <generalfeedback format="html">');
        lines.push('      <text></text>');
        lines.push('    </generalfeedback>');
      }

      lines.push(`    <defaultgrade>${grade.toFixed(7)}</defaultgrade>`);
      lines.push('    <penalty>0.3333333</penalty>');
      lines.push('    <hidden>0</hidden>');
      lines.push('    <idnumber></idnumber>');
      lines.push('    <shuffleanswers>true</shuffleanswers>');

      (q.pairs || []).forEach(pair => {
        lines.push('    <subquestion format="html">');
        lines.push(`      <text>${cdata(`<p>${pair.left}</p>`)}</text>`);
        lines.push('      <answer>');
        lines.push(`        <text>${escapeXml(pair.right)}</text>`);
        lines.push('      </answer>');
        lines.push('    </subquestion>');
      });

      lines.push('  </question>');
    } else if (isShortAnswer) {
      // ----------------------------------------------------------------------
      // 0. Short Answer Question
      // ----------------------------------------------------------------------
      lines.push(`  <!-- Question ${qNum}: Short Answer -->`);
      lines.push('  <question type="shortanswer">');
      lines.push('    <name>');
      lines.push(`      <text>${cdata(`Câu ${qNum} [Trả lời ngắn]: ${shortName || 'Short Answer'}`)}</text>`);
      lines.push('    </name>');
      lines.push('    <questiontext format="html">');
      lines.push(`      <text>${cdata(`<p>${q.questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (q.explanation && q.explanation.trim()) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${q.explanation.trim()}</p>`)}</text>`);
        lines.push('    </generalfeedback>');
      } else {
        lines.push('    <generalfeedback format="html">');
        lines.push('      <text></text>');
        lines.push('    </generalfeedback>');
      }

      lines.push(`    <defaultgrade>${grade.toFixed(7)}</defaultgrade>`);
      lines.push('    <penalty>0.3333333</penalty>');
      lines.push('    <hidden>0</hidden>');
      lines.push('    <idnumber></idnumber>');
      lines.push('    <usecase>0</usecase>');

      const answers = (q.acceptedAnswers && q.acceptedAnswers.length > 0)
        ? q.acceptedAnswers
        : (q.options && q.options.length > 0 ? q.options : ['']);

      answers.forEach(ans => {
        lines.push('    <answer fraction="100" format="moodle_auto_format">');
        lines.push(`      <text>${escapeXml(ans)}</text>`);
        lines.push('      <feedback format="html">');
        lines.push(`        <text>${cdata('<p>Chính xác!</p>')}</text>`);
        lines.push('      </feedback>');
        lines.push('    </answer>');
      });

      lines.push('  </question>');
    } else if (isTrueFalse) {
      // ----------------------------------------------------------------------
      // 1. True / False Question
      // ----------------------------------------------------------------------
      const correctIdx = q.correctAnswerIndex ?? 0;
      const firstOptIsCorrect = correctIdx === 0;
      const firstOptText = (q.options?.[0] || '').toLowerCase();
      const isStatementTrue = firstOptText.includes('đúng') || firstOptText.includes('true') ? firstOptIsCorrect : !firstOptIsCorrect;

      lines.push(`  <!-- Question ${qNum}: True/False -->`);
      lines.push('  <question type="truefalse">');
      lines.push('    <name>');
      lines.push(`      <text>${cdata(`Câu ${qNum} [Đúng/Sai]: ${shortName || 'True/False'}`)}</text>`);
      lines.push('    </name>');
      lines.push('    <questiontext format="html">');
      lines.push(`      <text>${cdata(`<p>${q.questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (q.explanation && q.explanation.trim()) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${q.explanation.trim()}</p>`)}</text>`);
        lines.push('    </generalfeedback>');
      } else {
        lines.push('    <generalfeedback format="html">');
        lines.push('      <text></text>');
        lines.push('    </generalfeedback>');
      }

      lines.push(`    <defaultgrade>${grade.toFixed(7)}</defaultgrade>`);
      lines.push('    <penalty>1.0000000</penalty>');
      lines.push('    <hidden>0</hidden>');
      lines.push('    <idnumber></idnumber>');

      // Answer True
      lines.push(`    <answer fraction="${isStatementTrue ? '100' : '0'}" format="html">`);
      lines.push(`      <text>true</text>`);
      lines.push('      <feedback format="html">');
      lines.push(`        <text>${isStatementTrue && q.explanation ? cdata(`<p>✓ ${q.explanation}</p>`) : ''}</text>`);
      lines.push('      </feedback>');
      lines.push('    </answer>');

      // Answer False
      lines.push(`    <answer fraction="${!isStatementTrue ? '100' : '0'}" format="html">`);
      lines.push(`      <text>false</text>`);
      lines.push('      <feedback format="html">');
      lines.push(`        <text>${!isStatementTrue && q.explanation ? cdata(`<p>✓ ${q.explanation}</p>`) : ''}</text>`);
      lines.push('      </feedback>');
      lines.push('    </answer>');

      lines.push('  </question>');
    } else if (isMultiSelect) {
      // ----------------------------------------------------------------------
      // 2. Multiple Select Question (single: false)
      // ----------------------------------------------------------------------
      const correctIndices = q.correctAnswerIndices && q.correctAnswerIndices.length > 0
        ? q.correctAnswerIndices
        : (typeof q.correctAnswerIndex === 'number' ? [q.correctAnswerIndex] : [0]);

      const correctCount = correctIndices.length;
      const safeOptions = q.options || [];
      const incorrectCount = Math.max(1, safeOptions.length - correctCount);

      // Fraction for each correct answer (e.g. 50% for 2, 33.33333% for 3)
      const posFraction = (100 / correctCount).toFixed(5);
      // Negative penalty for wrong options to prevent checking all boxes
      const negFraction = (-100 / incorrectCount).toFixed(5);

      lines.push(`  <!-- Question ${qNum}: Multiple Select -->`);
      lines.push('  <question type="multichoice">');
      lines.push('    <name>');
      lines.push(`      <text>${cdata(`Câu ${qNum} [Nhiều đáp án]: ${shortName || 'Multiple Select'}`)}</text>`);
      lines.push('    </name>');
      lines.push('    <questiontext format="html">');
      lines.push(`      <text>${cdata(`<p>${q.questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (q.explanation && q.explanation.trim()) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${q.explanation.trim()}</p>`)}</text>`);
        lines.push('    </generalfeedback>');
      } else {
        lines.push('    <generalfeedback format="html">');
        lines.push('      <text></text>');
        lines.push('    </generalfeedback>');
      }

      lines.push(`    <defaultgrade>${grade.toFixed(7)}</defaultgrade>`);
      lines.push('    <penalty>0.3333333</penalty>');
      lines.push('    <hidden>0</hidden>');
      lines.push('    <idnumber></idnumber>');
      lines.push('    <single>false</single>');
      lines.push('    <shuffleanswers>true</shuffleanswers>');
      lines.push('    <answernumbering>abc</answernumbering>');
      lines.push('    <showstandardinstruction>0</showstandardinstruction>');
      lines.push('    <correctfeedback format="html">');
      lines.push(`      <text>${cdata('<p>Chính xác! Bạn đã chọn đủ các phương án đúng.</p>')}</text>`);
      lines.push('    </correctfeedback>');
      lines.push('    <partiallycorrectfeedback format="html">');
      lines.push(`      <text>${cdata('<p>Câu trả lời của bạn đúng một phần.</p>')}</text>`);
      lines.push('    </partiallycorrectfeedback>');
      lines.push('    <incorrectfeedback format="html">');
      lines.push(`      <text>${cdata('<p>Chưa chính xác. Hãy xem lại các đáp án đúng.</p>')}</text>`);
      lines.push('    </incorrectfeedback>');

      safeOptions.forEach((optText, optIdx) => {
        const isCorrect = correctIndices.includes(optIdx);
        const fraction = isCorrect ? posFraction : negFraction;
        lines.push(`    <answer fraction="${fraction}" format="html">`);
        lines.push(`      <text>${cdata(`<p>${optText}</p>`)}</text>`);
        lines.push('      <feedback format="html">');
        if (isCorrect && q.explanation) {
          lines.push(`        <text>${cdata(`<p>✓ ${q.explanation}</p>`)}</text>`);
        } else {
          lines.push('        <text></text>');
        }
        lines.push('      </feedback>');
        lines.push('    </answer>');
      });

      lines.push('  </question>');
    } else {
      // ----------------------------------------------------------------------
      // 3. Single Choice Question (single: true)
      // ----------------------------------------------------------------------
      const correctIdx = typeof q.correctAnswerIndex === 'number' ? q.correctAnswerIndex : 0;

      lines.push(`  <!-- Question ${qNum}: Single Choice -->`);
      lines.push('  <question type="multichoice">');
      lines.push('    <name>');
      lines.push(`      <text>${cdata(`Câu ${qNum}: ${shortName || 'Trắc nghiệm'}`)}</text>`);
      lines.push('    </name>');
      lines.push('    <questiontext format="html">');
      lines.push(`      <text>${cdata(`<p>${q.questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (q.explanation && q.explanation.trim()) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${q.explanation.trim()}</p>`)}</text>`);
        lines.push('    </generalfeedback>');
      } else {
        lines.push('    <generalfeedback format="html">');
        lines.push('      <text></text>');
        lines.push('    </generalfeedback>');
      }

      lines.push(`    <defaultgrade>${grade.toFixed(7)}</defaultgrade>`);
      lines.push('    <penalty>0.3333333</penalty>');
      lines.push('    <hidden>0</hidden>');
      lines.push('    <idnumber></idnumber>');
      lines.push('    <single>true</single>');
      lines.push('    <shuffleanswers>true</shuffleanswers>');
      lines.push('    <answernumbering>abc</answernumbering>');
      lines.push('    <showstandardinstruction>0</showstandardinstruction>');
      lines.push('    <correctfeedback format="html">');
      lines.push(`      <text>${cdata('<p>Chính xác! Bạn đã chọn câu trả lời đúng.</p>')}</text>`);
      lines.push('    </correctfeedback>');
      lines.push('    <partiallycorrectfeedback format="html">');
      lines.push(`      <text>${cdata('<p>Câu trả lời của bạn đúng một phần.</p>')}</text>`);
      lines.push('    </partiallycorrectfeedback>');
      lines.push('    <incorrectfeedback format="html">');
      lines.push(`      <text>${cdata('<p>Chưa chính xác. Hãy xem lại lời giải thích.</p>')}</text>`);
      lines.push('    </incorrectfeedback>');

      (q.options || []).forEach((optText, optIdx) => {
        const isCorrect = optIdx === correctIdx;
        const fraction = isCorrect ? '100' : '0';
        lines.push(`    <answer fraction="${fraction}" format="html">`);
        lines.push(`      <text>${cdata(`<p>${optText}</p>`)}</text>`);
        lines.push('      <feedback format="html">');
        if (isCorrect && q.explanation) {
          lines.push(`        <text>${cdata(`<p>✓ ${q.explanation}</p>`)}</text>`);
        } else {
          lines.push('        <text></text>');
        }
        lines.push('      </feedback>');
        lines.push('    </answer>');
      });

      lines.push('  </question>');
    }
  });

  lines.push('</quiz>');
  return lines.join('\n');
}

