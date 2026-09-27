/**
 * list_students — roster for a class.
 * Used by the teacher's agent to resolve "mark Rahul absent" into a real USN
 * and to catch ambiguity (two Rahuls -> ask the teacher which one).
 */
export function listStudents(className) {
  const cls = findClass(className);
  if (!cls) {
    return { error: `Class "${className}" not found. Valid classes: ${allClassNames().join(', ')}` };
  }
  const students = db
    .prepare(
      `SELECT s.name, s.usn FROM enrollments e
        JOIN students s ON s.id = e.student_id
       WHERE e.class_id = ? ORDER BY s.usn`
    )
    .all(cls.id);
  return { class: cls.name, students };
}

import { db } from '../db.js';

export function findClass(className) {
  return db
    .prepare('SELECT id, name, teacher_id FROM classes WHERE LOWER(name) = LOWER(?)')
    .get(String(className).trim());
}

export function allClassNames() {
  return db.prepare('SELECT name FROM classes ORDER BY name').all().map((r) => r.name);
}
