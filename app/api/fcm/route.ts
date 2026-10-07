import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getDb } from '@/db';
import { fcmTokens, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

interface FcmRequestBody {
  userId?: number | string;
  token?: string;
  deviceId?: string;
  deviceType?: string;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userIdStr = searchParams.get('userId');

    if (!userIdStr) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      return NextResponse.json({ error: 'Invalid userId' }, { status: 400 });
    }

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('fcm_tokens')
        .select('*')
        .eq('user_id', userId);

      if (!error && data) {
        return NextResponse.json({ success: true, tokens: data });
      }
    }

    const db = getDb();
    if (db) {
      const rows = await db.select().from(fcmTokens).where(eq(fcmTokens.userId, userId));
      return NextResponse.json({ success: true, tokens: rows });
    }

    return NextResponse.json({ success: true, tokens: [] });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lấy token FCM.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as FcmRequestBody & { role?: string };
    const userId = Number(body?.userId);
    const token = body?.token?.trim();
    const deviceId = body?.deviceId?.trim() || 'web-browser';
    const deviceType = body?.deviceType || 'web';

    if (!userId || !token) {
      return NextResponse.json({ error: 'userId và token là bắt buộc' }, { status: 400 });
    }

    // Notifications and FCM tokens are strictly for STUDENTS.
    // Skip teachers completely as notifications are designed for students.
    if (body.role === 'teacher' || userId === 2) {
      return NextResponse.json({
        success: true,
        message: 'FCM token registration skipped for teachers (students only)',
        skipped: true,
      });
    }

    if (supabaseAdmin) {
      try {
        const { data: userRec } = await supabaseAdmin
          .from('users')
          .select('role')
          .eq('moodle_user_id', userId)
          .maybeSingle();

        if (userRec?.role === 'teacher') {
          return NextResponse.json({
            success: true,
            message: 'FCM token registration skipped for teachers (students only)',
            skipped: true,
          });
        }
      } catch (checkErr) {
        console.warn('Check user role warning in FCM:', checkErr);
      }
    }

    const db = getDb();
    if (db) {
      try {
        const dbUsers = await db.select({ role: users.role }).from(users).where(eq(users.moodleUserId, userId)).limit(1);
        if (dbUsers[0]?.role === 'teacher') {
          return NextResponse.json({
            success: true,
            message: 'FCM token registration skipped for teachers (students only)',
            skipped: true,
          });
        }
      } catch (dbCheckErr) {
        console.warn('Check db user role warning in FCM:', dbCheckErr);
      }
    }

    // 1. Ensure user exists in users table (due to foreign key constraint)
    if (supabaseAdmin) {
      try {
        await supabaseAdmin.from('users').upsert(
          {
            moodle_user_id: userId,
            role: 'student',
            name: `User ${userId}`,
          },
          { onConflict: 'moodle_user_id', ignoreDuplicates: true }
        );
      } catch (userErr) {
        console.warn('Supabase ensure user warning:', userErr);
      }
    }

    const now = new Date().toISOString();

    // 2. Upsert token into fcm_tokens table
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('fcm_tokens')
        .upsert(
          {
            user_id: userId,
            token,
            device_id: deviceId,
            device_type: deviceType,
            last_used_at: now,
          },
          { onConflict: 'token' }
        )
        .select();

      if (!error && data) {
        return NextResponse.json({
          success: true,
          message: 'FCM token registered successfully',
          token: data[0],
        });
      }

      if (error) {
        console.warn('Supabase FCM upsert error:', error);
      }
    }

    if (db) {
      try {
        await db
          .insert(fcmTokens)
          .values({
            userId,
            token,
            deviceId,
            deviceType,
            lastUsedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: fcmTokens.token,
            set: {
              userId,
              deviceId,
              lastUsedAt: new Date(),
            },
          });

        return NextResponse.json({ success: true, message: 'FCM token registered successfully' });
      } catch (dbErr) {
        console.warn('Drizzle FCM upsert error:', dbErr);
      }
    }

    return NextResponse.json({ success: true, message: 'FCM token processed' });
  } catch (error) {
    console.error('Lỗi khi lưu FCM token:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lưu FCM token.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    let body: FcmRequestBody = {};
    try {
      body = (await request.json()) as FcmRequestBody;
    } catch {
      // body may be empty on query-string delete
    }

    const { searchParams } = new URL(request.url);
    const token = (body.token || searchParams.get('token'))?.trim();
    const userId = Number(body.userId || searchParams.get('userId'));
    const deviceId = (body.deviceId || searchParams.get('deviceId'))?.trim();

    if (!token && !userId && !deviceId) {
      return NextResponse.json({ error: 'Cần cung cấp token, userId hoặc deviceId để xóa.' }, { status: 400 });
    }

    if (supabaseAdmin) {
      let query = supabaseAdmin.from('fcm_tokens').delete();
      if (token) {
        query = query.eq('token', token);
      } else if (userId && deviceId) {
        query = query.eq('user_id', userId).eq('device_id', deviceId);
      } else if (userId) {
        query = query.eq('user_id', userId);
      } else if (deviceId) {
        query = query.eq('device_id', deviceId);
      }

      const { error } = await query;
      if (!error) {
        return NextResponse.json({ success: true, message: 'FCM token removed successfully' });
      }
      console.warn('Supabase DELETE FCM error:', error);
    }

    const db = getDb();
    if (db) {
      try {
        if (token) {
          await db.delete(fcmTokens).where(eq(fcmTokens.token, token));
        } else if (userId && deviceId) {
          await db.delete(fcmTokens).where(and(eq(fcmTokens.userId, userId), eq(fcmTokens.deviceId, deviceId)));
        } else if (userId) {
          await db.delete(fcmTokens).where(eq(fcmTokens.userId, userId));
        } else if (deviceId) {
          await db.delete(fcmTokens).where(eq(fcmTokens.deviceId, deviceId));
        }

        return NextResponse.json({ success: true, message: 'FCM token removed successfully' });
      } catch (dbErr) {
        console.warn('Drizzle DELETE FCM error:', dbErr);
      }
    }

    return NextResponse.json({ success: true, message: 'FCM token deletion processed' });
  } catch (error) {
    console.error('Lỗi khi xóa FCM token:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi xóa FCM token.' },
      { status: 500 }
    );
  }
}

