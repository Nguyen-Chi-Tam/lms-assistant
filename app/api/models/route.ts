import { NextRequest, NextResponse } from 'next/server';
import { getAvailableModels } from '@/models/registry';
import { getUserApiKeysMap } from '@/lib/key-manager';
import { PUTER_MODELS, buildPuterModelSelector } from '@/app/lib/puter-models';

export async function GET(request: NextRequest) {
  const allowExternal = request.nextUrl.searchParams.get('external') === 'true';
  const includeAll = request.nextUrl.searchParams.get('all') === 'true';
  const userIdStr = request.nextUrl.searchParams.get('userId') || request.headers.get('x-user-id');
  const userId = userIdStr ? parseInt(userIdStr, 10) : undefined;

  let userKeys;
  if (userId && !isNaN(userId) && userId > 0) {
    try {
      userKeys = await getUserApiKeysMap(userId);
    } catch {
      // ignore
    }
  }

  // Puter.js models: the 3 system models (GPT-4o mini, GPT-4.1 mini, DeepSeek Chat)
  // are placed alongside OpenRouter and OrcaRouter in the system models lineup,
  // while Claude 3.5 Sonnet remains in its standalone browser lineup.
  type RouteModel = {
    id: string;
    provider: string;
    modelId: string;
    label: string;
    available: boolean;
    isSystem?: boolean;
    keyMode?: 'system' | 'byok';
  };

  const systemPuterModels: RouteModel[] = PUTER_MODELS.map(model => ({
    id: buildPuterModelSelector(model.id),
    provider: 'puter',
    modelId: model.id,
    label: model.label,
    available: true,
    isSystem: true,
  }));

  const systemModels: RouteModel[] = getAvailableModels(allowExternal, userKeys);

  // Position system Puter models alongside OpenRouter / OrcaRouter in the lineup
  let insertIndex = -1;
  for (let i = systemModels.length - 1; i >= 0; i--) {
    if (systemModels[i].provider === 'openrouter' || systemModels[i].provider === 'orcarouter') {
      insertIndex = i;
      break;
    }
  }

  const combinedSystemModels: RouteModel[] = [...systemModels];
  if (insertIndex !== -1) {
    combinedSystemModels.splice(insertIndex + 1, 0, ...systemPuterModels);
  } else {
    combinedSystemModels.push(...systemPuterModels);
  }

  const allModels: RouteModel[] = [...combinedSystemModels];
  const models = includeAll ? allModels : allModels.filter(m => m.available);
  return NextResponse.json({ models });
}
