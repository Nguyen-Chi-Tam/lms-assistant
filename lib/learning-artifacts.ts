import { getSupabaseAdmin } from '@/lib/supabase';
import { getFirebaseRows, getFirebaseRow, setFirebaseRow, deleteFirebaseRow } from '@/lib/firebase-admin';
import type { QuizAnalysisData } from '@/app/types';

export interface SaveArtifactParams {
  userId: number;
  userName?: string;
  moodleCourseId: number;
  artifactType: 'quiz_analysis' | 'summary' | 'mindmap' | 'flashcard' | string;
  contentData: Record<string, unknown> | QuizAnalysisData;
}

export async function saveLearningArtifact(params: SaveArtifactParams) {
  const { userId, userName, moodleCourseId, artifactType, contentData } = params;
  const id = ((contentData as any)?.id && typeof (contentData as any).id === 'string' && (contentData as any).id.length > 10)
    ? (contentData as any).id
    : crypto.randomUUID();

  let savedRecord: any = null;

  // 1. Dual-Write to Supabase (so Supabase Studio reflects data in real-time)
  const supabase = getSupabaseAdmin();
  if (supabase) {
    try {
      await supabase.from('users').upsert(
        {
          moodle_user_id: userId,
          role: userId === 2 ? 'teacher' : 'student',
          name: userName || (userId === 2 ? 'Admin User' : 'Sinh viên'),
        },
        { onConflict: 'moodle_user_id', ignoreDuplicates: true }
      );

      const { data, error } = await supabase
        .from('learning_artifacts')
        .upsert({
          id,
          user_id: userId,
          moodle_course_id: moodleCourseId,
          artifact_type: artifactType,
          content_data: contentData,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        .select()
        .single();

      if (!error && data) {
        savedRecord = data;
      } else if (error) {
        // Table might not exist yet or connection issue
        console.warn('Supabase saveLearningArtifact note:', error.message);
      }
    } catch (sbErr) {
      console.warn('Supabase saveLearningArtifact exception:', sbErr);
    }
  }

  // 2. Dual-Write to Firebase Firestore
  try {
    const savedFirebase = await setFirebaseRow('learning_artifacts', id, {
      user_id: userId,
      moodle_course_id: moodleCourseId,
      artifact_type: artifactType,
      content_data: contentData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (!savedRecord && savedFirebase) {
      savedRecord = savedFirebase;
    }
  } catch (firebaseError) {
    console.warn('Firebase saveLearningArtifact warning:', firebaseError);
  }

  return savedRecord || { id, user_id: userId, moodle_course_id: moodleCourseId, artifact_type: artifactType, content_data: contentData };
}

export interface UpdateArtifactParams {
  name?: string;
  orientation?: 'horizontal' | 'vertical';
  contentData?: Record<string, unknown>;
  userId?: number;
  moodleCourseId?: number;
  artifactType?: string;
}

export async function updateLearningArtifact(id: string, params: UpdateArtifactParams) {
  const { name, orientation, contentData } = params;
  let updatedRecord: any = null;

  // 1. Dual-write to Firebase Firestore
  try {
    const existing = await getFirebaseRow('learning_artifacts', id);
    let existingContent: Record<string, unknown> = {};
    if (existing && existing.content_data && typeof existing.content_data === 'object') {
      existingContent = { ...(existing.content_data as Record<string, unknown>) };
    }

    if (orientation) {
      existingContent.orientation = orientation;
      if (existingContent.data && typeof existingContent.data === 'object') {
        (existingContent.data as Record<string, unknown>).orientation = orientation;
      }
    }
    if (name) {
      existingContent.name = name;
    }
    if (contentData && typeof contentData === 'object') {
      existingContent = { ...existingContent, ...contentData };
    }

    const savedFirebase = await setFirebaseRow(
      'learning_artifacts',
      id,
      {
        content_data: existingContent,
        updated_at: new Date().toISOString(),
      },
      ['content_data', 'updated_at']
    );
    if (savedFirebase) {
      updatedRecord = savedFirebase;
    }
  } catch (firebaseError) {
    console.warn('Firebase updateLearningArtifact warning:', firebaseError);
  }

  // 2. Dual-write to Supabase
  const supabase = getSupabaseAdmin();
  if (supabase) {
    try {
      const { data: existingSb } = await supabase
        .from('learning_artifacts')
        .select('content_data')
        .eq('id', id)
        .maybeSingle();

      let sbContent: Record<string, unknown> = (existingSb?.content_data as Record<string, unknown>) || {};
      if (orientation) {
        sbContent = {
          ...sbContent,
          orientation,
          data: sbContent.data && typeof sbContent.data === 'object'
            ? { ...(sbContent.data as Record<string, unknown>), orientation }
            : sbContent.data,
        };
      }
      if (name) {
        sbContent = { ...sbContent, name };
      }
      if (contentData && typeof contentData === 'object') {
        sbContent = { ...sbContent, ...contentData };
      }

      const { data, error } = await supabase
        .from('learning_artifacts')
        .update({
          content_data: sbContent,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .maybeSingle();

      if (!error && data) {
        updatedRecord = updatedRecord || data;
      } else if (!existingSb && params.moodleCourseId) {
        const { data: upsertData, error: upsertErr } = await supabase
          .from('learning_artifacts')
          .upsert({
            id,
            user_id: params.userId || 4,
            moodle_course_id: params.moodleCourseId,
            artifact_type: params.artifactType || 'mindmap',
            content_data: sbContent,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' })
          .select()
          .maybeSingle();

        if (!upsertErr && upsertData) {
          updatedRecord = updatedRecord || upsertData;
        }
      }
    } catch (sbErr) {
      console.warn('Supabase updateLearningArtifact note:', sbErr);
    }
  }

  return updatedRecord || { id, orientation, name };
}

export async function deleteLearningArtifact(params: { id?: string; attemptId?: number; userId?: number; artifactType?: string }) {
  const { id, attemptId, userId, artifactType } = params;
  let deletedCount = 0;

  // 1. Delete from Supabase
  const supabase = getSupabaseAdmin();
  if (supabase) {
    try {
      if (id) {
        let query = supabase.from('learning_artifacts').delete().eq('id', id);
        if (userId) query = query.eq('user_id', userId);
        if (artifactType) query = query.eq('artifact_type', artifactType);
        const { error } = await query;
        if (!error) deletedCount++;
      } else if (attemptId) {
        // Find matching artifact by attemptId in JSONB
        let query = supabase.from('learning_artifacts').delete().contains('content_data', { attemptId });
        if (userId) query = query.eq('user_id', userId);
        const { error } = await query;
        if (!error) deletedCount++;
      }
    } catch (sbErr) {
      console.warn('Supabase deleteLearningArtifact note:', sbErr);
    }
  }

  // 2. Delete from Firebase
  try {
    if (id) {
      const deleted = await deleteFirebaseRow('learning_artifacts', id);
      if (deleted) deletedCount++;
    } else if (attemptId) {
      // Find rows in Firestore and delete
      const rows = await getFirebaseRows('learning_artifacts', {
        user_id: userId,
        artifact_type: artifactType || 'quiz_analysis',
      });
      if (rows && rows.length > 0) {
        for (const row of rows) {
          const c = row.content_data as any;
          if (c && Number(c.attemptId) === Number(attemptId)) {
            await deleteFirebaseRow('learning_artifacts', row.id);
            deletedCount++;
          }
        }
      }
    }
  } catch (firebaseError) {
    console.warn('Firebase deleteLearningArtifact note:', firebaseError);
  }

  return deletedCount > 0;
}

export async function getLearningArtifacts(params: {
  userId?: number;
  moodleCourseId?: number;
  artifactType?: string;
  limit?: number;
}) {
  const { userId, moodleCourseId, artifactType, limit = 10 } = params;

  // 1. Primary: Firebase Firestore (learning_artifacts collection)
  try {
    const rows = await getFirebaseRows('learning_artifacts', {
      user_id: userId,
      moodle_course_id: moodleCourseId,
      artifact_type: artifactType,
    }, limit);
    if (rows && rows.length > 0) return rows;
  } catch (firebaseError) {
    console.warn('Firebase getLearningArtifacts warning:', firebaseError);
  }

  // 2. Secondary: Supabase (if table exists)
  const supabase = getSupabaseAdmin();
  if (supabase) {
    try {
      let query = supabase.from('learning_artifacts').select('*');
      if (userId) query = query.eq('user_id', userId);
      if (moodleCourseId) query = query.eq('moodle_course_id', moodleCourseId);
      if (artifactType) query = query.eq('artifact_type', artifactType);

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && data && data.length > 0) {
        return data;
      }
    } catch {
      // Table may not exist in Supabase
    }
  }

  return [];
}

export async function getLatestQuizAnalysis(params: {
  userId?: number;
  moodleCourseId?: number;
}): Promise<QuizAnalysisData | null> {
  const artifacts = await getLearningArtifacts({
    userId: params.userId,
    moodleCourseId: params.moodleCourseId,
    artifactType: 'quiz_analysis',
    limit: 1,
  });

  if (artifacts && artifacts.length > 0) {
    const item = artifacts[0];
    const content = (item.content_data || item.contentData) as unknown as QuizAnalysisData;
    if (content) {
      return {
        ...content,
        id: item.id,
      };
    }
  }

  return null;
}

export async function getQuizAnalysisByAttempt(
  attemptId: number,
  moodleCourseId?: number
): Promise<QuizAnalysisData | null> {
  const artifacts = await getLearningArtifacts({
    moodleCourseId,
    artifactType: 'quiz_analysis',
    limit: 50,
  });

  const matched = artifacts.find((item: any) => {
    const c = item.content_data || item.contentData;
    return c && Number(c.attemptId) === Number(attemptId);
  });

  if (matched) {
    const content = (matched.content_data || matched.contentData) as unknown as QuizAnalysisData;
    return {
      ...content,
      id: matched.id,
      cached: true,
    };
  }

  return null;
}

