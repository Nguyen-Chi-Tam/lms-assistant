import { NextResponse } from 'next/server';
import { processNotificationEvents } from '@/lib/event-notification-service';
import { runtimeEnv } from '@/db/runtime';

export async function GET(request: Request) {
  try {
    // Optional secret check if CRON_SECRET is configured
    const { CRON_SECRET: cronSecret } = runtimeEnv();
    if (cronSecret) {
      const authHeader = request.headers.get('authorization');
      const { searchParams } = new URL(request.url);
      const querySecret = searchParams.get('secret') || searchParams.get('key');
      if (authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
        return NextResponse.json(
          { error: 'Unauthorized: Thiếu hoặc sai CRON_SECRET. Gắn header Authorization: Bearer <CRON_SECRET> hoặc param ?secret=<CRON_SECRET>' },
          { status: 401 }
        );
      }
    }

    const result = await processNotificationEvents();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Lỗi khi chạy cron notify:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

