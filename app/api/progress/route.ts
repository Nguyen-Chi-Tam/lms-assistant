import { NextResponse } from 'next/server';
import { currentUserId } from '../../../db/runtime';
import { getDb } from '../../../db';
import { learningArtifacts, users } from '../../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { supabaseAdmin } from '../../../lib/supabase';
import { getFirebaseRows, setFirebaseRow } from '@/lib/firebase-admin';

export async function GET() {
  const currentId = await currentUserId();
  const numericUserId = typeof currentId === 'number' ? currentId : parseInt(String(currentId), 10) || 4;

  try {
    const attempts = await getFirebaseRows('learning_artifacts', { user_id: numericUserId }, 20);
    if (!attempts) throw new Error('Firebase is not configured');
    const formatted = attempts
      .filter(a => a.artifact_type === 'quiz_analysis' || a.artifact_type === 'quiz_attempt')
      .map((a) => {
        const content = (a.content_data || {}) as Record<string, unknown>;
        return {
          id: a.id,
          courseCode: `QUIZ-${a.moodle_course_id}`,
          topic: (content.examName || content.topic || 'Kiểm tra năng lực') as string,
          score: (content.score || content.percentage || 0) as number,
          total: 100,
          durationSeconds: (content.durationSeconds || 0) as number,
          createdAt: Date.now(),
        };
      });
    return NextResponse.json({ attempts: formatted, mode: 'live' });
  } catch (firebaseError) {
    console.warn('Firebase GET progress warning:', firebaseError);
  }

  // Legacy fallback for local environments without Firebase credentials.
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('learning_artifacts')
        .select('*')
        .eq('user_id', numericUserId)
        .in('artifact_type', ['quiz_analysis', 'quiz_attempt'])
        .order('id', { ascending: false })
        .limit(20);

      if (!error && data) {
        const formatted = data.map((a) => {
          const content = (a.content_data || {}) as Record<string, unknown>;
          return {
            id: a.id,
            courseCode: `QUIZ-${a.moodle_course_id}`,
            topic: (content.examName || content.topic || 'Kiểm tra năng lực') as string,
            score: (content.score || content.percentage || 0) as number,
            total: 100,
            durationSeconds: (content.durationSeconds || 0) as number,
            createdAt: Date.now(),
          };
        });

        return NextResponse.json({ attempts: formatted, mode: 'live' });
      }
    } catch (sbErr) {
      console.warn('Supabase GET progress warning:', sbErr);
    }
  }

  // 2. Try Drizzle
  const db = getDb();
  if (db) {
    try {
      const attempts = await db
        .select()
        .from(learningArtifacts)
        .where(eq(learningArtifacts.userId, numericUserId))
        .orderBy(desc(learningArtifacts.id))
        .limit(20);

      const formatted = attempts
        .filter(a => a.artifactType === 'quiz_analysis' || a.artifactType === 'quiz_attempt')
        .map((a) => {
          const content = (a.contentData || {}) as Record<string, unknown>;
          return {
            id: a.id,
            courseCode: `QUIZ-${a.moodleCourseId}`,
            topic: (content.examName || content.topic || 'Kiểm tra năng lực') as string,
            score: (content.score || content.percentage || 0) as number,
            total: 100,
            durationSeconds: (content.durationSeconds || 0) as number,
            createdAt: Date.now(),
          };
        });

      return NextResponse.json({ attempts: formatted, mode: 'live' });
    } catch (dbErr) {
      console.warn('Drizzle GET progress warning:', dbErr);
    }
  }

  return NextResponse.json({ attempts: [], mode: 'preview' });
}

export async function POST(request: Request) {
  const currentId = await currentUserId();
  const numericUserId = typeof currentId === 'number' ? currentId : parseInt(String(currentId), 10) || 4;

  const body = (await request.json()) as {
    courseCode?: string;
    topic?: string;
    score?: number;
    total?: number;
    durationSeconds?: number;
    moodleQuizId?: number;
    moodleCourseId?: number;
    aiFeedback?: string;
  };

  const moodleCourseId = body.moodleCourseId || body.moodleQuizId || 1;
  const scoreVal = typeof body.score === 'number' ? body.score : 0;
  const feedback = body.aiFeedback || (body.topic ? `Chủ đề: ${body.topic}` : null);

  const artifactData = {
    score: scoreVal,
    total: body.total || 100,
    topic: body.topic || 'Kiểm tra năng lực',
    aiFeedback: feedback,
    durationSeconds: body.durationSeconds || 0,
  };

  try {
    const saved = await setFirebaseRow('learning_artifacts', crypto.randomUUID(), {
      user_id: numericUserId,
      moodle_course_id: moodleCourseId,
      artifact_type: 'quiz_attempt',
      content_data: artifactData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (saved) return NextResponse.json({ saved: true, id: saved.id }, { status: 201 });
  } catch (firebaseError) {
    console.warn('Firebase POST progress warning:', firebaseError);
  }

  // Legacy fallback for local environments without Firebase credentials.
  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('users').upsert(
        { moodle_user_id: numericUserId, role: numericUserId === 2 ? 'teacher' : 'student', name: numericUserId === 2 ? 'Admin User' : 'Sinh viên' },
        { onConflict: 'moodle_user_id', ignoreDuplicates: true }
      );

      const { data, error } = await supabaseAdmin
        .from('learning_artifacts')
        .insert({
          user_id: numericUserId,
          moodle_course_id: moodleCourseId,
          artifact_type: 'quiz_attempt',
          content_data: artifactData,
        })
        .select()
        .single();

      if (!error && data) {
        return NextResponse.json({ saved: true, id: data.id }, { status: 201 });
      }
    } catch (sbErr) {
      console.warn('Supabase POST progress warning:', sbErr);
    }
  }

  // 2. Try Drizzle
  const db = getDb();
  if (db) {
    try {
      const existingUsers = await db.select().from(users).where(eq(users.moodleUserId, numericUserId)).limit(1);
      if (existingUsers.length === 0) {
        await db.insert(users).values({
          moodleUserId: numericUserId,
          role: 'student',
          name: 'Sinh viên',
        });
      }

      const [newArtifact] = await db
        .insert(learningArtifacts)
        .values({
          userId: numericUserId,
          moodleCourseId,
          artifactType: 'quiz_attempt',
          contentData: artifactData,
        })
        .returning();

      return NextResponse.json({ saved: true, id: newArtifact.id }, { status: 201 });
    } catch (dbErr) {
      console.warn('Drizzle POST progress warning:', dbErr);
    }
  }

  return NextResponse.json({ saved: true, id: crypto.randomUUID(), mode: 'preview' }, { status: 201 });
}

