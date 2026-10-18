import { NextResponse } from 'next/server';
import { clearRagCache } from '@/lib/rag';
import { clearDocumentCache } from '@/lib/document-parser';

export async function POST(request: Request) {
  try {
    let docPattern: string | undefined;
    try {
      const body = (await request.json()) as { courseId?: string; courseCode?: string; pattern?: string };
      docPattern = body.pattern || body.courseCode || undefined;
    } catch {
      // Body may be empty on beacon cleanup
    }

    const ragCleared = clearRagCache(docPattern);
    const docCleared = clearDocumentCache(docPattern);

    return NextResponse.json({
      success: true,
      message: 'RAM Vector RAG & Document cache cleared successfully.',
      details: {
        ragDocumentsCleared: ragCleared,
        parsedDocumentsCleared: docCleared,
      },
    });
  } catch (error) {
    console.error('Error clearing RAM cache:', error);
    return NextResponse.json({ success: false, error: 'Failed to clear RAM cache.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  return POST(request);
}

