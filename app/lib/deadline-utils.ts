export type DeadlineItem = {
  id: number | string;
  name: string;
  courseName: string;
  courseId?: number | string;
  timestamp: number;
  openTimestamp?: number;
  closeTimestamp?: number;
  url?: string;
  type?: 'homework' | 'exam' | 'quiz' | 'task' | 'manual' | 'attendance';
  modulename?: string;
  eventtype?: string;
  description?: string;
};

/**
 * Merge Moodle calendar events that describe the same activity.
 *
 * Moodle often returns an "opens" event and a "closes" event as two separate
 * calendar entries. Grouping them lets the UI show a single deadline with its
 * full open → close window instead of duplicated rows.
 */
export function mergeMoodleDeadlines(
  rawDeadlines: Array<{
    id: number;
    name: string;
    courseName: string;
    timestamp: number;
    url?: string;
    description?: string;
    modulename?: string;
    eventtype?: string;
    type?: string;
  }>
): DeadlineItem[] {
  const groupedMap = new Map<string, DeadlineItem>();

  for (const d of rawDeadlines) {
    const rawName = (d.name || '').trim();
    let baseName = rawName;
    let eventKind: 'open' | 'close' | 'general' = 'general';

    // Detect "opens" or "mở" / "bắt đầu"
    const opensMatch = /(?:\s+opens|\s+mở|\s+bắt đầu)$/i.exec(rawName);
    if (opensMatch) {
      baseName = rawName.slice(0, opensMatch.index).trim();
      eventKind = 'open';
    } else {
      // Detect "closes", "is due", "due", "đóng", "hết hạn", "kết thúc", "hạn chót"
      const closesMatch = /(?:\s+closes|\s+is due|\s+due|\s+đóng|\s+hết hạn|\s+kết thúc|\s+hạn chót)$/i.exec(rawName);
      if (closesMatch) {
        baseName = rawName.slice(0, closesMatch.index).trim();
        eventKind = 'close';
      }
    }

    const lowerBase = baseName.toLowerCase();
    const urlStr = (d.url || '').toLowerCase();
    const modulename = ((d.modulename || '') as string).toLowerCase();

    let type: 'homework' | 'exam' | 'quiz' | 'task' | 'manual' | 'attendance' = 'homework';

    if (d.type === 'manual' || d.eventtype === 'manual') {
      type = 'manual';
    } else if (
      modulename === 'attendance' ||
      urlStr.includes('/mod/attendance/') ||
      lowerBase.includes('attendance') ||
      lowerBase.includes('điểm danh')
    ) {
      type = 'attendance';
    } else if (
      modulename === 'quiz' ||
      urlStr.includes('/mod/quiz/') ||
      lowerBase.includes('quiz') ||
      lowerBase.includes('trắc nghiệm') ||
      lowerBase.includes('kiểm tra') ||
      lowerBase.includes('thi') ||
      lowerBase.includes('exam')
    ) {
      type = lowerBase.includes('trắc nghiệm') || lowerBase.includes('quiz') || modulename === 'quiz' ? 'quiz' : 'exam';
    } else if (
      modulename === 'assign' ||
      urlStr.includes('/mod/assign/') ||
      lowerBase.includes('bài tập') ||
      lowerBase.includes('assignment') ||
      lowerBase.includes('homework') ||
      lowerBase.includes('tiểu luận') ||
      lowerBase.includes('project') ||
      lowerBase.includes('đồ án') ||
      lowerBase.includes('lab')
    ) {
      type = 'homework';
    }

    const key = `${(d.courseName || '').toLowerCase()}::${lowerBase}`;
    const existing = groupedMap.get(key);

    if (existing) {
      if (eventKind === 'open') {
        existing.openTimestamp = d.timestamp;
      } else if (eventKind === 'close') {
        existing.closeTimestamp = d.timestamp;
      }
      if (d.url && !existing.url) {
        existing.url = d.url;
      }
      if (d.description && !existing.description) {
        existing.description = d.description;
      }
      if (type !== 'homework') {
        existing.type = type;
      }
      existing.timestamp = existing.closeTimestamp || existing.openTimestamp || d.timestamp;
    } else {
      groupedMap.set(key, {
        id: d.id,
        name: baseName,
        courseName: d.courseName,
        openTimestamp: eventKind === 'open' ? d.timestamp : undefined,
        closeTimestamp: eventKind === 'close' ? d.timestamp : undefined,
        timestamp: d.timestamp,
        url: d.url,
        type,
        modulename: d.modulename,
        eventtype: d.eventtype,
        description: d.description,
      });
    }
  }

  const list = Array.from(groupedMap.values());
  list.forEach(item => {
    if (item.closeTimestamp && item.openTimestamp) {
      item.timestamp = item.closeTimestamp;
    }
  });

  return list;
}
