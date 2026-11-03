import { NextRequest, NextResponse } from 'next/server';
import { getAvailableModels } from '@/models/registry';
import { getUserApiKeysMap } from '@/lib/key-manager';

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

  const allModels = getAvailableModels(allowExternal, userKeys);
  const models = includeAll ? allModels : allModels.filter(m => m.available);
  return NextResponse.json({ models });
}
