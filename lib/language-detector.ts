/**
 * Language Detection & Prompt Conformance Utility:
 * Enforces the AI team to use the EXACT language of the user prompt (English, Spanish, French, etc.)
 * while keeping Vietnamese as the ALWAYS-ACTIVE default.
 */

export type SupportedLanguage = 'vi' | 'en' | 'es' | 'fr' | 'de' | 'ja' | 'zh' | 'other';

/**
 * Detects the dominant language of a user prompt or topic.
 * Zero-latency (heuristic regex & vocabulary matching).
 * Vietnamese is ALWAYS the default if ambiguous or unaccented.
 */
export function detectPromptLanguage(text: string): SupportedLanguage {
  if (!text || typeof text !== 'string') return 'vi';
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'vi';

  // 1. Vietnamese detection (highest priority if tone diacritics present)
  const VIETNAMESE_DIACRITICS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
  if (VIETNAMESE_DIACRITICS.test(trimmed)) {
    return 'vi';
  }

  // 2. Japanese detection (Hiragana / Katakana)
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(trimmed)) {
    return 'ja';
  }

  // 3. Chinese detection (CJK characters without Kana)
  if (/[\u4E00-\u9FFF]/.test(trimmed)) {
    return 'zh';
  }

  // 4. Spanish unique punctuation/letters (¿, ¡, ñ)
  if (/[¿¡ñ]/i.test(trimmed)) {
    return 'es';
  }

  // 5. Unaccented Vietnamese common keywords
  if (
    /\b(khong|duoc|trong|nguoi|sinh\s+vien|giang\s+vien|bai\s+tap|cau\s+hoi|giao\s+trinh|tai\s+lieu|hoc\s+phan|thay\s+oi|co\s+oi|em\s+hoi|mon\s+hoc|de\s+thi)\b/i.test(
      trimmed
    )
  ) {
    return 'vi';
  }

  // 6. Spanish vocabulary matches
  const spanishHits = (
    trimmed.match(
      /\b(el|la|los|las|un|una|unos|unas|del|al|con|sin|sobre|para|por|como|donde|cuando|porque|cuál|cuáles|explicar|crear|generar|pregunta|preguntas|respuesta|respuestas|hola|gracias|curso|estudiante|profesor)\b/gi
    ) || []
  ).length;

  // 7. French vocabulary matches
  const frenchHits = (
    trimmed.match(
      /\b(le|la|les|un|une|des|du|dans|avec|pour|sur|comment|pourquoi|est|sont|cette|cours|étudiant|professeur|expliquer|créer|question|questions|réponse|réponses|bonjour|merci)\b/gi
    ) || []
  ).length;

  // 8. German vocabulary matches
  const germanHits = (
    trimmed.match(
      /\b(der|die|das|den|dem|des|ein|eine|einer|einem|einen|und|oder|mit|ohne|für|auf|wie|warum|ist|sind|kurs|student|lehrer|erklären|erstellen|frage|fragen|antwort|antworten|bitte|danke)\b/gi
    ) || []
  ).length;

  // 9. English vocabulary matches
  const englishHits = (
    trimmed.match(
      /\b(the|is|are|was|were|be|been|what|how|why|when|where|who|which|explain|describe|create|generate|summarize|compare|difference|between|with|from|this|that|these|those|please|course|student|teacher|question|questions|answer|answers|code|example|function|system|data|write|give|solve|list|review|analyze|analysis|quiz|exam|test|help)\b/gi
    ) || []
  ).length;

  if (spanishHits >= 2 && spanishHits > englishHits && spanishHits > frenchHits) {
    return 'es';
  }

  if (frenchHits >= 2 && frenchHits > englishHits) {
    return 'fr';
  }

  if (germanHits >= 2 && germanHits > englishHits) {
    return 'de';
  }

  if (englishHits >= 1) {
    return 'en';
  }

  // Default fallback: Vietnamese is ALWAYS the default
  return 'vi';
}

/**
 * Returns human-readable language label.
 */
export function getLanguageDisplayName(lang: SupportedLanguage): string {
  switch (lang) {
    case 'en':
      return 'English';
    case 'es':
      return 'Español (Spanish)';
    case 'fr':
      return 'Français (French)';
    case 'de':
      return 'Deutsch (German)';
    case 'ja':
      return '日本語 (Japanese)';
    case 'zh':
      return '中文 (Chinese)';
    case 'vi':
    default:
      return 'Tiếng Việt (Vietnamese)';
  }
}

