import { supabaseAdmin } from '@/lib/supabase';

/**
 * Xóa sớm một sự kiện đã hoàn thành (cả lớp đã nộp bài / đã điểm danh).
 *
 * The database trigger protects future Moodle events from direct deletion.
 * Move the event just into the past, then let the database cleanup function
 * perform the deletion.
 */
export async function deleteCompletedEvent(eventId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;

  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const { error: markError } = await supabaseAdmin
    .from('events')
    .update({
      deliver_time: expiredAt,
      sent_reminders: [],
    })
    .eq('id', eventId)
    .select('id')
    .maybeSingle();

  if (markError) {
    console.warn(`[event-completion] Không đánh dấu quá hạn sự kiện ${eventId}:`, markError.message);
    return false;
  }

  const { error: cleanupError } = await supabaseAdmin.rpc('delete_expired_events');
  if (cleanupError) {
    console.warn(`[event-completion] Không chạy được dọn dẹp sự kiện ${eventId}:`, cleanupError.message);
    return false;
  }

  const { data: remainingEvent, error: checkError } = await supabaseAdmin
    .from('events')
    .select('id')
    .eq('id', eventId)
    .maybeSingle();

  if (checkError) {
    console.warn(`[event-completion] Không xác minh được sự kiện ${eventId}:`, checkError.message);
    return false;
  }

  return !remainingEvent;
}
