import { NextResponse } from 'next/server';
import { currentUserId } from '../../../db/runtime';
import { getDb } from '../../../db';
import { personalMaterials, users } from '../../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { deleteMaterialFile, uploadMaterialFile } from '../../../lib/cloudinary';
import { supabaseAdmin } from '../../../lib/supabase';
import { deleteFirebaseRow, getFirebaseRow, setFirebaseRow } from '@/lib/firebase-admin';
import { getPersonalMaterials } from '@/lib/firebase-data';
import { invalidateCourseCache } from '@/lib/semantic-cache';

const allowedTypes = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const allowedExtensions = new Set(['pdf', 'txt', 'doc', 'docx', 'ppt', 'pptx']);

export async function GET(request: Request) {
  const currentId = await currentUserId();
  const numericUserId = typeof currentId === 'number' ? currentId : parseInt(String(currentId), 10) || 4;

  const id = new URL(request.url).searchParams.get('id');

  try {
    if (id) {
      const data = await getFirebaseRow('personal_materials', id);
      if (data) {
        return NextResponse.json({
          document: {
            id: data.id,
            name: String(data.title || ''),
            contentType: 'application/pdf',
            size: 1024,
            source: 'personal',
            status: 'indexed',
            fileUrl: String(data.storage_url || ''),
            createdAt: Date.now(),
          },
        });
      }
    } else {
      const data = await getPersonalMaterials({ userId: numericUserId });
      if (data) {
        const formatted = data.map((d) => ({
          id: d.id,
          name: d.title,
          contentType: 'application/pdf',
          size: 1024,
          source: 'personal',
          status: 'indexed',
          fileUrl: d.storage_url,
          createdAt: Date.now(),
        }));
        return NextResponse.json({ documents: formatted, storageUsed: formatted.length * 1024, mode: 'live' });
      }
    }
  } catch (firebaseError) {
    console.warn('Firebase GET library warning:', firebaseError);
  }

  // Legacy fallback for local environments without Firebase credentials.
  if (supabaseAdmin) {
    try {
      if (id) {
        const { data, error } = await supabaseAdmin
          .from('personal_materials')
          .select('*')
          .eq('id', id)
          .single();
        if (!error && data) {
          return NextResponse.json({
            document: {
              id: data.id,
              name: data.title,
              contentType: 'application/pdf',
              size: 1024,
              source: 'personal',
              status: 'indexed',
              fileUrl: data.storage_url,
              createdAt: Date.now(),
            },
          });
        }
      } else {
        const { data, error } = await supabaseAdmin
          .from('personal_materials')
          .select('*')
          .eq('user_id', numericUserId)
          .order('id', { ascending: false });

        if (!error && data) {
          const formatted = data.map((d) => ({
            id: d.id,
            name: d.title,
            contentType: 'application/pdf',
            size: 1024,
            source: 'personal',
            status: 'indexed',
            fileUrl: d.storage_url,
            createdAt: Date.now(),
          }));
          return NextResponse.json({
            documents: formatted,
            storageUsed: formatted.length * 1024,
            mode: 'live',
          });
        }
      }
    } catch (sbErr) {
      console.warn('Supabase GET library warning:', sbErr);
    }
  }

  // 2. Try Drizzle
  const db = getDb();
  if (db) {
    try {
      if (id) {
        const docList = await db.select().from(personalMaterials).where(eq(personalMaterials.id, id)).limit(1);
        if (!docList.length) return NextResponse.json({ error: 'Không tìm thấy tài liệu.' }, { status: 404 });
        const doc = docList[0];
        return NextResponse.json({
          document: {
            id: doc.id,
            name: doc.title,
            contentType: 'application/pdf',
            size: 1024,
            source: 'personal',
            status: 'indexed',
            fileUrl: doc.storageUrl,
            createdAt: Date.now(),
          },
        });
      }

      const docs = await db.select().from(personalMaterials).where(eq(personalMaterials.userId, numericUserId));
      const formatted = docs.map((d) => ({
        id: d.id,
        name: d.title,
        contentType: 'application/pdf',
        size: 1024,
        source: 'personal',
        status: 'indexed',
        fileUrl: d.storageUrl,
        createdAt: Date.now(),
      }));

      return NextResponse.json({
        documents: formatted,
        storageUsed: formatted.length * 1024,
        mode: 'live',
      });
    } catch (dbErr) {
      console.warn('Drizzle GET library warning:', dbErr);
    }
  }

  return NextResponse.json({ documents: [], storageUsed: 0, mode: 'preview' });
}

