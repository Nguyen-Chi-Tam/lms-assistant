import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { personalMaterials, users } from '@/db/schema';
import { eq, and, or, desc } from 'drizzle-orm';
import { uploadMaterialFile, deleteMaterialFile } from '@/lib/cloudinary';
import { supabaseAdmin } from '@/lib/supabase';
import { indexDocuments } from '@/lib/rag';
import { parseDocumentFromUrl, parseDocumentBuffer } from '@/lib/document-parser';
import { getPersonalMaterials } from '@/lib/firebase-data';
import { setFirebaseRow, getFirebaseRow, deleteFirebaseRow } from '@/lib/firebase-admin';
import { invalidateCourseCache } from '@/lib/semantic-cache';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let title = '';
    let content = '';
    let userId: number = 4; // Default demo student ID
    let userName: string = 'Sinh viên';
    let moodleCourseId: number = 1;
    let fileUrl: string | null = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      title = (formData.get('title') as string) || (file ? file.name : 'Untitled Document');
      
      const userIdStr = (formData.get('userId') as string) || (formData.get('moodleUserId') as string);
      if (userIdStr) userId = parseInt(userIdStr, 10) || userId;
      
      const uName = formData.get('userName') as string | null;
      if (uName) userName = uName;

      const moodleCourseIdStr = formData.get('moodleCourseId') as string | null;
      if (moodleCourseIdStr) moodleCourseId = parseInt(moodleCourseIdStr, 10) || moodleCourseId;

      const uploadSource = formData.get('uploadSource') as string | null;
      
      content = (formData.get('content') as string) || '';

      if (file) {
        const arrayBuffer = await file.arrayBuffer();
        try {
          const buffer = Buffer.from(arrayBuffer);
          const uploadResult = await uploadMaterialFile(buffer, file.name, {
            folder: uploadSource === 'student' ? `LMS Assistant/${userId}` : `course-${moodleCourseId}`,
            contentType: file.type,
          });
          fileUrl = uploadResult.secure_url;
        } catch (uploadError) {
          console.warn('Storage upload warning:', uploadError);
        }

        // Extract locally first. This also routes image-only material through
        // multimodal OCR before it is indexed into the transient RAM RAG.
        if (!content) {
          content = await parseDocumentBuffer(arrayBuffer, file.name, file.type);
          if (!content && fileUrl) {
            try {
              content = await parseDocumentFromUrl(fileUrl, file.name);
            } catch {
              content = `[Tài liệu: ${file.name}] (URL: ${fileUrl})`;
            }
          }
          if (!content) {
            content = `[Tài liệu: ${file.name}]`;
          }
        }
      }
    } else {
      const body = (await request.json()) as {
        title?: string;
        content?: string;
        userId?: number | string;
        userName?: string;
        moodleCourseId?: number | string;
        fileUrl?: string;
      };
      title = body.title || 'Untitled Document';
      content = body.content || '';
      if (body.userId) userId = Number(body.userId) || userId;
      if (body.userName) userName = body.userName;
      if (body.moodleCourseId) moodleCourseId = Number(body.moodleCourseId) || moodleCourseId;
      fileUrl = body.fileUrl || null;
    }

    // Auto extract text from web link if content is still empty
    if (!content && fileUrl && fileUrl.startsWith('http')) {
      try {
        const parsed = await parseDocumentFromUrl(fileUrl, title);
        if (parsed && parsed.trim().length > 50) {
          content = parsed.trim();
        }
      } catch (err) {
        console.warn('Auto parse document from URL warning:', err);
      }
    }

    if (!title || (!content && !fileUrl)) {
      return NextResponse.json(
        { error: 'Vui lòng cung cấp tiêu đề và nội dung/tệp tài liệu.' },
        { status: 400 }
      );
    }

    const effectiveStorageUrl = fileUrl || `https://local.storage/materials/${encodeURIComponent(title)}`;
    let insertedMaterial: Record<string, unknown> | null = null;

    try {
      insertedMaterial = await setFirebaseRow('personal_materials', crypto.randomUUID(), {
        user_id: userId,
        moodle_course_id: moodleCourseId,
        title,
        storage_url: effectiveStorageUrl,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (firebaseError) {
      console.warn('Firebase personal_materials insert warning:', firebaseError);
    }

    // Legacy fallback for local environments without Firebase credentials.
    if (!insertedMaterial && supabaseAdmin) {
      try {
        await supabaseAdmin.from('users').upsert(
          {
            moodle_user_id: userId,
            role: userId === 2 ? 'teacher' : 'student',
            name: userName || (userId === 2 ? 'Admin User' : 'Sinh viên'),
          },
          { onConflict: 'moodle_user_id', ignoreDuplicates: true }
        );

        const { data, error: sbError } = await supabaseAdmin
          .from('personal_materials')
          .insert({
            user_id: userId,
            moodle_course_id: moodleCourseId,
            title,
            storage_url: effectiveStorageUrl,
          })
          .select()
          .single();

        if (!sbError && data) {
          insertedMaterial = data;
        }
      } catch (sbErr) {
        console.warn('Supabase personal_materials insert warning:', sbErr);
      }
    }

    // 2. Fallback to Drizzle getDb()
    if (!insertedMaterial) {
      const db = getDb();
      if (db) {
        try {
          const existingUser = await db
            .select()
            .from(users)
            .where(eq(users.moodleUserId, userId))
            .limit(1);

          if (existingUser.length === 0) {
            await db.insert(users).values({
              moodleUserId: userId,
              role: 'student',
              name: userName,
            });
          }

          const [drizzleDoc] = await db
            .insert(personalMaterials)
            .values({
              userId,
              moodleCourseId,
              title,
              storageUrl: effectiveStorageUrl,
            })
            .returning();

          insertedMaterial = drizzleDoc as unknown as Record<string, unknown>;
        } catch (dbErr) {
          console.warn('Drizzle personal_materials insert warning:', dbErr);
        }
      }
    }

    // Background RAG indexing if content extracted
    if (content && content.length > 50) {
      indexDocuments([{ title, text: content }]).catch(err => {
        console.warn('Background RAG indexing warning:', err);
      });
    }

    // Invalidate semantic query cache for this course as materials changed
    invalidateCourseCache(moodleCourseId).catch(err => {
      console.warn('[Semantic Cache] Cache invalidation warning on upload:', err);
    });

    return NextResponse.json({
      success: true,
      material: insertedMaterial || {
        userId,
        moodleCourseId,
        title,
        storageUrl: effectiveStorageUrl,
      },
      fileUrl: effectiveStorageUrl,
      contentPreview: content.slice(0, 300),
    });
  } catch (error) {
    console.error('Error processing document:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi xử lý tài liệu.' },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const moodleCourseId = searchParams.get('moodleCourseId') || searchParams.get('courseId');
    const userId = searchParams.get('userId');

    try {
      const materials = await getPersonalMaterials({
        moodleCourseId: moodleCourseId ? parseInt(moodleCourseId, 10) : undefined,
        userId: userId ? parseInt(userId, 10) : undefined,
      });
      if (materials) return NextResponse.json({ materials, mode: 'live' });
    } catch (firebaseError) {
      console.warn('Firebase GET personal_materials warning:', firebaseError);
    }

    // Legacy fallback for local environments without Firebase credentials.
    if (supabaseAdmin) {
      try {
        let query = supabaseAdmin.from('personal_materials').select('*');
        if (moodleCourseId) query = query.eq('moodle_course_id', parseInt(moodleCourseId, 10));
        if (userId) query = query.eq('user_id', parseInt(userId, 10));

        const { data, error } = await query.order('id', { ascending: false });
        if (!error && data) {
          return NextResponse.json({ materials: data, mode: 'live' });
        }
      } catch (sbErr) {
        console.warn('Supabase GET personal_materials warning:', sbErr);
      }
    }

    // 2. Try Drizzle
    const db = getDb();
    if (db) {
      try {
        const conditions = [];
        if (moodleCourseId) conditions.push(eq(personalMaterials.moodleCourseId, parseInt(moodleCourseId, 10)));
        if (userId) conditions.push(eq(personalMaterials.userId, parseInt(userId, 10)));

        const mats = await db
          .select()
          .from(personalMaterials)
          .where(conditions.length > 0 ? and(...conditions) : undefined);

        return NextResponse.json({ materials: mats, mode: 'live' });
      } catch (dbErr) {
        console.warn('Drizzle GET personal_materials warning:', dbErr);
      }
    }

    return NextResponse.json({
      materials: [],
      mode: 'preview',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lấy danh sách tài liệu.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const userId = Number(searchParams.get('userId')) || 0;

    if (!id) return NextResponse.json({ error: 'Mã tài liệu là bắt buộc.' }, { status: 400 });

    const cleanId = id.replace(/^(mat|upload|url|note)-/, '');
    let storageUrl = '';
    let deleted = false;

    // 1. Try deleting from Firebase Firestore
    try {
      let fbMaterial = await getFirebaseRow('personal_materials', cleanId);
      let targetId = cleanId;
      if (!fbMaterial && id !== cleanId) {
        fbMaterial = await getFirebaseRow('personal_materials', id);
        targetId = id;
      }
      if (fbMaterial && (!userId || Number(fbMaterial.user_id) === userId)) {
        storageUrl = String(fbMaterial.storage_url || '');
        const fbDeleted = await deleteFirebaseRow('personal_materials', targetId);
        if (fbDeleted) deleted = true;
      } else if (!fbMaterial) {
        // Direct attempt in case getFirebaseRow threw or format differed
        const directDelete = await deleteFirebaseRow('personal_materials', cleanId);
        if (directDelete) deleted = true;
      }
    } catch (fbError) {
      console.warn('Firebase personal material deletion warning:', fbError);
      // Fallback direct delete attempt if get threw
      try {
        const directDelete = await deleteFirebaseRow('personal_materials', cleanId);
        if (directDelete) deleted = true;
      } catch {
        // ignore
      }
    }

    // 2. Try deleting from Supabase
    if (!deleted && supabaseAdmin) {
      try {
        const { data, error } = await supabaseAdmin
          .from('personal_materials')
          .select('storage_url, user_id')
          .or(`id.eq.${cleanId},id.eq.${id}`)
          .maybeSingle();
        if (!error && data && (!userId || data.user_id === userId)) {
          storageUrl = storageUrl || data.storage_url || '';
          const deletion = await supabaseAdmin.from('personal_materials').delete().or(`id.eq.${cleanId},id.eq.${id}`);
          if (!deletion.error) deleted = true;
        }
      } catch (supabaseError) {
        console.warn('Supabase personal material deletion warning:', supabaseError);
      }
    }

    // 3. Try deleting from Drizzle DB
    if (!deleted) {
      const db = getDb();
      if (db) {
        try {
          const conditions = [or(eq(personalMaterials.id, cleanId), eq(personalMaterials.id, id))];
          if (userId) conditions.push(eq(personalMaterials.userId, userId));
          const [material] = await db.select().from(personalMaterials).where(and(...conditions)).limit(1);
          if (material) {
            storageUrl = storageUrl || material.storageUrl;
            await db.delete(personalMaterials).where(and(...conditions));
            deleted = true;
          }
        } catch (dbError) {
          console.warn('Database personal material deletion warning:', dbError);
        }
      }
    }

    if (!deleted) return NextResponse.json({ error: 'Không tìm thấy tài liệu.' }, { status: 404 });
    if (storageUrl) {
      try {
        await deleteMaterialFile(storageUrl);
      } catch (storageError) {
        console.warn('Material storage deletion warning:', storageError);
      }
    }

    const courseIdParam = searchParams.get('moodleCourseId') || searchParams.get('courseId');
    if (courseIdParam) {
      invalidateCourseCache(courseIdParam).catch(() => {});
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting personal material:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Không thể xóa tài liệu.' }, { status: 500 });
  }
}