/**
 * Builds the Universal Language Directive to be appended to system instructions.
 * If the user's prompt is in English, Spanish, etc., the directive commands the AI team
 * to respond in that exact language. Otherwise, it enforces Vietnamese as default.
 */
export function buildUniversalLanguageDirective(userPrompt?: string): string {
  const lang = detectPromptLanguage(userPrompt || '');

  if (lang === 'en') {
    return `[MANDATORY LANGUAGE CONFORMANCE RULE]:
- The user's prompt is in ENGLISH. You MUST respond completely in ENGLISH.
- Write all explanations, analyses, instructions, questions, options, and descriptions in ENGLISH.
- Maintain academic tone and clarity in English. Preserve technical code/API terms inside \`code\` blocks.`;
  }

  if (lang === 'es') {
    return `[REGLA OBLIGATORIA DE CONFORMIDAD DE IDIOMA]:
- La pregunta del usuario está en ESPAÑOL. DEBES responder completamente en ESPAÑOL.
- Escribe todas las explicaciones, análisis, instrucciones, preguntas, opciones y descripciones en ESPAÑOL.
- Conserva los términos técnicos de código/API dentro de bloques \`code\`.`;
  }

  if (lang === 'fr') {
    return `[RÈGLE OBLIGATOIRE DE CONFORMITÉ LINGUISTIQUE]:
- L'invite de l'utilisateur est en FRANÇAIS. Vous DEVEZ répondre entièrement en FRANÇAIS.
- Rédigez toutes les explications, analyses, questions et descriptions en FRANÇAIS.`;
  }

  if (lang === 'de') {
    return `[VERPFLICHTENDE SPRACHANPASSUNGSREGEL]:
- Die Anfrage des Benutzers ist auf DEUTSCH. Sie MÜSSEN vollständig auf DEUTSCH antworten.
- Verfassen Sie alle Erklärungen, Analysen, Fragen und Beschreibungen auf DEUTSCH.`;
  }

  if (lang === 'ja') {
    return `[言語適応規則 - 必須]:
- ユーザーのプロンプトは日本語です。完全に日本語で回答してください。
- すべての説明、分析、指示、および内容を日本語で記述してください。`;
  }

  if (lang === 'zh') {
    return `[语言匹配强制规则]:
- 用户的提示词为中文。必须完全使用中文进行回答。
- 所有解释、分析、问题和说明必须全部使用中文。`;
  }

  // Default: Vietnamese (always the default for Vietnamese or ambiguous/unspecified queries)
  return `[QUY TẮC NGÔN NGỮ BẮT BUỘC (LANGUAGE ADAPTABILITY RULE)]:
1. PHẢN HỒI THEO ĐÚNG NGÔN NGỮ CỦA PROMPT: Bắt buộc nhận diện và sử dụng CHÍNH XÁC ngôn ngữ mà người dùng sử dụng trong câu hỏi / yêu cầu (ví dụ: English nếu hỏi bằng tiếng Anh, Español nếu hỏi bằng tiếng Tây Ban Nha, Français nếu tiếng Pháp, v.v.).
2. TIẾNG VIỆT LUÔN LÀ NGÔN NGỮ MẶC ĐỊNH (VIETNAMESE IS ALWAYS THE DEFAULT): Nếu câu hỏi bằng tiếng Việt, hoặc ngôn ngữ không rõ ràng / hỗn hợp, bạn BẮT BUỘC phản hồi hoàn toàn bằng Tiếng Việt chuẩn mực sư phạm.`;
}

/**
 * Returns the Circuit Breaker notice in the user's prompt language.
 */
export function getCircuitBreakerNotice(userPrompt?: string): string {
  const lang = detectPromptLanguage(userPrompt || '');
  switch (lang) {
    case 'en':
      return 'The current course materials do not contain this information.';
    case 'es':
      return 'Los materiales actuales del curso no contienen esta información.';
    case 'fr':
      return 'Les documents actuels du cours ne contiennent pas cette information.';
    case 'de':
      return 'Die aktuellen Kursunterlagen enthalten diese Informationen nicht.';
    case 'ja':
      return '現在のコース資料にはこの情報が含まれていません。';
    case 'zh':
      return '当前的课程资料中不包含此信息。';
    case 'vi':
    default:
      return 'Tài liệu khóa học hiện tại không chứa thông tin này.';
  }
}

