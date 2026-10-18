import OpenAI from 'openai';
import { runtimeEnv } from '@/db/runtime';

let openaiClient: OpenAI | null = null;
let lastOpenAIKey = '';

export function getOpenAIClient(): OpenAI | null {
  const currentKey = runtimeEnv().OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!currentKey || currentKey.startsWith('sk-proj-your') || currentKey === 'sk-...') {
    return null;
  }
  if (!openaiClient || lastOpenAIKey !== currentKey) {
    lastOpenAIKey = currentKey;
    openaiClient = new OpenAI({
      apiKey: currentKey,
    });
  }
  return openaiClient;
}

export const OPENAI_MODELS = [
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
];
