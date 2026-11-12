export async function parseApiResponse<T>(
  response: Response,
  options: { timeoutMessage?: string } = {}
): Promise<T> {
  const rawText = await response.text();
  const fallbackMessage = options.timeoutMessage ||
    'Máy chủ xử lý quá thời gian cho phép. Hãy thử thu hẹp chủ đề hoặc chọn mức Cơ bản.';

  if (!response.ok) {
    if (response.status === 504 || /FUNCTION_INVOCATION_TIMEOUT|An error occurred/i.test(rawText)) {
      throw new Error(fallbackMessage);
    }

    try {
      const errorBody = JSON.parse(rawText) as { error?: string; message?: string };
      throw new Error(errorBody.error || errorBody.message || `Lỗi máy chủ (${response.status}).`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Lỗi hệ thống (${response.status}).`);
      }
      throw error;
    }
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error('Máy chủ trả về dữ liệu không hợp lệ. Vui lòng thử lại.');
  }
}
