import { NextResponse } from 'next/server';
import {
  getUserKeySummary,
  saveUserApiKey,
  deleteUserApiKey,
  normalizeProvider,
} from '@/lib/key-manager';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

/**
 * Quick validation test to verify that the provided API key works with its provider.
 */
async function testKeyValidity(provider: string, apiKey: string): Promise<{ valid: boolean; error?: string }> {
  const canonical = normalizeProvider(provider);
  try {
    if (canonical === 'gemini') {
      const client = new GoogleGenAI({ apiKey });
      await client.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        config: { maxOutputTokens: 2 },
      });
      return { valid: true };
    }

    if (canonical === 'groq') {
      const client = new Groq({ apiKey });
      await client.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 2,
      });
      return { valid: true };
    }

    if (canonical === 'openrouter') {
      const client = new OpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
      });
      // Test OpenRouter authentication by listing models or small prompt
      await client.models.list();
      return { valid: true };
    }

    return { valid: false, error: 'Provider không được hỗ trợ.' };
  } catch (err: any) {
    const msg = err?.message || err?.error?.message || String(err);
    if (msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('invalid_api_key') || msg.includes('Unauthorized')) {
      return { valid: false, error: 'API Key không hợp lệ hoặc đã hết hạn.' };
    }
    if (msg.includes('429') || msg.includes('quota') || msg.includes('rate_limit')) {
      // Key is valid, but rate limited or zero credits
      return { valid: true, error: 'Key hợp lệ nhưng tạm thời vượt giới hạn hạn mức (Rate limit/Quota).' };
    }
    // Return error message
    return { valid: false, error: msg };
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userIdStr = searchParams.get('userId') || request.headers.get('x-user-id');

    if (!userIdStr) {
      return NextResponse.json({ error: 'Thiếu thông tin userId.' }, { status: 400 });
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId) || userId <= 0) {
      return NextResponse.json({ error: 'userId không hợp lệ.' }, { status: 400 });
    }

    const summary = await getUserKeySummary(userId);
    return NextResponse.json({ success: true, ...summary });
  } catch (err: any) {
    console.error('[API /user/keys] GET error:', err);
    return NextResponse.json({ error: 'Lỗi tải danh sách API Key.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as any;
    const { userId: bodyUserId, provider, apiKey, keyName, validate = false } = body;
    const userIdStr = bodyUserId || request.headers.get('x-user-id');

    if (!userIdStr) {
      return NextResponse.json({ error: 'Thiếu thông tin userId.' }, { status: 400 });
    }

    const userId = parseInt(String(userIdStr), 10);
    if (isNaN(userId) || userId <= 0) {
      return NextResponse.json({ error: 'userId không hợp lệ.' }, { status: 400 });
    }

    if (!provider || !apiKey) {
      return NextResponse.json({ error: 'Vui lòng cung cấp nhà cung cấp (provider) và API Key.' }, { status: 400 });
    }

    // Optional test validity before saving
    if (validate) {
      const testRes = await testKeyValidity(provider, apiKey);
      if (!testRes.valid) {
        return NextResponse.json(
          { error: testRes.error || 'API Key kiểm tra thất bại, vui lòng kiểm tra lại mã khóa.' },
          { status: 400 }
        );
      }
    }

    const saveRes = await saveUserApiKey({
      userId,
      provider,
      apiKey,
      keyName,
    });

    if (!saveRes.success) {
      return NextResponse.json({ error: saveRes.error || 'Lỗi lưu API Key.' }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Lưu API Key thành công. Hệ thống sẽ ưu tiên sử dụng khóa của bạn.',
      record: saveRes.record,
    });
  } catch (err: any) {
    console.error('[API /user/keys] POST error:', err);
    return NextResponse.json({ error: err?.message || 'Lỗi máy chủ khi lưu API Key.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const keyIdParam = searchParams.get('id') || searchParams.get('keyId');
    const userIdParam = searchParams.get('userId') || request.headers.get('x-user-id');

    let keyId = keyIdParam;
    let userIdStr = userIdParam;

    if (!keyId || !userIdStr) {
      try {
        const body = (await request.json()) as any;
        keyId = keyId || body.id || body.keyId;
        userIdStr = userIdStr || body.userId;
      } catch {
        // no body provided
      }
    }

    if (!keyId || !userIdStr) {
      return NextResponse.json({ error: 'Thiếu thông tin keyId hoặc userId.' }, { status: 400 });
    }

    const userId = parseInt(String(userIdStr), 10);
    if (isNaN(userId) || userId <= 0) {
      return NextResponse.json({ error: 'userId không hợp lệ.' }, { status: 400 });
    }

    const delRes = await deleteUserApiKey(userId, keyId);
    if (!delRes.success) {
      return NextResponse.json({ error: delRes.error || 'Lỗi khi xóa API Key.' }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Đã xóa API Key thành công. Hệ thống sẽ quay về sử dụng Key mặc định.',
    });
  } catch (err: any) {
    console.error('[API /user/keys] DELETE error:', err);
    return NextResponse.json({ error: 'Lỗi máy chủ khi xóa API Key.' }, { status: 500 });
  }
}
