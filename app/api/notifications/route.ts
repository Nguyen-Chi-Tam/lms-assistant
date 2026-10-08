import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { runtimeEnv } from '@/db/runtime';
import { getSubmittedEventIdsForUser, getMoodlePool } from '@/lib/moodle-db';

export interface NotificationEventResponse {
  id: string;
  userId?: number;
  moodleEventId?: number | null;
  moodleCourseId?: number | null;
  courseName?: string | null;
  eventType: string;
  title: string;
  deliverTime: string;
  timestamp: number;
  name: string;
  sentReminders: number[];
  isSubmitted?: boolean;
  eventDetails?: string | null;
  createdAt?: string;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userIdStr = searchParams.get('userId') || searchParams.get('moodleUserId');

    if (!userIdStr) {
      return NextResponse.json({
        success: true,
        events: [],
        message: 'No userId provided',
      });
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      return NextResponse.json({
        success: true,
        events: [],
        message: 'Invalid userId',
      });
    }

    // 1. Lấy danh sách các môn học mà sinh viên này đang ghi danh
    let enrolledCourseIds: number[] = [];

    // Ưu tiên tra cứu bảng user_courses trên Supabase
    if (supabaseAdmin) {
      try {
        const { data: ucRows, error: ucErr } = await supabaseAdmin
          .from('user_courses')
          .select('moodle_course_id')
          .eq('user_id', userId);
        if (!ucErr && ucRows && ucRows.length > 0) {
          enrolledCourseIds = ucRows.map(r => Number(r.moodle_course_id)).filter(Boolean);
        }
      } catch {
        // fallback
      }
    }

    // Fallback: Nếu user_courses chưa có, gọi trực tiếp Moodle API
    if (enrolledCourseIds.length === 0) {
      const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
      if (MOODLE_URL && MOODLE_TOKEN) {
        try {
          const moodleBase = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
          const enrolParams = new URLSearchParams({
            wstoken: MOODLE_TOKEN,
            wsfunction: 'core_enrol_get_users_courses',
            moodlewsrestformat: 'json',
            userid: String(userId),
          });
          const enrolRes = await fetch(`${moodleBase}?${enrolParams.toString()}`);
          if (enrolRes.ok) {
            const enrolData = await enrolRes.json();
            if (Array.isArray(enrolData)) {
              enrolledCourseIds = enrolData.map((c: { id: number }) => Number(c.id));
            }
          }
        } catch (enrolErr) {
          console.warn('Lỗi lấy môn học từ Moodle API:', enrolErr);
        }
      }
    }

    // 2. Kéo các sự kiện thuộc các môn học của sinh viên từ bảng events
    if (supabaseAdmin) {
      try {
        let query = supabaseAdmin.from('events').select('*');

        if (enrolledCourseIds.length > 0) {
          // Lọc theo các môn học ghi danh (kèm sự kiện chung không gắn course_id nếu có)
          query = query.in('moodle_course_id', enrolledCourseIds);
        }

        const { data, error } = await query.order('deliver_time', { ascending: true });

        if (!error && data) {
          const moodleEventIds = data
            .map(item => Number(item.moodle_event_id))
            .filter(Boolean);
          const submittedEventIds = await getSubmittedEventIdsForUser(userId, moodleEventIds);

          // Thu thập danh sách course ID để lấy tên khóa học
          const courseNameMap = new Map<number, string>();
          const courseIdsToResolve = Array.from(
            new Set(data.map(item => item.moodle_course_id).filter(Boolean).map(Number))
          );

          if (courseIdsToResolve.length > 0) {
            // Cách 1: MySQL trực tiếp mdl_course
            try {
              const pool = getMoodlePool();
              const [rows] = await pool.query(
                `SELECT id, fullname, shortname FROM mdl_course WHERE id IN (?)`,
                [courseIdsToResolve]
              );
              if (Array.isArray(rows)) {
                for (const r of rows as Array<{ id: number | string; fullname?: string; shortname?: string }>) {
                  courseNameMap.set(Number(r.id), r.fullname || r.shortname || '');
                }
              }
            } catch {
              // fallback
            }

            // Cách 2: Moodle API nếu còn thiếu môn
            const missing = courseIdsToResolve.filter(cid => !courseNameMap.has(cid));
            if (missing.length > 0) {
              const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
              if (MOODLE_URL && MOODLE_TOKEN) {
                try {
                  const moodleBase = `${MOODLE_URL.replace(/\/$/, '')}/webservice/rest/server.php`;
                  const enrolParams = new URLSearchParams({
                    wstoken: MOODLE_TOKEN,
                    wsfunction: 'core_enrol_get_users_courses',
                    moodlewsrestformat: 'json',
                    userid: String(userId),
                  });
                  const enrolRes = await fetch(`${moodleBase}?${enrolParams.toString()}`);
                  if (enrolRes.ok) {
                    const enrolData = await enrolRes.json();
                    if (Array.isArray(enrolData)) {
                      for (const c of enrolData) {
                        if (c.id && (c.fullname || c.shortname)) {
                          courseNameMap.set(Number(c.id), c.fullname || c.shortname);
                        }
                      }
                    }
                  }
                } catch {
                  // ignore
                }
              }
            }
          }

          const mapped: NotificationEventResponse[] = data.map(item => {
            const rawDate = item.deliver_time;
            const timestamp = rawDate ? new Date(rawDate).getTime() : Date.now();
            const moodleEvId = item.moodle_event_id ? Number(item.moodle_event_id) : null;
            const cid = item.moodle_course_id ? Number(item.moodle_course_id) : null;
            return {
              id: item.id,
              userId,
              moodleEventId: moodleEvId,
              moodleCourseId: cid,
              courseName: cid ? (courseNameMap.get(cid) || null) : null,
              eventType: item.event_type || 'assign',
              title: item.title,
              deliverTime: item.deliver_time || rawDate,
              timestamp: isNaN(timestamp) ? Date.now() : timestamp,
              name: item.title,
              sentReminders: item.sent_reminders || [],
              isSubmitted: moodleEvId ? submittedEventIds.has(moodleEvId) : false,
              eventDetails: item.event_details || null,
              createdAt: item.created_at,
            };
          });

          return NextResponse.json({
            success: true,
            events: mapped,
          });
        }
      } catch (sbErr) {
        console.warn('Supabase GET events warning:', sbErr);
      }
    }

