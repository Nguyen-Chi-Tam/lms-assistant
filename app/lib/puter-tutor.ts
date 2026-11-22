import type { CitationSource, RagMode } from '@/app/types';
import { stripCitationMarkers } from '@/lib/anti-fluff';

/**
 * Payload returned by `/api/tutor` when a Puter.js model is selected.
 * Retrieval, guards and prompt building stay on the server; only the final
 * generation runs in the browser through `askPuterStream`.
 */
export interface PuterTutorJob {
  puterJob: true;
  modelId: string;
  system: string;
  userPrompt: string;
  ragMode: RagMode;
  temperature?: number;
  maxTokens?: number;
  sourceCandidates?: Array<{
    name: string;
    chapter?: string | number;
    score?: number;
  }>;
  isParametricFallback?: boolean;
  outOfContextNotice?: string;
}

/**
 * Mirrors the server's source compilation for the Puter path:
 * course-material pills, the hybrid fallback pill, and markdown web links.
 */
export function finalizePuterTutorAnswer(
  job: PuterTutorJob,
  aiText: string
): { text: string; sources: CitationSource[] } {
  let text = aiText.trim();
  const isOutOfContext = job.ragMode === 'strict' && /\[(OUT_OF_CONTEXT|MISSING_CONTEXT)\]/i.test(text);

  if (isOutOfContext && job.outOfContextNotice) {
    text = job.outOfContextNotice;
  } else {
    text = text.replace(/\[(OUT_OF_CONTEXT|MISSING_CONTEXT)\]/gi, '').trim();
  }

  text = stripCitationMarkers(text);

  const sources: CitationSource[] = [];
  const seen = new Set<string>();

  for (const candidate of job.sourceCandidates || []) {
    const name = candidate.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      name,
      type: 'course_material',
      isExternal: false,
      chapter: candidate.chapter,
      score: candidate.score,
    });
  }

  if (!isOutOfContext && (job.isParametricFallback || (job.ragMode === 'hybrid' && sources.length === 0))) {
    sources.push({
      name: 'Kiến thức tham khảo ngoài giáo trình',
      type: 'extended_knowledge',
      isExternal: true,
      isFallback: true,
    });
  }

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const url = match[2].trim();
    if (!url) continue;
    if (sources.some(source => source.url === url || source.name === name)) continue;
    sources.push({ name, type: 'external_web', isExternal: true, url });
  }

  return { text, sources };
}
