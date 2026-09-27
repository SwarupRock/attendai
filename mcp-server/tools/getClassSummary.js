/**
 * get_class_summary — one-glance roster state for a class on a date.
 * Returns present/absent/not_marked lists so a teacher can sanity-check a day.
 */
import { db } from '../db.js';
import { findClass, allClassNames } from './listStudents.js';

export function getClassSummary({ class_name, date }) {
  const cls = findClass(class_name);
  if (!cls) {
    return { error: `Class "${class_name}" not found. Valid classes: ${allClassNames().join(', ')}` };
  }
  const day = date || new Date().toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT s.name, s.usn, a.status
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         LEFT JOIN attendance a ON a.student_id = s.id AND a.class_id = e.class_id AND a.date = ?
        WHERE e.class_id = ?
        ORDER BY s.usn`
    )
    .all(day, cls.id);

  const present = [];
  const absent = [];
  const not_marked = [];
  for (const r of rows) {
    if (r.status === 'present') present.push({ name: r.name, usn: r.usn });
    else if (r.status === 'absent') absent.push({ name: r.name, usn: r.usn });
    else not_marked.push({ name: r.name, usn: r.usn });
  }

  const teacher = db.prepare('SELECT name FROM teachers WHERE id = ?').get(cls.teacher_id);

  return {
    class: cls.name,
    teacher: teacher ? teacher.name : null,
    date: day,
    present,
    absent,
    not_marked,
  };
}
