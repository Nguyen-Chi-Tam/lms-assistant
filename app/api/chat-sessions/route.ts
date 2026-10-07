import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { chatSessions, users } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { supabaseAdmin } from '@/lib/supabase';
import { deleteFirebaseRow, getFirebaseRows, setFirebaseRow } from '@/lib/firebase-admin';
import { stripFluff } from '@/lib/anti-fluff';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const moodleCourseIdStr = searchParams.get('moodleCourseId') || searchParams.get('courseId');
    const userIdStr = searchParams.get('userId') || searchParams.get('moodleUserId');
    const sessionId = searchParams.get('sessionId') || searchParams.get('id');
    const role = searchParams.get('role'); // 'teacher' | 'student'

    if (!userIdStr && !sessionId) {
      return NextResponse.json(
        { error: 'Vui lòng cung cấp userId hoặc sessionId.' },
        { status: 400 }
      );
    }

    const userId = userIdStr ? parseInt(userIdStr, 10) : null;
    const moodleCourseId = moodleCourseIdStr ? parseInt(moodleCourseIdStr, 10) : null;

    try {
      const filterObj: Record<string, string | number | undefined> = {
        user_id: userId || undefined,
        moodle_course_id: moodleCourseId || undefined,
      };
      if (role) filterObj.role = role;

      const sessions = await getFirebaseRows('chat_sessions', filterObj);
      if (sessions) {
        const filtered = sessionId ? sessions.filter((session) => session.id === sessionId) : sessions;
        filtered.forEach((sess: any) => {
          if (Array.isArray(sess.messages)) {
            sess.messages.forEach((msg: any) => {
              if (sess.response_model && (msg.role === 'ai' || msg.role === 'assistant') && !msg.model) {
                msg.model = sess.response_model;
              }
              if ((msg.role === 'ai' || msg.role === 'assistant') && typeof msg.text === 'string') {
                msg.text = stripFluff(msg.text);
              }
            });
          }
        });
        return NextResponse.json({
          success: true,
          sessions: filtered,
          latest: filtered.length > 0 ? filtered[0] : null,
        });
      }
    } catch (firebaseError) {
      console.warn('Firebase GET chat_sessions warning:', firebaseError);
    }

    // Legacy fallback for local environments without Firebase credentials.
    if (supabaseAdmin) {
      try {
        let query = supabaseAdmin.from('chat_sessions').select('*');
        if (sessionId) {
          query = query.eq('id', sessionId);
        } else {
          if (userId) query = query.eq('user_id', userId);
          if (moodleCourseId) query = query.eq('moodle_course_id', moodleCourseId);
        }

        const { data, error } = await query.order('updated_at', { ascending: false });
        if (!error && data) {
          return NextResponse.json({
            success: true,
            sessions: data,
            latest: data.length > 0 ? data[0] : null,
          });
        }
      } catch (sbErr) {
        console.warn('Supabase GET chat_sessions warning:', sbErr);
      }
    }

    // 2. Try Drizzle
    const db = getDb();
    if (db) {
      try {
        const conditions = [];
        if (sessionId) {
          conditions.push(eq(chatSessions.id, sessionId));
        } else {
          if (userId) conditions.push(eq(chatSessions.userId, userId));
          if (moodleCourseId) conditions.push(eq(chatSessions.moodleCourseId, moodleCourseId));
        }

        const sessions = await db
          .select()
          .from(chatSessions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(chatSessions.updatedAt));

        return NextResponse.json({
          success: true,
          sessions,
          latest: sessions.length > 0 ? sessions[0] : null,
        });
      } catch (dbErr) {
        console.warn('Drizzle GET chat_sessions warning:', dbErr);
      }
    }

    return NextResponse.json({
      success: true,
      sessions: [],
      latest: null,
    });
  } catch (error) {
    console.error('Error fetching chat sessions:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lấy phiên trò chuyện.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId?: string;
      id?: string;
      userId?: number;
      userName?: string;
      role?: 'teacher' | 'student';
      moodleCourseId?: number;
      response_model?: string;
      responseModel?: string;
      messages: Array<{
        id?: string;
        role: 'user' | 'assistant' | 'ai' | 'model';
        content?: string;
        text?: string;
        timestamp?: number | string;
        model?: string;
        sources?: unknown[];
      }>;
    };

    const targetSessionId = body.sessionId || body.id;
    const userId = Number(body.userId) || 4; // default demo student ID
    const moodleCourseId = Number(body.moodleCourseId) || 1;
    const userRole = body.role || (userId === 2 ? 'teacher' : 'student');
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages.map(msg => {
      let text = (msg.text ?? msg.content ?? '').trim();
      if (msg.role === 'ai' || msg.role === 'assistant' || msg.role === 'model') {
        text = stripFluff(text);
      }
      const item: Record<string, unknown> = {
        id: msg.id || crypto.randomUUID(),
        role: msg.role === 'assistant' || msg.role === 'model' ? 'ai' : msg.role,
        text,
        timestamp: msg.timestamp || Date.now(),
      };
      if (msg.model) item.model = msg.model;
      if (Array.isArray(msg.sources) && msg.sources.length > 0) item.sources = msg.sources;
      return item;
    });

    const lastAiMsg = [...messages].reverse().find(m => m.role === 'ai');
    const response_model = body.response_model || body.responseModel || (lastAiMsg as any)?.model || undefined;

    try {
      let existingSessionId = targetSessionId;
      if (!existingSessionId) {
        const filter: Record<string, string | number | undefined> = {
          user_id: userId,
          moodle_course_id: moodleCourseId,
        };
        if (body.role) filter.role = body.role;
        const existingRows = await getFirebaseRows('chat_sessions', filter, 1);
        existingSessionId = existingRows?.[0]?.id;
      }

      const sessionId = existingSessionId || crypto.randomUUID();
      const sessionData: Record<string, unknown> = {
        user_id: userId,
        user_name: body.userName || (userRole === 'teacher' ? 'Giảng viên' : 'Sinh viên'),
        role: userRole,
        moodle_course_id: moodleCourseId,
        messages,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      if (response_model) {
        sessionData.response_model = response_model;
      }
      const session = await setFirebaseRow('chat_sessions', sessionId, sessionData);
      if (session) return NextResponse.json({ success: true, session });
    } catch (firebaseError) {
      console.warn('Firebase POST chat_sessions warning:', firebaseError);
    }

    // Legacy fallback for local environments without Firebase credentials.
    if (supabaseAdmin) {
      try {
        // Ensure user exists
        await supabaseAdmin.from('users').upsert(
          {
            moodle_user_id: userId,
            role: userId === 2 ? 'teacher' : 'student',
            name: body.userName || (userId === 2 ? 'Admin User' : 'Sinh viên'),
          },
          { onConflict: 'moodle_user_id', ignoreDuplicates: true }
        );

        let existingSessionId = targetSessionId;
        if (!existingSessionId) {
          const { data: existingRows } = await supabaseAdmin
            .from('chat_sessions')
            .select('id')
            .eq('user_id', userId)
            .eq('moodle_course_id', moodleCourseId)
            .order('updated_at', { ascending: false })
            .limit(100);
          existingSessionId = existingRows?.[0]?.id;
          const duplicateIds = (existingRows || []).slice(1).map(row => row.id);
          if (duplicateIds.length > 0) {
            await supabaseAdmin.from('chat_sessions').delete().in('id', duplicateIds);
          }
        }

        if (existingSessionId) {
          // Update existing session
          const { data, error } = await supabaseAdmin
            .from('chat_sessions')
            .update({
              messages,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingSessionId)
            .select()
            .single();

          if (!error && data) {
            return NextResponse.json({ success: true, session: data });
          }
        }

        // Insert new session
        const { data, error } = await supabaseAdmin
          .from('chat_sessions')
          .insert({
            user_id: userId,
            moodle_course_id: moodleCourseId,
            messages,
          })
          .select()
          .single();

        if (!error && data) {
          return NextResponse.json({ success: true, session: data });
        }
      } catch (sbErr) {
        console.warn('Supabase POST chat_sessions warning:', sbErr);
      }
    }

    // 2. Try Drizzle
    const db = getDb();
    if (db) {
      try {
        // Ensure user exists
        const existingUser = await db
          .select()
          .from(users)
          .where(eq(users.moodleUserId, userId))
          .limit(1);

        if (existingUser.length === 0) {
          await db.insert(users).values({
            moodleUserId: userId,
            role: 'student',
            name: body.userName || 'Sinh viên',
          });
        }

        let existingSessionId = targetSessionId;
        if (!existingSessionId) {
          const existingRows = await db
            .select({ id: chatSessions.id })
            .from(chatSessions)
            .where(and(eq(chatSessions.userId, userId), eq(chatSessions.moodleCourseId, moodleCourseId)))
            .orderBy(desc(chatSessions.updatedAt))
            .limit(100);
          existingSessionId = existingRows[0]?.id;
          const duplicateIds = existingRows.slice(1).map(row => row.id);
          for (const duplicateId of duplicateIds) {
            await db.delete(chatSessions).where(eq(chatSessions.id, duplicateId));
          }
        }

        if (existingSessionId) {
          const [updated] = await db
            .update(chatSessions)
            .set({
              messages,
              updatedAt: new Date(),
            })
            .where(eq(chatSessions.id, existingSessionId))
            .returning();

          if (updated) {
            return NextResponse.json({ success: true, session: updated });
          }
        }

        const [created] = await db
          .insert(chatSessions)
          .values({
            userId,
            moodleCourseId,
            messages,
          })
          .returning();

        return NextResponse.json({ success: true, session: created });
      } catch (dbErr) {
        console.warn('Drizzle POST chat_sessions warning:', dbErr);
      }
    }

    return NextResponse.json({
      success: true,
      mode: 'preview',
      session: {
        id: targetSessionId || 'preview-session-id',
        userId,
        moodleCourseId,
        messages,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error saving chat session:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lưu phiên trò chuyện.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || searchParams.get('id');
    const userId = Number(searchParams.get('userId')) || 0;
    const moodleCourseId = Number(searchParams.get('moodleCourseId') || searchParams.get('courseId')) || 0;
    const role = searchParams.get('role');

    if (!sessionId && (!userId || !moodleCourseId)) {
      return NextResponse.json({ error: 'Cần cung cấp sessionId hoặc userId và courseId.' }, { status: 400 });
    }

    try {
      let firebaseAvailable = false;
      if (sessionId) {
        firebaseAvailable = (await deleteFirebaseRow('chat_sessions', sessionId)) || false;
      } else {
        const filter: Record<string, string | number | undefined> = {
          user_id: userId,
          moodle_course_id: moodleCourseId,
        };
        if (role) filter.role = role;
        const sessions = await getFirebaseRows('chat_sessions', filter);
        if (sessions) {
          firebaseAvailable = true;
          await Promise.all(sessions.map((session) => deleteFirebaseRow('chat_sessions', session.id)));
        }
      }
      if (firebaseAvailable) return NextResponse.json({ success: true });
    } catch (firebaseError) {
      console.warn('Firebase DELETE chat_sessions warning:', firebaseError);
    }

    if (supabaseAdmin) {
      const query = supabaseAdmin.from('chat_sessions').delete();
      const { error } = sessionId
        ? await query.eq('id', sessionId)
        : await query.eq('user_id', userId).eq('moodle_course_id', moodleCourseId);
      if (!error) return NextResponse.json({ success: true });
      console.warn('Supabase DELETE chat_sessions warning:', error);
    }

    const db = getDb();
    if (db) {
      await db.delete(chatSessions).where(
        sessionId
          ? eq(chatSessions.id, sessionId)
          : and(eq(chatSessions.userId, userId), eq(chatSessions.moodleCourseId, moodleCourseId))
      );
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: true, mode: 'preview' });
  } catch (error) {
    console.error('Error deleting chat session:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi xóa lịch sử trò chuyện.' },
      { status: 500 }
    );
  }
}

