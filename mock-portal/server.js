/**
 * AttendAI mock portal — a FAKE college portal used as a safe demo target.
 * Plain Express + SQLite. Sessions are in-memory; passwords are demo-only
 * SHA-256 hashes seeded by db/seed.js. Never point real credentials here.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORTAL_PORT || 3000);

function readEnv(name, fallback) {
  const v = process.env[name];
  if (v !== undefined) return v;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (m) return m[1].trim();
  }
  return fallback;
}

const DB_PATH_RAW = readEnv('DB_PATH', './data/attendai.db');
const DB_PATH = path.isAbsolute(DB_PATH_RAW) ? DB_PATH_RAW : path.join(ROOT, DB_PATH_RAW);

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  console.error('Run `node mock-portal/db/seed.js` from the repo root first.');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Naive in-memory session store — fine for a local demo portal.
const sessions = new Map(); // sid -> { role: 'teacher'|'student', id, name }

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sessionOf(req) {
  const sid = (req.headers.cookie || '').match(/sid=([\w-]+)/);
  return sid ? sessions.get(sid[1]) || null : null;
}

function requireTeacher(req, res, next) {
  const s = sessionOf(req);
  if (!s || s.role !== 'teacher') return res.status(401).json({ error: 'teacher login required' });
  req.session = s;
  next();
}

function requireStudent(req, res, next) {
  const s = sessionOf(req);
  if (!s || s.role !== 'student') return res.status(401).json({ error: 'student login required' });
  req.session = s;
  next();
}

// --- Auth -----------------------------------------------------------------

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const t = db.prepare('SELECT id, name FROM teachers WHERE username = ? AND password_hash = ?')
    .get(username.trim().toLowerCase(), sha256(password));
  if (t) {
    const sid = crypto.randomUUID();
    sessions.set(sid, { role: 'teacher', id: t.id, username: username.trim().toLowerCase(), name: t.name });
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    return res.json({ role: 'teacher', redirect: '/teacher-dashboard.html' });
  }

  const s = db.prepare('SELECT id, name, usn FROM students WHERE username = ? AND password_hash = ?')
    .get(username.trim().toLowerCase(), sha256(password));
  if (s) {
    const sid = crypto.randomUUID();
    sessions.set(sid, { role: 'student', id: s.id, usn: s.usn, name: s.name });
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    return res.json({ role: 'student', redirect: '/student-dashboard.html' });
  }

  res.status(401).json({ error: 'invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  const sid = (req.headers.cookie || '').match(/sid=([\w-]+)/);
  if (sid) sessions.delete(sid[1]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: 'not logged in' });
  res.json(s);
});

// --- Teacher API ------------------------------------------------------------

app.get('/api/classes', requireTeacher, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.name, COUNT(e.student_id) AS student_count
       FROM classes c LEFT JOIN enrollments e ON e.class_id = c.id
      WHERE c.teacher_id = ?
      GROUP BY c.id ORDER BY c.name`
  ).all(req.session.id);
  res.json(rows);
});

app.get('/api/classes/:id/students', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?')
    .get(req.params.id, req.session.id);
  if (!cls) return res.status(404).json({ error: 'class not found' });

  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const students = db.prepare(
    `SELECT s.id, s.name, s.usn, a.status
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       LEFT JOIN attendance a ON a.student_id = s.id AND a.class_id = e.class_id AND a.date = ?
      WHERE e.class_id = ?
      ORDER BY s.usn`
  ).all(date, cls.id);
  res.json({ class: cls, date, students });
});

// Used by the Playwright demo path: same effect as submitting the grid form.
app.post('/api/classes/:id/attendance', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?')
    .get(req.params.id, req.session.id);
  if (!cls) return res.status(404).json({ error: 'class not found' });

  const { date, statuses } = req.body || {};
  if (!date || typeof statuses !== 'object' || statuses === null) {
    return res.status(400).json({ error: 'date and statuses required' });
  }

  const setStmt = db.prepare(
    `INSERT INTO attendance (student_id, class_id, date, status, marked_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(student_id, class_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`
  );
  const write = db.transaction((pairs) => {
    for (const [studentId, status] of pairs) {
      if (status !== 'present' && status !== 'absent') continue;
      setStmt.run(Number(studentId), cls.id, date, status, req.session.id);
    }
  });
  write(Object.entries(statuses));
  res.json({ ok: true, class: cls.name, date, marked: Object.keys(statuses).length });
});

// --- Student API ------------------------------------------------------------

app.get('/api/my-attendance', requireStudent, (req, res) => {
  const className = req.query.class;
  const params = [req.session.id];
  let classFilter = '';
  if (className) {
    classFilter = 'AND c.name = ?';
    params.push(className);
  }
  const rows = db.prepare(
    `SELECT c.name AS class, a.date, a.status
       FROM attendance a
       JOIN classes c ON c.id = a.class_id
      WHERE a.student_id = ? ${classFilter}
      ORDER BY c.name, a.date`
  ).all(...params);

  const byClass = {};
  for (const r of rows) {
    byClass[r.class] = byClass[r.class] || { present: 0, absent: 0, records: [] };
    byClass[r.class][r.status]++;
    byClass[r.class].records.push({ date: r.date, status: r.status });
  }
  res.json({ student: req.session.name, usn: req.session.usn, classes: byClass });
});

// --- Static pages ------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.listen(PORT, () => {
  console.log(`Mock portal running at http://localhost:${PORT}`);
  console.log('This is a FAKE portal for demo purposes. Use the seeded demo logins.');
});
