/**
 * mark_attendance — the write path.
 *
 * Safety rules implemented here (server-side, not prompt-side):
 *  1. Only an authenticated teacher session (ATTENDAI_USER=teacher:...) can write.
 *  2. The session's teacher must OWN the class. A client-supplied teacher_id
 *     that disagrees with the session is rejected — the agent cannot impersonate.
 *  3. Names are resolved against the real roster; unknown or ambiguous names
 *     come back as conflicts instead of being silently guessed.
 *  4. Confirmation step: with confirm=false the tool echoes back exactly who
 *     would be marked and writes NOTHING. The agent must call again with
 *     confirm=true to commit. This stops a misheard name from corrupting data.
 *  5. Every committed write is appended to the audit_log table:
 *     who (teacher), what (full student/status list), when (ISO timestamp),
 *     and which mode (direct-DB or browser-automation).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, audit } from '../db.js';
import { getSession } from '../identity.js';
import { findClass, allClassNames } from './listStudents.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function envValue(name) {
  const v = process.env[name];
  if (v !== undefined) return v;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (m) return m[1].trim();
  }
  return undefined;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeList(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return [list];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

/** Resolve a mix of USNs and display names into roster students. */
export function resolveRoster(classId, rawEntries) {
  const roster = db
    .prepare(
      `SELECT s.id, s.name, s.usn FROM enrollments e
        JOIN students s ON s.id = e.student_id
       WHERE e.class_id = ?`
    )
    .all(classId);

  const resolved = [];
  const conflicts = [];
  for (const raw of rawEntries) {
    const entry = String(raw).trim();
    const lower = entry.toLowerCase();

    // USN match wins outright.
    const byUsn = roster.find((s) => s.usn.toLowerCase() === lower);
    if (byUsn) {
      resolved.push(byUsn);
      continue;
    }

    // Full-name match (case-insensitive) is the next-best signal.
    let matches = roster.filter((s) => s.name.toLowerCase() === lower);

    // Fall back to first-name match so "Rahul" resolves like a spoken name;
    // if several students share it, surface the ambiguity instead of guessing.
    if (!matches.length) {
      matches = roster.filter((s) => s.name.toLowerCase().split(/\s+/)[0] === lower);
    }

    if (matches.length === 1) {
      resolved.push(matches[0]);
    } else if (matches.length > 1) {
      conflicts.push({
        input: entry,
        reason: `ambiguous: ${matches.length} students match "${entry}" in this class`,
        candidates: matches.map((s) => `${s.name} (${s.usn})`),
      });
    } else {
      conflicts.push({ input: entry, reason: 'not found in this class roster', candidates: [] });
    }
  }
  return { resolved, conflicts };
}

/**
 * Core implementation. Returns an MCP-facing plain object.
 * confirm=false (default) performs a dry run; confirm=true commits.
 */
