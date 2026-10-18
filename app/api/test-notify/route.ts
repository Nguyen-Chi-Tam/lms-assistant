import { NextResponse } from 'next/server';
import { processNotificationEvents } from '@/lib/event-notification-service';
import { adminMessaging } from '@/lib/firebase-admin';
import { getDb } from '@/db';
import { fcmTokens } from '@/db/schema';
import { supabaseAdmin } from '@/lib/supabase';
import { eq } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const isDirectTest = searchParams.get('direct') === 'true';
    const rawUserId = searchParams.get('userId');
    const targetUserId = rawUserId ? Number(rawUserId) : 4;

    // DIRECT TEST MODE: Sends an immediate push notification to verify OS/browser banner
    if (isDirectTest) {
      let tokens: string[] = [];
      const dbInst = getDb();
      if (dbInst) {
        try {
          const rows = await dbInst
            .select()
            .from(fcmTokens)
            .where(eq(fcmTokens.userId, targetUserId));
          tokens = rows.map((r) => r.token);
        } catch {
          // fallback to supabase
        }
      }

      if (tokens.length === 0 && supabaseAdmin) {
        const { data } = await supabaseAdmin
          .from('fcm_tokens')
          .select('token')
          .eq('user_id', targetUserId);
        tokens = (data || []).map((r) => r.token);
      }

      if (tokens.length === 0) {
        return NextResponse.json({
          success: false,
          error: `Không tìm thấy FCM token nào cho user_id = ${targetUserId}. Hãy đảm bảo bạn đã đăng nhập và cho phép thông báo trên trình duyệt.`,
        });
      }

      const testPayload = {
        notification: {
          title: '🔔 Thông báo LMS Assistant',
          body: `Kiểm tra gửi thông báo đẩy thành công lúc ${new Date().toLocaleTimeString('vi-VN')}!`,
        },
        data: {
          tag: `test-${Date.now()}`,
          url: '/home',
          timestamp: String(Date.now()),
        },
        webpush: {
          headers: {
            Urgency: 'high',
            TTL: '86400',
          },
          notification: {
            requireInteraction: true,
            icon: '/lms-assistant-icon.png',
            badge: '/lms-assistant-icon.png',
          },
        },
        tokens,
      };

      const result = await adminMessaging.sendEachForMulticast(testPayload);
      return NextResponse.json({
        success: result.successCount > 0,
        mode: 'direct_test',
        tokensTargeted: tokens.length,
        result,
      });
    }

    // NORMAL MODE: Process events from events table
    const result = await processNotificationEvents();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Lỗi khi chạy test-notify:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
