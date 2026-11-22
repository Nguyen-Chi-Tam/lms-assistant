/**
 * Puter.js runs entirely in the browser (see `app/components/providers/PuterProvider.tsx`).
 * These entries let students pick a Puter model, health-check the SDK from the model
 * selector, and generate tutor answers in the browser. The server only provides the
 * retrieved context: it never calls Puter itself.
 */

export const PUTER_DEFAULT_MODEL = 'gpt-4o-mini';

export const PUTER_MODEL_SELECTOR_PREFIX = 'puter:';

export interface PuterModelDefinition {
  id: string;
  label: string;
  isSystem?: boolean;
}

export const PUTER_MODELS: PuterModelDefinition[] = [
  { id: PUTER_DEFAULT_MODEL, label: 'Puter GPT-4o mini', isSystem: true },
  { id: 'gpt-4.1-mini', label: 'Puter GPT-4.1 mini', isSystem: true },
  { id: 'deepseek-chat', label: 'Puter DeepSeek Chat', isSystem: true },
];

export function buildPuterModelSelector(modelId: string): string {
  return `${PUTER_MODEL_SELECTOR_PREFIX}${modelId}`;
}

export function isPuterModelSelector(selector?: string | null): boolean {
  return Boolean(selector && selector.startsWith(PUTER_MODEL_SELECTOR_PREFIX));
}

export function parsePuterModelSelector(selector?: string | null): string | null {
  if (!isPuterModelSelector(selector)) return null;
  const modelId = (selector as string).slice(PUTER_MODEL_SELECTOR_PREFIX.length).trim();
  return modelId || null;
}

export function isPuterSystemModel(modelId?: string | null): boolean {
  if (!modelId) return false;
  const def = PUTER_MODELS.find(m => m.id === modelId);
  return Boolean(def?.isSystem);
}
