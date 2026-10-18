import { NextResponse } from 'next/server';
import { saveLearningArtifact, getLearningArtifacts, deleteLearningArtifact, updateLearningArtifact } from '@/lib/learning-artifacts';
import { supabaseAdmin } from '@/lib/supabase';
import { getDb } from '@/db';
import { learningArtifacts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userIdStr = searchParams.get('userId');
    const moodleCourseIdStr = searchParams.get('moodleCourseId') || searchParams.get('courseId');
    const artifactType = searchParams.get('artifactType') || undefined;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : 20;

    const userId = userIdStr ? parseInt(userIdStr, 10) : undefined;
    const moodleCourseId = moodleCourseIdStr ? parseInt(moodleCourseIdStr, 10) : undefined;

    const artifacts = await getLearningArtifacts({
      userId,
      moodleCourseId,
      artifactType,
      limit,
    });

    return NextResponse.json({
      success: true,
      artifacts,
      count: artifacts.length,
    });
  } catch (error) {
    console.error('Error fetching learning artifacts:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lấy thành quả học tập.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      userId?: number;
      userName?: string;
      moodleCourseId: number;
      artifactType: 'summary' | 'mindmap' | 'flashcard' | 'quiz_analysis' | string;
      contentData: Record<string, unknown>;
    };

    if (!body.moodleCourseId || !body.artifactType || !body.contentData) {
      return NextResponse.json(
        { error: 'Vui lòng cung cấp đầy đủ courseId, artifactType và contentData.' },
        { status: 400 }
      );
    }

    const userId = Number(body.userId) || 4;

    const saved = await saveLearningArtifact({
      userId,
      userName: body.userName,
      moodleCourseId: Number(body.moodleCourseId),
      artifactType: body.artifactType,
      contentData: body.contentData,
    });

    return NextResponse.json({
      success: true,
      artifact: saved,
    });
  } catch (error) {
    console.error('Error saving learning artifact:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lưu thành quả học tập.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id') || undefined;
    const attemptIdStr = searchParams.get('attemptId');
    const attemptId = attemptIdStr ? Number(attemptIdStr) : undefined;
    const userId = Number(searchParams.get('userId')) || undefined;
    const artifactType = searchParams.get('artifactType') || undefined;

    if (!id && !attemptId) {
      return NextResponse.json({ error: 'Mã thành quả (id) hoặc mã lượt thi (attemptId) là bắt buộc.' }, { status: 400 });
    }

    const success = await deleteLearningArtifact({ id, attemptId, userId, artifactType });
    return NextResponse.json({ success: true, message: 'Đã xóa bản phân tích bài thi.' });
  } catch (error) {
    console.error('Error deleting learning artifact:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi xóa thành quả học tập.' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Mã thành quả (id) là bắt buộc.' }, { status: 400 });
    }

    const body = (await request.json()) as {
      name?: string;
      orientation?: 'horizontal' | 'vertical';
      contentData?: Record<string, unknown>;
    };

    const updated = await updateLearningArtifact(id, body);
    return NextResponse.json({
      success: true,
      artifact: updated,
    });
  } catch (error) {
    console.error('Error updating learning artifact:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi cập nhật học liệu.' },
      { status: 500 }
    );
  }
}

