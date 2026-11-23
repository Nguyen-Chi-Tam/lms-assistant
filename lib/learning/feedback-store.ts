import fs from 'fs';
import path from 'path';

export interface StudentFeedbackRecord {
  studentId: number;
  studentEmail?: string;
  studentUsername?: string;
  studentName?: string;
  courseId: number | string;
  courseName?: string;
  examName?: string;
  score: number;
  maxScore?: number;
  feedback: string;
  updatedAt: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'student-feedbacks.json');

// Memory store keyed strictly by `${studentId}::${courseId}`
const memoryStore: Record<string, StudentFeedbackRecord> = {};

let fsAvailable: boolean | null = null;

function readDiskStore(): Record<string, StudentFeedbackRecord> {
  if (fsAvailable === false) return { ...memoryStore };
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fsAvailable = true;
    if (fs.existsSync(FILE_PATH)) {
      const raw = fs.readFileSync(FILE_PATH, 'utf-8');
      return { ...memoryStore, ...JSON.parse(raw) };
    }
  } catch {
    fsAvailable = false;
  }
  return { ...memoryStore };
}

function writeDiskStore(data: Record<string, StudentFeedbackRecord>) {
  if (fsAvailable === false) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    fsAvailable = true;
  } catch {
    fsAvailable = false;
  }
}

export function saveStudentFeedback(record: StudentFeedbackRecord) {
  const store = readDiskStore();
  const cId = String(record.courseId);
  const exam = (record.examName || '').toLowerCase().trim();

  // Save by compound key: studentId::courseId and studentId::courseId::examName
  const keys: string[] = [
    `${record.studentId}::${cId}`,
  ];
  if (exam) {
    keys.push(`${record.studentId}::${cId}::${exam}`);
  }
  if (record.studentUsername) {
    keys.push(`${record.studentUsername.toLowerCase()}::${cId}`);
    if (exam) keys.push(`${record.studentUsername.toLowerCase()}::${cId}::${exam}`);
  }
  if (record.studentEmail) {
    keys.push(`${record.studentEmail.toLowerCase()}::${cId}`);
    if (exam) keys.push(`${record.studentEmail.toLowerCase()}::${cId}::${exam}`);
  }

  for (const k of keys) {
    store[k] = record;
    memoryStore[k] = record;
  }

  writeDiskStore(store);
}

export function getStudentFeedback(
  studentIdentifier: number | string,
  courseId?: number | string,
  examName?: string
): StudentFeedbackRecord | null {
  const store = readDiskStore();
  const idStr = String(studentIdentifier).toLowerCase();
  const cId = courseId !== undefined && courseId !== null ? String(courseId) : '';
  const exam = (examName || '').toLowerCase().trim();

  // If no courseId is provided, do NOT match arbitrarily across courses
  if (!cId) {
    return null;
  }

  // 1. Try exact studentId + courseId + examName
  if (exam) {
    const keyWithExam = `${idStr}::${cId}::${exam}`;
    if (store[keyWithExam]) return store[keyWithExam];
  }

  // 2. Try studentId + courseId
  const keyWithCourse = `${idStr}::${cId}`;
  if (store[keyWithCourse]) {
    const record = store[keyWithCourse];
    if (!exam || !record.examName || record.examName.toLowerCase().trim() === exam) {
      return record;
    }
  }

  return null;
}
