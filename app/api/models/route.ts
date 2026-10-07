import { NextRequest, NextResponse } from 'next/server';
import { getAvailableModels } from '@/models/registry';

export async function GET(request: NextRequest) {
  const allowExternal = request.nextUrl.searchParams.get('external') === 'true';
  const includeAll = request.nextUrl.searchParams.get('all') === 'true';
  const allModels = getAvailableModels(allowExternal);
  const models = includeAll ? allModels : allModels.filter(m => m.available);
  return NextResponse.json({ models });
}