    return NextResponse.json({
      success: true,
      events: [],
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi lấy danh sách sự kiện.' },
      { status: 500 }
    );
  }
}

interface CreateEventBody {
  userId?: number | string;
  moodleEventId?: number | string | null;
  moodleCourseId?: number | string | null;
  eventType?: string;
  title?: string;
  deliverTime?: string | Date;
  startTime?: string | Date;
  endTime?: string | Date | null;
  eventDetails?: string | null;
  reminders?: number[];
  sentReminders?: number[];
  customReminders?: number[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateEventBody;
    const moodleEventId = body?.moodleEventId ? Number(body.moodleEventId) : null;
    const moodleCourseId = body?.moodleCourseId ? Number(body.moodleCourseId) : null;
    const rawVal = body?.deliverTime ?? body?.endTime ?? body?.startTime;
    let deliverTime = new Date().toISOString();
    if (rawVal instanceof Date) {
      deliverTime = !isNaN(rawVal.getTime()) ? rawVal.toISOString() : deliverTime;
    } else if (typeof rawVal === 'string' && rawVal.trim()) {
      const rawTime = rawVal.trim();
      const parsedDate = new Date(rawTime);
      if (!isNaN(parsedDate.getTime())) {
        if (rawTime.endsWith('Z') || /[+-]\d{2}(:?\d{2})?$/.test(rawTime)) {
          deliverTime = parsedDate.toISOString();
        } else {
          const vnDate = new Date(`${rawTime}+07:00`);
          deliverTime = !isNaN(vnDate.getTime()) ? vnDate.toISOString() : parsedDate.toISOString();
        }
      }
    }
    const eventType = body?.eventType || 'assign';
    const title = body?.title || 'Thông báo mới';
    const eventDetails = body?.eventDetails || null;

    const rawReminders = body?.reminders || body?.sentReminders || body?.customReminders;
    const reminders = Array.isArray(rawReminders) && rawReminders.length > 0
      ? rawReminders.map(Number).filter(n => !isNaN(n)).sort((a, b) => b - a)
      : (eventType === 'manual' ? [60, 0] : [60, 30, 15, 10, 5]);

    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('events')
        .insert({
          moodle_event_id: moodleEventId,
          moodle_course_id: moodleCourseId,
          event_type: eventType,
          title,
          deliver_time: deliverTime,
          sent_reminders: reminders,
          event_details: eventDetails,
        })
        .select()
        .single();

      if (!error && data) {
        return NextResponse.json({ success: true, event: data });
      }
      if (error) {
        throw new Error(error.message);
      }
    }

    return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  } catch (error) {
    console.error('Error creating event:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi tạo sự kiện.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    if (supabaseAdmin) {
      const { error } = await supabaseAdmin.from('events').delete().eq('id', id);
      if (!error) {
        return NextResponse.json({ success: true });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Lỗi xóa sự kiện.' },
      { status: 500 }
    );
  }
}
