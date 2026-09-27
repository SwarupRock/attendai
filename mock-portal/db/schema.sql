-- AttendAI mock portal schema.
-- All data here is FAKE demo data. No real institution records, ever.

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  usn TEXT UNIQUE NOT NULL,          -- e.g. fake USN like 1DS22CD001
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,         -- e.g. "DAA - Sec A"
  teacher_id INTEGER REFERENCES teachers(id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  student_id INTEGER REFERENCES students(id),
  class_id INTEGER REFERENCES classes(id),
  PRIMARY KEY (student_id, class_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  student_id INTEGER REFERENCES students(id),
  class_id INTEGER REFERENCES classes(id),
  date TEXT NOT NULL,                -- ISO date, e.g. 2026-09-27
  status TEXT CHECK(status IN ('present','absent')) NOT NULL,
  marked_by INTEGER REFERENCES teachers(id),
  UNIQUE(student_id, class_id, date)
);

-- Audit trail: one row per mark_attendance write.
-- Who (teacher_id), what (student list + status), when (timestamp).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,           -- ISO datetime
  actor TEXT NOT NULL,               -- e.g. "teacher:anil.kumar"
  action TEXT NOT NULL,              -- e.g. "mark_attendance"
  class_name TEXT,
  date TEXT,
  details TEXT NOT NULL              -- JSON blob: marked list, conflicts, mode
);