export async function POST(request: Request) {
  const currentId = await currentUserId();
  const numericUserId = typeof currentId === 'number' ? currentId : parseInt(String(currentId), 10) || 4;

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Thiếu tài liệu.' }, { status: 400 });
  if (file.size > 50 * 1024 * 1024) return NextResponse.json({ error: 'Tài liệu vượt quá 50 MB.' }, { status: 413 });
  
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!allowedTypes.has(file.type) && !allowedExtensions.has(extension)) {
    return NextResponse.json({ error: 'Định dạng chưa được hỗ trợ.' }, { status: 415 });
  }

  let fileUrl = '';
  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const uploadRes = await uploadMaterialFile(buffer, file.name, {
      folder: `materials/${numericUserId}`,
      contentType: file.type,
    });
    fileUrl = uploadRes.secure_url;
  } catch (e) {
    console.warn('Upload warning:', e);
    fileUrl = `https://local.storage/materials/${encodeURIComponent(file.name)}`;
  }

  try {
    const id = crypto.randomUUID();
    const data = await setFirebaseRow('personal_materials', id, {
      user_id: numericUserId,
      moodle_course_id: 1,
      title: file.name,
      storage_url: fileUrl,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (data) {
      invalidateCourseCache(1).catch(() => {});
      return NextResponse.json({ id: data.id, name: String(data.title || ''), contentType: file.type, size: file.size, source: 'personal', status: 'indexed', createdAt: Date.now(), fileUrl }, { status: 201 });
    }
  } catch (firebaseError) {
    console.warn('Firebase POST library warning:', firebaseError);
  }

  // Legacy fallback for local environments without Firebase credentials.
  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('users').upsert(
        { moodle_user_id: numericUserId, role: numericUserId === 2 ? 'teacher' : 'student', name: numericUserId === 2 ? 'Admin User' : 'Sinh viên' },
        { onConflict: 'moodle_user_id', ignoreDuplicates: true }
      );

      const { data, error } = await supabaseAdmin
        .from('personal_materials')
        .insert({
          user_id: numericUserId,
          moodle_course_id: 1,
          title: file.name,
          storage_url: fileUrl,
        })
        .select()
        .single();

      if (!error && data) {
        return NextResponse.json(
          {
            id: data.id,
            name: data.title,
            contentType: file.type,
            size: file.size,
            source: 'personal',
            status: 'indexed',
            createdAt: Date.now(),
            fileUrl,
          },
          { status: 201 }
        );
      }
    } catch (sbErr) {
      console.warn('Supabase POST library warning:', sbErr);
    }
  }

  // 2. Try Drizzle
  const db = getDb();
  if (db) {
    try {
      const existingUser = await db.select().from(users).where(eq(users.moodleUserId, numericUserId)).limit(1);
      if (existingUser.length === 0) {
        await db.insert(users).values({
          moodleUserId: numericUserId,
          role: 'student',
          name: 'Sinh viên',
        });
      }

      const [newDoc] = await db
        .insert(personalMaterials)
        .values({
          userId: numericUserId,
          moodleCourseId: 1,
          title: file.name,
          storageUrl: fileUrl,
        })
        .returning();

      return NextResponse.json(
        {
          id: newDoc.id,
          name: newDoc.title,
          contentType: file.type,
          size: file.size,
          source: 'personal',
          status: 'indexed',
          createdAt: Date.now(),
          fileUrl,
        },
        { status: 201 }
      );
    } catch (dbErr) {
      console.warn('Drizzle POST library warning:', dbErr);
    }
  }

  return NextResponse.json(
    {
      id: crypto.randomUUID(),
      name: file.name,
      contentType: file.type,
      size: file.size,
      source: 'personal',
      status: 'indexed',
      createdAt: Date.now(),
      fileUrl,
      mode: 'preview',
    },
    { status: 201 }
  );
}

export async function DELETE(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get('id');
  const userId = Number(searchParams.get('userId')) || 0;
  if (!id) return NextResponse.json({ error: 'Thiếu mã tài liệu.' }, { status: 400 });

  let storageUrl = '';
  try {
    const material = await getFirebaseRow('personal_materials', id);
    if (material && (!userId || Number(material.user_id) === userId)) {
      storageUrl = String(material.storage_url || '');
      await deleteFirebaseRow('personal_materials', id);
      if (storageUrl) {
        try {
          await deleteMaterialFile(storageUrl);
        } catch (storageError) {
          console.warn('Material storage deletion warning:', storageError);
        }
      }
      invalidateCourseCache(1).catch(() => {});
      return NextResponse.json({ success: true });
    }
  } catch (firebaseError) {
    console.warn('Firebase DELETE library warning:', firebaseError);
  }

  if (supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin
        .from('personal_materials')
        .select('storage_url')
        .eq('id', id)
        .maybeSingle();
      storageUrl = data?.storage_url || '';
      const { error } = await supabaseAdmin.from('personal_materials').delete().eq('id', id);
      if (!error) {
        if (storageUrl) await deleteMaterialFile(storageUrl);
        return NextResponse.json({ deleted: true });
      }
    } catch (sbErr) {
      console.warn('Supabase DELETE library warning:', sbErr);
    }
  }

  const db = getDb();
  if (db) {
    try {
      const [material] = await db.select().from(personalMaterials).where(eq(personalMaterials.id, id)).limit(1);
      storageUrl = storageUrl || material?.storageUrl || '';
      await db.delete(personalMaterials).where(eq(personalMaterials.id, id));
      if (storageUrl) await deleteMaterialFile(storageUrl);
      return NextResponse.json({ deleted: true });
    } catch (dbErr) {
      console.warn('Drizzle DELETE library warning:', dbErr);
    }
  }

  return NextResponse.json({ deleted: true, mode: 'preview' });
}

