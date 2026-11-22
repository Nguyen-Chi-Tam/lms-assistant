/**
 * Danh sách tài khoản KHÔNG được phép đăng nhập / khôi phục phiên trong LMS Assistant.
 * Tài khoản này được dùng để lưu token trong LMS giả, KHÔNG phải là tài khoản học viên
 * hợp lệ và không được tự động đăng nhập lại sau khi đăng xuất (nguy cơ bảo mật).
 * So sánh theo username (không phân biệt hoa thường, bỏ khoảng trắng).
 */
export const BLOCKED_USERNAMES = new Set<string>(['admin', 'admin@example.com']);

export function isBlockedAccount(username: string | undefined | null): boolean {
  if (!username) return false;
  return BLOCKED_USERNAMES.has(username.trim().toLowerCase());
}
