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

/**
 * Strips control characters that are illegal in XML 1.0 documents and trims
 * surrounding whitespace. Tab (\t), newline (\n) and carriage return (\r) are
 * preserved because they are valid and occasionally meaningful.
 */
function sanitizeText(unsafe: string | null | undefined): string {
  if (!unsafe) return '';
  return String(unsafe).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function escapeXml(unsafe: string): string {
  return sanitizeText(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(content: string): string {
  const safe = sanitizeText(content).replace(/\]\]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

/**
 * Moodle treats "/" (and "\") in a category path as a hierarchy separator, so a
 * course name such as "Toán / Lý" would silently become two nested categories.
 * Replace separators with a dash and collapse whitespace to keep the category flat.
 */
function sanitizeCategoryName(name: string): string {
  return sanitizeText(name).replace(/[/\\]+/g, '-').replace(/\s+/g, ' ').trim();
}

export function convertQuestionsToMoodleXml(
  questions: QuizQuestionItem[],
  categoryName?: string
): string {
  const safeCategory = categoryName ? sanitizeCategoryName(categoryName) : '';
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<quiz>',
  ];

  if (safeCategory) {
    lines.push('  <!-- Question Category -->');
    lines.push('  <question type="category">');
    lines.push('    <category>');
    lines.push(`      <text>$course$/top/${escapeXml(safeCategory)}</text>`);
    lines.push('    </category>');
    lines.push('  </question>');
  }

  questions.forEach((q, idx) => {
    const qNum = idx + 1;
    const questionText = sanitizeText(q.questionText);
    const cleanTitle = questionText.replace(/<[^>]*>/g, '').trim();
    const shortName = cleanTitle.length > 50 ? `${cleanTitle.slice(0, 47)}...` : cleanTitle;
    const grade = q.defaultGrade ?? 1;
    const explanation = sanitizeText(q.explanation);
    const options = (q.options || []).map(sanitizeText).filter(Boolean);
    const pairs = (q.pairs || [])
      .map(p => ({ left: sanitizeText(p.left), right: sanitizeText(p.right) }))
      .filter(p => p.left && p.right);
    const acceptedAnswers = (q.acceptedAnswers || []).map(sanitizeText).filter(Boolean);

    const isMatching = q.type === 'matching' || pairs.length >= 2;
    const isShortAnswer = q.type === 'shortanswer' || (!isMatching && acceptedAnswers.length > 0);
    const isTrueFalse =
      q.type === 'truefalse' ||
      (!isMatching && !isShortAnswer && options.length === 2 &&
        (options[0].toLowerCase().includes('đúng') || options[0].toLowerCase().includes('true')));
    const isMultiSelect =
      q.type === 'multiselect' ||
      (!isMatching && !isShortAnswer && !isTrueFalse &&
        Array.isArray(q.correctAnswerIndices) && q.correctAnswerIndices.length > 1);

    // Nothing renderable (e.g. a multichoice with no options) would produce an
    // invalid question that Moodle rejects. Skip it instead of emitting garbage.
    if (!isMatching && !isShortAnswer && !isTrueFalse && options.length === 0) {
      return;
    }

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
      lines.push(`      <text>${cdata(`<p>${questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (explanation) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${explanation}</p>`)}</text>`);
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

      pairs.forEach(pair => {
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
      lines.push(`      <text>${cdata(`<p>${questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (explanation) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${explanation}</p>`)}</text>`);
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

      const answers = acceptedAnswers.length > 0
        ? acceptedAnswers
        : options.length > 0 ? options : [questionText || 'Đáp án'];

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
      const firstOptText = (options[0] || '').toLowerCase();
      const isStatementTrue = firstOptText.includes('đúng') || firstOptText.includes('true') ? firstOptIsCorrect : !firstOptIsCorrect;

      lines.push(`  <!-- Question ${qNum}: True/False -->`);
      lines.push('  <question type="truefalse">');
      lines.push('    <name>');
      lines.push(`      <text>${cdata(`Câu ${qNum} [Đúng/Sai]: ${shortName || 'True/False'}`)}</text>`);
      lines.push('    </name>');
      lines.push('    <questiontext format="html">');
      lines.push(`      <text>${cdata(`<p>${questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (explanation) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${explanation}</p>`)}</text>`);
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
      lines.push(`        <text>${isStatementTrue && explanation ? cdata(`<p>✓ ${explanation}</p>`) : ''}</text>`);
      lines.push('      </feedback>');
      lines.push('    </answer>');

      // Answer False
      lines.push(`    <answer fraction="${!isStatementTrue ? '100' : '0'}" format="html">`);
      lines.push(`      <text>false</text>`);
      lines.push('      <feedback format="html">');
      lines.push(`        <text>${!isStatementTrue && explanation ? cdata(`<p>✓ ${explanation}</p>`) : ''}</text>`);
      lines.push('      </feedback>');
      lines.push('    </answer>');

      lines.push('  </question>');
    } else if (isMultiSelect) {
      // ----------------------------------------------------------------------
      // 2. Multiple Select Question (single: false)
      // ----------------------------------------------------------------------
      const rawIndices = q.correctAnswerIndices && q.correctAnswerIndices.length > 0
        ? q.correctAnswerIndices
        : (typeof q.correctAnswerIndex === 'number' ? [q.correctAnswerIndex] : [0]);
      // Keep only in-range indices so at least one option is graded 100 and the
      // positive fractions sum to 100 (Moodle rejects malformed answer sets).
      const correctIndices = rawIndices
        .map(n => Number(n))
        .filter(n => Number.isInteger(n) && n >= 0 && n < options.length);
      if (correctIndices.length === 0 && options.length > 0) {
        correctIndices.push(0);
      }

      const correctCount = correctIndices.length;
      const safeOptions = options;
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
      lines.push(`      <text>${cdata(`<p>${questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (explanation) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${explanation}</p>`)}</text>`);
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
        if (isCorrect && explanation) {
          lines.push(`        <text>${cdata(`<p>✓ ${explanation}</p>`)}</text>`);
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
      // Clamp so exactly one option is graded 100 (an out-of-range index would
      // otherwise produce a question with no correct answer, which Moodle rejects).
      const safeCorrectIdx = options.length > 0 ? Math.min(Math.max(0, correctIdx), options.length - 1) : 0;

      lines.push(`  <!-- Question ${qNum}: Single Choice -->`);
      lines.push('  <question type="multichoice">');
      lines.push('    <name>');
      lines.push(`      <text>${cdata(`Câu ${qNum}: ${shortName || 'Trắc nghiệm'}`)}</text>`);
      lines.push('    </name>');
      lines.push('    <questiontext format="html">');
      lines.push(`      <text>${cdata(`<p>${questionText}</p>`)}</text>`);
      lines.push('    </questiontext>');

      if (explanation) {
        lines.push('    <generalfeedback format="html">');
        lines.push(`      <text>${cdata(`<p>${explanation}</p>`)}</text>`);
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

      options.forEach((optText, optIdx) => {
        const isCorrect = optIdx === safeCorrectIdx;
        const fraction = isCorrect ? '100' : '0';
        lines.push(`    <answer fraction="${fraction}" format="html">`);
        lines.push(`      <text>${cdata(`<p>${optText}</p>`)}</text>`);
        lines.push('      <feedback format="html">');
        if (isCorrect && explanation) {
          lines.push(`        <text>${cdata(`<p>✓ ${explanation}</p>`)}</text>`);
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

