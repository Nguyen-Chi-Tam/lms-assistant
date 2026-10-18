import Anthropic from '@anthropic-ai/sdk';
import { runtimeEnv } from '@/db/runtime';

let anthropicClient: Anthropic | null = null;
let lastAnthropicKey = '';

export function getAnthropicClient(): Anthropic | null {
  const currentKey = runtimeEnv().ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!currentKey || currentKey.startsWith('sk-ant-your') || currentKey === 'sk-ant-...') {
    return null;
  }
  if (!anthropicClient || lastAnthropicKey !== currentKey) {
    lastAnthropicKey = currentKey;
    anthropicClient = new Anthropic({
      apiKey: currentKey,
    });
  }
  return anthropicClient;
}

export const ANTHROPIC_MODELS = [
  { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet' },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
];
