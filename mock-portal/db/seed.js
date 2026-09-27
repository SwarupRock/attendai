#!/usr/bin/env node
/**
 * AttendAI seed script.
 * Creates ./data/attendai.db from schema.sql and fills it with fake demo data:
 * 2 teachers, 18 students, 3 classes, enrollments, and ~2 weeks of attendance
 * history so dashboards and summaries look real out of the box.
 *
 * Usage (from repo root): node mock-portal/db/seed.js
 * Idempotent: rebuilding the file from scratch on every run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = resolveDbPath();

function resolveDbPath() {
  // .env (if present) beats defaults; matches what server.js and mcp-server use.
  const envPath = path.join(ROOT, '.env');
  let dbPath = './data/attendai.db';
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^DB_PATH=(.*)$/m);
    if (m) dbPath = m[1].trim();
  }
  return path.isAbsolute(dbPath) ? dbPath : path.join(ROOT, dbPath);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Deterministic-ish pseudo-random so repeat seeds look similar.
let seedState = 42;
function rand() {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}

// --- Fake data -----------------------------------------------------------

const TEACHERS = [
  { id: 1, name: 'Dr. Anil Kumar', username: 'anil.kumar', password: 'teacher123' },
  { id: 2, name: 'Prof. Meera Rao', username: 'meera.rao', password: 'teacher123' },
];

const CLASSES = [
  { id: 1, name: 'DAA - Sec A', teacher_id: 1 },
  { id: 2, name: 'DBMS - Sec A', teacher_id: 1 },
  { id: 3, name: 'OS - Sec B', teacher_id: 2 },
];

const FIRST_NAMES = [
  'Ananya', 'Rahul', 'Priya', 'Arjun', 'Sneha', 'Vikram', 'Divya', 'Karthik',
  'Pooja', 'Aditya', 'Nisha', 'Rohan', 'Ishita', 'Sandeep', 'Kavya', 'Manish',
  'Tanvi', 'Harish',
];
const LAST_NAMES = [
  'Sharma', 'Patil', 'Reddy', 'Iyer', 'Gowda', 'Nair', 'Desai', 'Hegde',
  'Shetty', 'Rao',
];

// 18 students spread across the 3 classes.
const STUDENTS = FIRST_NAMES.map((first, i) => {
  const last = LAST_NAMES[i % LAST_NAMES.length];
  const usn = `1DS22CD${String(i + 1).padStart(3, '0')}`;
  return {
    id: i + 1,
    name: `${first} ${last}`,
    usn,
    username: usn.toLowerCase(),
    password: 'student123',
    classes: i < 10 ? [1, 2] : i < 15 ? [1, 3] : [2, 3],
  };
});

// Two students named Rahul in class 1 on purpose — used in the demo to show
// how the agent asks which one when a name is ambiguous.
function duplicateRahul() {
  const dup = {
    id: STUDENTS.length + 1,
    name: 'Rahul Gowda',
    usn: `1DS22CD${String(STUDENTS.length + 1).padStart(3, '0')}`,
    username: '',
    password: 'student123',
    classes: [1],
  };
  dup.username = dup.usn.toLowerCase();
  STUDENTS.push(dup);
}
duplicateRahul();

// --- Build the database ---------------------------------------------------

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) {
  try {
    fs.rmSync(DB_PATH);
  } catch (err) {
    console.error(`Cannot rebuild ${DB_PATH}: ${err.code || err.message}`);
    console.error('On Windows, stop the mock portal server first (Ctrl+C in its terminal), then reseed.');
    process.exit(1);
  }
}
// better-sqlite3 leaves -wal/-shm behind; clear those too.
for (const suffix of ['-wal', '-shm']) {
  const p = DB_PATH + suffix;
  if (fs.existsSync(p)) fs.rmSync(p);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const insertTeacher = db.prepare(
  'INSERT INTO teachers (id, name, username, password_hash) VALUES (?, ?, ?, ?)'
);
const insertStudent = db.prepare(
  'INSERT INTO students (id, name, usn, username, password_hash) VALUES (?, ?, ?, ?, ?)'
);
const insertClass = db.prepare(
  'INSERT INTO classes (id, name, teacher_id) VALUES (?, ?, ?)'
);
const insertEnrollment = db.prepare(
  'INSERT INTO enrollments (student_id, class_id) VALUES (?, ?)'
);
const insertAttendance = db.prepare(
  'INSERT INTO attendance (student_id, class_id, date, status, marked_by) VALUES (?, ?, ?, ?, ?)'
);

db.transaction(() => {
  for (const t of TEACHERS) insertTeacher.run(t.id, t.name, t.username, sha256(t.password));
  for (const s of STUDENTS) insertStudent.run(s.id, s.name, s.usn, s.username, sha256(s.password));
  for (const c of CLASSES) insertClass.run(c.id, c.name, c.teacher_id);
  for (const s of STUDENTS) for (const cid of s.classes) insertEnrollment.run(s.id, cid);

  // ~2 weeks of past weekday attendance. Each student has a mostly-present
  // profile with a personal absent rate so percentages differ believably.
  const today = new Date();
  const days = [];
  for (let back = 1; back <= 14 && days.length < 10; back++) {
    const d = new Date(today);
    d.setDate(today.getDate() - back);
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(isoDate(d));
  }
  days.reverse();

  for (const s of STUDENTS) {
    const absentRate = 0.05 + rand() * 0.15;
    for (const cid of s.classes) {
      for (const date of days) {
        const status = rand() < absentRate ? 'absent' : 'present';
        const cls = CLASSES.find((c) => c.id === cid);
        insertAttendance.run(s.id, cid, date, status, cls.teacher_id);
      }
    }
  }
})();

const counts = {
  teachers: db.prepare('SELECT COUNT(*) AS n FROM teachers').get().n,
  students: db.prepare('SELECT COUNT(*) AS n FROM students').get().n,
  classes: db.prepare('SELECT COUNT(*) AS n FROM classes').get().n,
  enrollments: db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n,
  attendance: db.prepare('SELECT COUNT(*) AS n FROM attendance').get().n,
};
db.close();

console.log(`Seeded ${DB_PATH}`);
console.log(JSON.stringify(counts, null, 2));
console.log('\nDemo logins (FAKE accounts, mock portal only):');
for (const t of TEACHERS) console.log(`  teacher  ${t.username} / ${t.password}`);
console.log(`  student  ${STUDENTS[0].username} / ${STUDENTS[0].password}`);
