/**
 * LMS Assistant — Automation Cron Runner
 * Chạy đồng bộ cả 2 tác vụ định kỳ tự động:
 *   1. [SYNC-MOODLE]: Kéo bài tập & bài kiểm tra từ Moodle (Laragon) vào bảng `events`
 *   2. [NOTIFY]: Quét mốc thời gian, bắn Web Push qua FCM và tự động xóa sự kiện khi đến hạn
 *
 * Cách chạy:
 *   node scripts/cron-worker.mjs
 *   hoặc: npm run cron
 */

import fs from 'node:fs';
import path from 'node:path';

// Nạp biến môi trường từ .dev.vars, .env.local, .env
function loadEnvFiles() {
  const files = ['.dev.vars', '.env.local', '.env'];
  for (const file of files) {
    try {
      const fullPath = path.resolve(process.cwd(), file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (key && !process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      }
    } catch {}
  }
}
loadEnvFiles();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const NOTIFY_INTERVAL_MS = parseInt(process.env.NOTIFY_INTERVAL_MS || '60000', 10); // Mặc định 60 giây
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || '60000', 10);     // Mặc định 60 giây

// ANSI colors for clean terminal visualization
const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function timestamp() {
  return `${colors.gray}[${new Date().toLocaleTimeString('vi-VN')}]${colors.reset}`;
}

async function runMoodleSync() {
  const label = `${colors.magenta}${colors.bold}[SYNC-MOODLE]${colors.reset}`;
  try {
    const headers = {
      Accept: 'application/json',
      ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
    };

    const res = await fetch(`${BASE_URL}/api/cron/sync-moodle`, { headers });

    if (!res.ok) {
      let errDetail = '';
      try {
        const errJson = await res.json();
        errDetail = errJson.error ? ` — ${errJson.error}` : '';
      } catch {}
      console.log(`${timestamp()} ${label} ${colors.red}HTTP ${res.status}${errDetail}${colors.reset}`);
      return;
    }

    const data = await res.json();
    if (data.success) {
      const inserted = data.insertedCount || 0;
      const updated = data.updatedCount || 0;
      const deleted = data.deletedCount || 0;
      const expired = data.expiredDeletedCount || 0;
      const submitted = data.submittedCount || 0;
      const total = data.eligibleEvents ?? data.futureEvents ?? 0;
      let logMsg = `Đồng bộ: ${colors.green}${total} sự kiện lớp tham gia${colors.reset} (+${inserted} mới, ~${updated} cập nhật`;
      if (expired > 0) logMsg += `, ${colors.yellow}🗑️ [delete_expired_events] -${expired} quá hạn${colors.reset}`;
      if (deleted > 0) logMsg += `, ${colors.yellow}-${deleted} đã dọn dẹp${colors.reset}`;
      if (submitted > 0) logMsg += `, ${colors.cyan}${submitted} đã nộp bài${colors.reset}`;
      logMsg += ')';
      console.log(`${timestamp()} ${label} ${logMsg}`);
    } else {
      console.log(`${timestamp()} ${label} ${colors.red}Lỗi: ${data.error || 'Thất bại'}${colors.reset}`);
    }
  } catch (err) {
    console.log(`${timestamp()} ${label} ${colors.yellow}Mất kết nối tới server (${err.message})${colors.reset}`);
  }
}

