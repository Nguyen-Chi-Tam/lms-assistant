import { getFirebaseRows, getFirebaseRow, setFirebaseRow, deleteFirebaseRow } from '@/lib/firebase-admin';

export function getPersonalMaterials(params: {
  userId?: number;
  moodleCourseId?: number;
  limit?: number;
}) {
  return getFirebaseRows('personal_materials', {
    user_id: params.userId,
    moodle_course_id: params.moodleCourseId,
  }, params.limit);
}

/**
 * Parent-Child Retrieval (RAG Cha-Con):
 * Saves the full uncompressed text of a course document chunk/page into Firebase Firestore (`moodle_document_parents`).
 * Offloads heavy text storage from Supabase (500MB free limit) to Firebase (1GB free limit).
 */
export async function saveMoodleDocumentParent(params: {
  moodleCourseId: number;
  moodleFileId: number;
  documentTitle: string;
  pageNumber: number;
  fullText: string;
}): Promise<void> {
  const { moodleCourseId, moodleFileId, documentTitle, pageNumber, fullText } = params;
  if (!fullText || !fullText.trim()) return;

  const docId = `${moodleCourseId}_${moodleFileId}_${pageNumber}`;
  try {
    await setFirebaseRow('moodle_document_parents', docId, {
      moodle_course_id: moodleCourseId,
      moodle_file_id: moodleFileId,
      document_title: documentTitle,
      page_number: pageNumber,
      full_text: fullText.trim(),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[Parent-Child Firestore] Warning saving parent doc ${docId}:`, err);
  }
}

/**
 * Retrieves the full parent text from Firebase Firestore (`moodle_document_parents`) for a specific chunk.
 */
export async function getMoodleDocumentParent(
  moodleCourseId: number,
  moodleFileId: number,
  pageNumber: number
): Promise<string | null> {
  const docId = `${moodleCourseId}_${moodleFileId}_${pageNumber}`;
  try {
    const doc = await getFirebaseRow('moodle_document_parents', docId);
    if (doc && typeof doc.full_text === 'string' && doc.full_text.trim()) {
      return doc.full_text.trim();
    }
  } catch (err) {
    console.warn(`[Parent-Child Firestore] Warning reading parent doc ${docId}:`, err);
  }
  return null;
}

/**
 * Deletes a parent document from Firebase Firestore.
 */
export async function deleteMoodleDocumentParent(
  moodleCourseId: number,
  moodleFileId: number,
  pageNumber: number
): Promise<boolean> {
  const docId = `${moodleCourseId}_${moodleFileId}_${pageNumber}`;
  try {
    return await deleteFirebaseRow('moodle_document_parents', docId);
  } catch {
    return false;
  }
}