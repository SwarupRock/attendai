/**
 * check_attendance — percentage + records for one student.
 *
 * Access rule (server-side, not prompt-side): a student session may only ever
 * see its own USN. If a student session passes a different USN, it is denied
 * here regardless of what the model was asked. Teachers and the read-only
 * guest session may query any USN.
 */
import { db } from '../db.js';
import { getSession } from '../identity.js';
import { findClass, allClassNames } from './listStudents.js';

export function checkAttendance({ student_usn, class_name }) {
  const session = getSession();
  const usn = String(student_usn).trim().toUpperCase();

  if (session.role === 'student' && session.usn !== usn) {
    return {
      error: 'Access denied: students can only query their own attendance.',
      your_usn: session.usn,
      requested_usn: usn,
    };
  }

  const student = db.prepare('SELECT id, name, usn FROM students WHERE usn = ?').get(usn);
  if (!student) {
    return { error: `No student with USN "${usn}"` };
  }

  let classFilter = '';
  const params = [student.id];
  if (class_name) {
    const cls = findClass(class_name);
    if (!cls) {
      return { error: `Class "${class_name}" not found. Valid classes: ${allClassNames().join(', ')}` };
    }
    classFilter = 'AND class_id = ?';
    params.push(cls.id);
  }

  const records = db
    .prepare(
      `SELECT a.date, a.status, c.name AS class
         FROM attendance a JOIN classes c ON c.id = a.class_id
        WHERE a.student_id = ? ${classFilter}
        ORDER BY a.date`
    )
    .all(...params);

  const present_days = records.filter((r) => r.status === 'present').length;
  const absent_days = records.filter((r) => r.status === 'absent').length;
  const total = present_days + absent_days;
  const percentage = total ? Math.round((present_days / total) * 1000) / 10 : 0;

  return {
    student: student.name,
    usn: student.usn,
    present_days,
    absent_days,
    percentage,
    records: records.map(({ date, status, class: cls }) => ({ date, status, class: cls })),
  };
}