async function runNotificationCheck() {
  const label = `${colors.cyan}${colors.bold}[NOTIFY]${colors.reset}`;
  try {
    const headers = {
      Accept: 'application/json',
      ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
    };

    let res = await fetch(`${BASE_URL}/api/cron/notify`, { headers });
    // If cron/notify returns 401 due to unset secret, fallback to test-notify
    if (res.status === 401) {
      res = await fetch(`${BASE_URL}/api/test-notify`, { headers: { Accept: 'application/json' } });
    }

    if (!res.ok) {
      let errDetail = '';
      try {
        const errJson = await res.json();
        errDetail = errJson.error ? ` — ${errJson.error}` : '';
      } catch {}
      console.log(`${timestamp()} ${label} ${colors.red}HTTP ${res.status}${errDetail}${colors.reset}`);
      return;
    }

    const data = await res.json();
    if (data.success) {
      const scanned = data.totalEventsScanned ?? 0;
      const sent = data.notificationsSent ?? 0;
      const deleted = data.eventsDeleted ?? 0;

      let msg = `Quét ${colors.bold}${scanned}${colors.reset} sự kiện`;
      if (sent > 0) {
        msg += ` | ${colors.green}${colors.bold}🔔 Đã bắn ${sent} thông báo FCM!${colors.reset}`;
      }
      if (deleted > 0) {
        msg += ` | ${colors.yellow}${colors.bold}🗑️ [delete_expired_events] Đã xóa ${deleted} sự kiện quá hạn!${colors.reset}`;
      }
      if (sent === 0 && deleted === 0) {
        msg += ` ${colors.gray}(đang đếm lùi, chưa đến mốc)${colors.reset}`;
      }

      console.log(`${timestamp()} ${label} ${msg}`);

      // Call out chi tiết các sự kiện quá hạn đã xóa hoặc thông báo FCM đã gửi
      if (Array.isArray(data.details)) {
        for (const item of data.details) {
          const remLabel = item.matchedReminder < 0
            ? `${item.matchedReminder}m (3 phút trước khi đóng)`
            : `${item.matchedReminder}m`;
          if (item.action === 'deleted') {
            console.log(`${timestamp()} ${label}   ${colors.yellow}↳ 🗑️ [delete_expired_events] Đã xóa: "${item.title}" (${item.reason})${colors.reset}`);
          } else if (item.action === 'sent') {
            console.log(`${timestamp()} ${label}   ${colors.green}↳ 🔔 Đã bắn thông báo mốc ${remLabel} (${item.sentCount} thiết bị): "${item.title}"${colors.reset}`);
          } else if (item.action === 'skipped') {
            const isAssignment = item.eventType === 'assign' || item.eventType === 'due';
            const isAttendance = item.eventType === 'attendance';
            const isAllSubmitted = isAssignment && item.reason && item.reason.includes('đều đã nộp bài');
            const isAllAttended = isAttendance && item.reason && item.reason.includes('đều đã điểm danh');
            if (isAllSubmitted) {
              console.log(`${timestamp()} ${label}   ${colors.cyan}↳ ✅ [BÀI TẬP ĐÃ NỘP HẾT] Mốc ${remLabel}: "${item.title}" — ${item.reason}${colors.reset}`);
            } else if (isAllAttended) {
              console.log(`${timestamp()} ${label}   ${colors.cyan}↳ ✅ [ĐÃ ĐIỂM DANH HẾT] Mốc ${remLabel}: "${item.title}" — ${item.reason}${colors.reset}`);
            } else {
              console.log(`${timestamp()} ${label}   ${colors.yellow}↳ ⏩ Bỏ qua mốc ${remLabel}: "${item.title}" — ${item.reason}${colors.reset}`);
            }
          } else if (item.action === 'failed') {
            console.log(`${timestamp()} ${label}   ${colors.red}↳ ⚠️ Đã xóa mốc ${remLabel} (gửi thất bại): "${item.title}" — ${item.reason}${colors.reset}`);
          }
        }
      }
    } else {
      console.log(`${timestamp()} ${label} ${colors.red}Lỗi: ${data.error || 'Thất bại'}${colors.reset}`);
    }
  } catch (err) {
    console.log(`${timestamp()} ${label} ${colors.yellow}Mất kết nối tới server (${err.message})${colors.reset}`);
  }
}

async function main() {
  console.log('\n======================================================');
  console.log(` ${colors.green}${colors.bold}🚀 LMS Assistant — Background Automation Service${colors.reset}`);
  console.log('======================================================');
  console.log(` • Server Target : ${colors.cyan}${BASE_URL}${colors.reset}`);
  console.log(` • Tác vụ 1      : ${colors.magenta}[SYNC-MOODLE]${colors.reset} đồng bộ sự kiện mỗi ${SYNC_INTERVAL_MS / 1000}s`);
  console.log(` • Tác vụ 2      : ${colors.cyan}[NOTIFY]${colors.reset} quét mốc & gửi thông báo mỗi ${NOTIFY_INTERVAL_MS / 1000}s`);
  console.log(` • Trạng thái    : ${colors.green}Đang chạy... (Nhấn Ctrl+C để dừng)${colors.reset}\n`);

  const notifyOnly = process.argv.includes('--notify-only');
  const syncOnly = process.argv.includes('--sync-only');

  // Chạy ngay lần đầu tiên lúc khởi động
  if (!notifyOnly) await runMoodleSync();
  if (!syncOnly) await runNotificationCheck();

  if (process.argv.includes('--once')) {
    console.log(`\n${timestamp()} ${colors.green}Chạy một lần (--once) hoàn tất.${colors.reset}`);
    return;
  }

  // Đặt nhịp định kỳ
  if (!notifyOnly) setInterval(runMoodleSync, SYNC_INTERVAL_MS);
  if (!syncOnly) setInterval(runNotificationCheck, NOTIFY_INTERVAL_MS);
}

// Xử lý ngắt tiến trình sạch sẽ
process.on('SIGINT', () => {
  console.log(`\n${timestamp()} ${colors.yellow}Đang dừng dịch vụ automation. Hẹn gặp lại!${colors.reset}`);
  process.exit(0);
});

void main();