export async function markAttendance(args) {
  const {
    teacher_id,
    class_name,
    date,
    present_usns,
    absent_usns,
    confirm = false,
  } = args || {};

  const session = getSession();

  // Rule 1: teacher sessions only.
  if (session.role !== 'teacher') {
    return {
      error:
        'Access denied: mark_attendance requires a teacher session. ' +
        `This agent is authenticated as "${session.actor}" (${session.role}).`,
    };
  }

  // Defense in depth: reject a client-supplied teacher_id that disagrees
  // with the authenticated session.
  if (teacher_id !== undefined && teacher_id !== null && String(teacher_id).trim() !== '') {
    const supplied = String(teacher_id).trim();
    const matches =
      supplied === session.username ||
      supplied.toLowerCase() === session.username.toLowerCase() ||
      supplied === String(session.id) ||
      supplied === session.actor;
    if (!matches) {
      return {
        error:
          `Access denied: authenticated teacher is "${session.username}", ` +
          `but the request claims teacher_id "${supplied}". Attendance cannot be marked for another teacher.`,
      };
    }
  }

  const cls = findClass(class_name);
  if (!cls) {
    return { error: `Class "${class_name}" not found. Valid classes: ${allClassNames().join(', ')}` };
  }

  // Rule 2: the session's teacher must own this class.
  if (cls.teacher_id !== session.id) {
    return {
      error:
        `Access denied: "${cls.name}" is taught by teacher #${cls.teacher_id}, ` +
        `not by the authenticated teacher "${session.username}".`,
    };
  }

  const day = date ? String(date).trim() : today();
  if (!DATE_RE.test(day)) {
    return { error: `Invalid date "${day}". Use ISO format YYYY-MM-DD.` };
  }

  const presentIn = normalizeList(present_usns);
  const absentIn = normalizeList(absent_usns);
  if (!presentIn.length && !absentIn.length) {
    return { error: 'Nothing to mark: provide present_usns and/or absent_usns.' };
  }

  const present = resolveRoster(cls.id, presentIn);
  const absent = resolveRoster(cls.id, absentIn);
  const conflicts = [...present.conflicts, ...absent.conflicts];

  const presentSet = new Set(present.resolved.map((s) => s.usn));
  for (const s of absent.resolved) {
    if (presentSet.has(s.usn)) {
      conflicts.push({ input: s.usn, reason: 'listed as both present and absent', candidates: [] });
    }
  }

  const wouldMark = {
    present: present.resolved.map((s) => ({ name: s.name, usn: s.usn })),
    absent: absent.resolved.map((s) => ({ name: s.name, usn: s.usn })),
  };

  // Rule 4: confirmation echo before any write.
  if (!confirm) {
    return {
      needs_confirmation: true,
      class: cls.name,
      date: day,
      would_mark: wouldMark,
      conflicts,
      message:
        `About to mark ${wouldMark.present.length} present and ${wouldMark.absent.length} absent ` +
        `for "${cls.name}" on ${day}. Review would_mark, then call again with confirm=true to commit.`,
    };
  }

  if (conflicts.length) {
    return {
      success: false,
      class: cls.name,
      date: day,
      conflicts,
      message: 'Resolve the conflicts above (use USNs for ambiguous names), then retry.',
    };
  }

  const useBrowser =
    String(envValue('USE_BROWSER_AUTOMATION') ?? 'false').toLowerCase() === 'true';

  let mode = 'direct-db';
  try {
    if (useBrowser) {
      mode = 'browser-automation';
      const { markAttendanceViaBrowser } = await import('../../automation/markAttendanceViaBrowser.js');
      await markAttendanceViaBrowser({
        className: cls.name,
        date: day,
        present: wouldMark.present,
        absent: wouldMark.absent,
      });
    } else {
      const setStmt = db.prepare(
        `INSERT INTO attendance (student_id, class_id, date, status, marked_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(student_id, class_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`
      );
      const write = db.transaction(() => {
        for (const s of wouldMark.present) {
          const row = db.prepare('SELECT id FROM students WHERE usn = ?').get(s.usn);
          setStmt.run(row.id, cls.id, day, 'present', session.id);
        }
        for (const s of wouldMark.absent) {
          const row = db.prepare('SELECT id FROM students WHERE usn = ?').get(s.usn);
          setStmt.run(row.id, cls.id, day, 'absent', session.id);
        }
      });
      write();
    }
  } catch (err) {
    audit(session.actor, 'mark_attendance_failed', {
      error: String(err.message || err),
      class_name: cls.name,
      date: day,
      mode,
      attempted: wouldMark,
    }, { class_name: cls.name, date: day });
    return { success: false, error: `Write failed: ${err.message || err}` };
  }

  // Rule 5: audit trail — who, what, when, mode.
  audit(session.actor, 'mark_attendance', {
    mode,
    class_name: cls.name,
    date: day,
    present: wouldMark.present,
    absent: wouldMark.absent,
  }, { class_name: cls.name, date: day });

  return {
    success: true,
    mode,
    class: cls.name,
    date: day,
    marked_count: wouldMark.present.length + wouldMark.absent.length,
    present: wouldMark.present,
    absent: wouldMark.absent,
    conflicts,
  };
}
