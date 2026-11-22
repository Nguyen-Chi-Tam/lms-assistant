import { NextResponse } from 'next/server';
import { generateText } from '@/models/registry';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Lightweight JSON-generation endpoint used by the playable minigames'
 * client-side fallback (app/lib/playable-generator.ts → generatePlayableData).
 * Routes through the Cấp 4 "playable" cascade in models/registry.ts:
 * Puter.js (client) → BYOK → OrcaRouter → Gemini Pool → Groq Pool (70B)
 * → OpenRouter (:free) → Pollinations → Aion Labs.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      messages?: Array<{ role: string; content: string }>;
      userId?: number;
    };

    const userPrompt = [...(body.messages || [])]
      .reverse()
      .find((msg) => msg.role === 'user')?.content?.trim();

    if (!userPrompt) {
      return NextResponse.json({ error: 'Missing user message.' }, { status: 400 });
    }

    const result = await generateText(undefined, {
      system:
        'Bạn là chuyên gia thiết kế trò chơi ôn tập. Chỉ trả về duy nhất một JSON object hợp lệ theo đúng schema được yêu cầu, không kèm markdown hay lời giải thích.',
      userPrompt,
      userId: body.userId ? Number(body.userId) : undefined,
      taskCategory: 'playable',
      jsonMode: true,
      maxTokens: 6000,
      signal: request.signal,
    });

    if (!result.text) {
      return NextResponse.json({ error: 'AI không trả về nội dung hợp lệ.' }, { status: 502 });
    }

    return NextResponse.json({ reply: result.text });
  } catch (err) {
    if (request.signal.aborted) throw err;
    console.error('[chat] generation failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Không thể sinh nội dung.' },
      { status: 500 }
    );
  }
}
