import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { adminMessaging } from '@/lib/firebase-admin';
import { getSubmittedUserIdsForEvent, getEnrolledUserIdsFromMoodleDb, closeMoodlePool } from '@/lib/moodle-db';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date();
    // 1. Quét Supabase: Tìm các sự kiện sắp diễn ra trong khoảng 65 phút tới
    const scanWindow = new Date(now.getTime() + 65 * 60000).toISOString();

    if (!supabaseAdmin) {
      return NextResponse.json({ success: false, error: 'Chưa cấu hình Supabase Admin' }, { status: 500 });
    }

    // Tự động dọn dẹp sự kiện đã quá hạn (deliver_time < now)
    try {
      await supabaseAdmin.rpc('delete_expired_events');
    } catch {
      await supabaseAdmin.from('events').delete().lt('deliver_time', now.toISOString());
    }

    const { data: upcomingEvents, error: eventsErr } = await supabaseAdmin
      .from('events')
      .select('*')
      .gt('deliver_time', now.toISOString())
      .lte('deliver_time', scanWindow)
      .order('deliver_time', { ascending: true });

    if (eventsErr || !upcomingEvents || upcomingEvents.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'Không có mốc thông báo nào cần xử lý',
        sent: 0,
        scanned: 0,
      });
    }

    let notificationsSent = 0;
    const details: Array<{
      eventId: string;
      title: string;
      moodleEventId?: number;
      action: 'sent' | 'skipped' | 'pending';
      matchedReminder?: number;
      diffMinutes: number;
      targetUserIds?: number[];
      submittedUserIds?: number[];
      reason: string;
    }> = [];

    for (const ev of upcomingEvents) {
      const deliverTime = new Date(ev.deliver_time);
      const diffMinutes = Math.floor((deliverTime.getTime() - now.getTime()) / 60000);

      // Bỏ qua sự kiện đã quá hạn hơn 5 phút
      if (diffMinutes < -5) continue;

      // Danh sách các mốc hiện có của sự kiện
      const currentReminders = (ev.sent_reminders || []).map(Number).filter((n: number) => !isNaN(n));

      // Kiểm tra các mốc đã đến hạn (diffMinutes <= m)
      const dueMilestones = currentReminders.filter((m: number) => diffMinutes <= m);

      if (dueMilestones.length === 0) {
        details.push({
          eventId: ev.id,
          title: ev.title,
          moodleEventId: ev.moodle_event_id,
          action: 'pending',
          diffMinutes,
          reason: `Chưa đến mốc hẹn tiếp theo (còn ${diffMinutes} phút, các mốc còn lại: [${currentReminders.join(', ')}])`,
        });
        continue;
      }

      // Mốc nhỏ nhất trong các mốc thỏa điều kiện (ví dụ: còn 14 phút -> mốc 15)
      const matchedReminder = Math.min(...dueMilestones);

      // Cập nhật Sổ nhật ký ngay lập tức: loại bỏ mốc này và các mốc lớn hơn khỏi sent_reminders để chống gọi lặp
      const nextReminders = currentReminders.filter((r: number) => r < matchedReminder);
      await supabaseAdmin
        .from('events')
        .update({ sent_reminders: nextReminders })
        .eq('id', ev.id);

      // === THỰC THI 3 BƯỚC LỌC TỐI ƯU TÀI NGUYÊN ===

      // Yêu cầu 1: Lấy danh sách sinh viên CÓ TRONG LỚP (Từ Supabase user_courses hoặc trực tiếp MySQL Moodle)
      let enrolledUserIds: number[] = [];

      try {
        const { data: enrolledStudents } = await supabaseAdmin
          .from('user_courses')
          .select('user_id')
          .eq('moodle_course_id', ev.moodle_course_id);

        if (enrolledStudents && enrolledStudents.length > 0) {
          enrolledUserIds = enrolledStudents.map(s => Number(s.user_id)).filter(Boolean);
        }
      } catch {
        // user_courses chưa có trong schema Supabase
      }

      // Fallback tra cứu trực tiếp MySQL Moodle (mdl_user_enrolments)
      if (enrolledUserIds.length === 0 && ev.moodle_course_id) {
        enrolledUserIds = await getEnrolledUserIdsFromMoodleDb(Number(ev.moodle_course_id));
      }

      // Fallback cuối cùng: danh sách sinh viên trong bảng users (chỉ lấy role = 'student')
      if (enrolledUserIds.length === 0) {
        const { data: allUsers } = await supabaseAdmin.from('users').select('moodle_user_id').eq('role', 'student');
        enrolledUserIds = (allUsers || []).map(u => Number(u.moodle_user_id)).filter(Boolean);
      }

      if (enrolledUserIds.length === 0) {
        details.push({
          eventId: ev.id,
          title: ev.title,
          action: 'skipped',
          diffMinutes,
          matchedReminder,
          reason: `Không tìm thấy sinh viên nào ghi danh trong môn học ID = ${ev.moodle_course_id}.`,
        });
        continue;
      }

      // Yêu cầu 2: Lấy danh sách sinh viên trong lớp CÓ FCM_TOKEN
      const { data: tokensData } = await supabaseAdmin
        .from('fcm_tokens')
        .select('user_id, token')
        .in('user_id', enrolledUserIds);

      if (!tokensData || tokensData.length === 0) {
        details.push({
          eventId: ev.id,
          title: ev.title,
          action: 'skipped',
          diffMinutes,
          matchedReminder,
          reason: `Không có thiết bị (FCM token) nào đăng ký nhận thông báo cho sinh viên trong lớp [${enrolledUserIds.join(', ')}].`,
        });
        continue;
      }

      let targetUserIds = Array.from(new Set(tokensData.map(t => Number(t.user_id))));
      const userTokensMap = new Map<number, string[]>();
      tokensData.forEach(t => {
        const uid = Number(t.user_id);
        if (!userTokensMap.has(uid)) userTokensMap.set(uid, []);
        userTokensMap.get(uid)!.push(t.token);
      });

      let submittedUserIds = new Set<number>();

      // Yêu cầu 3: "LAZY CHECK" MySQL Moodle - Ai ĐÃ NỘP BÀI? (Chỉ áp dụng cho bài tập assign/due, không áp dụng cho Quiz trước giờ mở đề)
      if (ev.event_type === 'assign' || ev.event_type === 'due') {
        submittedUserIds = await getSubmittedUserIdsForEvent(
          ev.moodle_event_id,
          targetUserIds,
          ev.moodle_course_id,
          ev.title
        );

        // LOẠI BỎ những người đã nộp bài khỏi danh sách nhận thông báo
        targetUserIds = targetUserIds.filter(uid => !submittedUserIds.has(uid));

        // Xử lý ghi nhận: Ngay cả khi tất cả sinh viên đã nộp bài, đã xóa mốc khỏi sent_reminders, KHÔNG BẮN FIREBASE!
        if (targetUserIds.length === 0) {
          details.push({
            eventId: ev.id,
            title: ev.title,
            action: 'skipped',
            diffMinutes,
            matchedReminder,
            submittedUserIds: Array.from(submittedUserIds),
            reason: `Mốc ${matchedReminder}m: Tất cả sinh viên có thiết bị [${Array.from(submittedUserIds).join(', ')}] đều ĐÃ NỘP BÀI trên Moodle LMS. Ngừng gửi thông báo!`,
          });
          continue;
        }
      }

      // Gom Token và Bắn Firebase Cloud Messaging cho những người cần nhận
      const tokensToSend: string[] = [];
      targetUserIds.forEach(uid => {
        const userTokens = userTokensMap.get(uid) || [];
        tokensToSend.push(...userTokens);
      });

      if (tokensToSend.length === 0) continue;

      const timeText =
        matchedReminder === 0
          ? 'ngay bây giờ'
          : diffMinutes >= 1440
          ? `${Math.round(diffMinutes / 1440)} ngày`
          : diffMinutes >= 60
          ? `${Math.round(diffMinutes / 60)} giờ`
          : `${diffMinutes > 0 ? diffMinutes : matchedReminder} phút`;

      let notifTitle = ev.title;
      let notifBody = '';

      if (ev.event_type === 'manual') {
        notifTitle = ev.title.includes(':') || ev.title.startsWith('[')
          ? ev.title
          : `Thông báo: ${ev.title}`;
        notifBody = ev.event_details?.trim()
          || (matchedReminder === 0 ? 'Sự kiện đang diễn ra ngay bây giờ!' : `Sự kiện sẽ diễn ra sau ${timeText} nữa!`);
      } else if (ev.event_type === 'quiz') {
        notifTitle = ev.title.includes(':') ? ev.title : `Bài kiểm tra: ${ev.title}`;
        notifBody = `Bài kiểm tra sẽ bắt đầu sau ${timeText} nữa! Hãy chuẩn bị vào làm bài nhé.`;
      } else {
        notifTitle = ev.title.includes(':') ? ev.title : `Nhắc nhở: ${ev.title}`;
        notifBody = (ev.event_type === 'assign' || ev.event_type === 'due')
          ? `Hạn chót sau ${timeText} nữa! Đừng quên nộp bài nhé.`
          : `Sự kiện sẽ diễn ra sau ${timeText} nữa!`;
      }

      const eventTag = `event-${ev.id}`;
      const payload = {
        notification: {
          title: notifTitle,
          body: notifBody,
        },
        data: {
          eventId: String(ev.id),
          moodleEventId: String(ev.moodle_event_id || ''),
          eventType: String(ev.event_type || 'manual'),
          deliverTime: deliverTime.toISOString(),
          diffMinutes: String(diffMinutes),
          moodleCourseId: String(ev.moodle_course_id || ''),
          eventDetails: String(ev.event_details || ''),
          tag: eventTag,
          url: '/home',
        },
        webpush: {
          headers: {
            Urgency: 'high',
            TTL: '86400',
          },
          notification: {
            requireInteraction: true,
            icon: '/lms-assistant-icon.png',
            badge: '/lms-assistant-icon.png',
            tag: eventTag,
          },
          fcmOptions: {
            link: '/home',
          },
        },
        tokens: tokensToSend,
      };

      const response = await adminMessaging.sendEachForMulticast(payload);

      // Tự động dọn dẹp token không hợp lệ nếu có lỗi từ Firebase
      const invalidTokens: string[] = [];
      response.responses?.forEach((resp, idx) => {
        const errCode = (resp.error as { code?: string })?.code;
        if (!resp.success && (errCode === 'messaging/registration-token-not-registered' || errCode === 'messaging/invalid-registration-token')) {
          invalidTokens.push(tokensToSend[idx]);
        }
      });
      if (invalidTokens.length > 0) {
        await supabaseAdmin.from('fcm_tokens').delete().in('token', invalidTokens);
      }

      notificationsSent += response.successCount;
      details.push({
        eventId: ev.id,
        title: ev.title,
        action: 'sent',
        diffMinutes,
        matchedReminder,
        targetUserIds,
        submittedUserIds: Array.from(submittedUserIds),
        reason: `Đã bắn thông báo mốc ${matchedReminder}m tới ${response.successCount} thiết bị của sinh viên chưa nộp bài [${targetUserIds.join(', ')}].`,
      });
    }

    return NextResponse.json({
      success: true,
      sent: notificationsSent,
      scanned: upcomingEvents.length,
      details,
    });
  } catch (error) {
    console.error('Lỗi khi gửi thông báo:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

