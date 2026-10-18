import mysql from 'mysql2/promise';

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env.local');
  }
} catch {}

const host = process.env.MOODLE_DB_HOST || '127.0.0.1';
const user = process.env.MOODLE_DB_USER || 'root';
const password = process.env.MOODLE_DB_PASSWORD || '';
const database = process.env.MOODLE_DB_NAME || 'moodle';
const port = Number(process.env.MOODLE_DB_PORT || 3306);

async function main() {
  const conn = await mysql.createConnection({ host, user, password, database, port });
  const nowTimestamp = 1789800000;
  const maxFutureTimestamp = 1799999999;
  const queryStr = `
    SELECT 
      COALESCE(e.id, sess.id + 100000) AS id,
      a.name AS attendance_name,
      sess.description AS session_desc,
      sess.sessdate AS timestart,
      sess.duration AS timeduration,
      sess.attendanceid AS instance,
      a.course AS courseid,
      c.fullname AS course_fullname,
      c.shortname AS course_shortname
    FROM mdl_attendance_sessions sess
    JOIN mdl_attendance a ON a.id = sess.attendanceid
    JOIN mdl_course c ON c.id = a.course
    LEFT JOIN mdl_event e ON (e.id = sess.caleventid OR (e.instance = a.id AND e.modulename = 'attendance' AND e.timestart = sess.sessdate))
    WHERE (sess.sessdate + sess.duration) >= ? AND sess.sessdate <= ?
  `;
  const [rows] = await conn.query(queryStr, [nowTimestamp, maxFutureTimestamp]);
  console.log('Attendance sessions found:', rows);
  await conn.end();
}

main().catch(console.error);

