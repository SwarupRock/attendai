/**
 * Manual self-test for the four tool implementations (Phase 3 of PLAN.md:
 * "Test each tool by calling it manually before wiring up an AI agent").
 *
 * Run: npm run selftest   (from mcp-server/) — needs the DB from
 * `node mock-portal/db/seed.js`. Temporarily fakes ATTENDAI_USER per scenario,
 * so run it with no real ATTENDAI_USER exported.
 */
process.env.ATTENDAI_USER = '';

import assert from 'node:assert';
import { checkAttendance } from '../tools/checkAttendance.js';
import { listStudents } from '../tools/listStudents.js';
import { getClassSummary } from '../tools/getClassSummary.js';
import { markAttendance } from '../tools/markAttendance.js';
import { db } from '../db.js';

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ok - ${label}`);
}

// --- list_students ---------------------------------------------------------
console.log('list_students');
const roster = listStudents('DAA - Sec A');
ok('returns roster', roster.students.length === 16); // ids 1-15 + duplicate Rahul (#19)
ok('students have name+usn', roster.students.every((s) => s.name && s.usn));
ok('unknown class errors', listStudents('Nope 999').error.includes('not found'));

// --- check_attendance ------------------------------------------------------
console.log('check_attendance');
const anyStudent = db.prepare('SELECT usn FROM students LIMIT 1').get();
const rec = checkAttendance({ student_usn: anyStudent.usn, class_name: 'DAA - Sec A' });
ok('returns percentage', typeof rec.percentage === 'number' && rec.percentage >= 0 && rec.percentage <= 100);
ok('records have date+status', rec.records.length > 0 && rec.records.every((r) => r.date && r.status));
ok('unknown USN errors', checkAttendance({ student_usn: 'NOPE123' }).error.includes('No student'));

process.env.ATTENDAI_USER = `student:${anyStudent.usn}`;
const own = checkAttendance({ student_usn: anyStudent.usn });
ok('student can query own USN', own.usn === anyStudent.usn);

const other = db.prepare('SELECT usn FROM students WHERE usn != ? LIMIT 1').get(anyStudent.usn);
const denied = checkAttendance({ student_usn: other.usn });
ok('student denied other USN', denied.error.includes('Access denied'));
process.env.ATTENDAI_USER = '';

// --- get_class_summary -----------------------------------------------------
console.log('get_class_summary');
const yesterday = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
const summary = getClassSummary({ class_name: 'DAA - Sec A', date: yesterday });
ok('summary has three buckets', Array.isArray(summary.present) && Array.isArray(summary.absent) && Array.isArray(summary.not_marked));
ok('seeded day is fully marked', summary.not_marked.length === 0);
ok('buckets cover the roster', summary.present.length + summary.absent.length + summary.not_marked.length === 16);

// --- mark_attendance -------------------------------------------------------
console.log('mark_attendance');

// guest + student sessions are denied outright
let res = await markAttendance({ class_name: 'DAA - Sec A', present_usns: ['1DS22CD001'] });
ok('guest denied', res.error.includes('Access denied'));
process.env.ATTENDAI_USER = 'student:1DS22CD001';
res = await markAttendance({ class_name: 'DAA - Sec A', present_usns: ['1DS22CD001'] });
ok('student denied', res.error.includes('Access denied'));

// teacher session, but wrong class ownership
process.env.ATTENDAI_USER = 'teacher:meera.rao';
res = await markAttendance({ class_name: 'DAA - Sec A', present_usns: ['1DS22CD001'] });
ok('non-owner teacher denied', res.error.includes('Access denied'));

// owner teacher, spoofed teacher_id
process.env.ATTENDAI_USER = 'teacher:anil.kumar';
res = await markAttendance({
  class_name: 'DAA - Sec A', teacher_id: 'meera.rao', present_usns: ['1DS22CD001'],
});
ok('spoofed teacher_id rejected', res.error.includes('cannot be marked for another teacher'));

// dry run writes nothing
const before = db.prepare('SELECT COUNT(*) n FROM attendance').get().n;
res = await markAttendance({
  class_name: 'DAA - Sec A',
  date: '2026-09-20',
  present_usns: ['1DS22CD003', 'Priya Reddy'],
  absent_usns: ['Rahul'],
});
ok('dry run asks for confirmation', res.needs_confirmation === true);
ok('dry run echoes would_mark', res.would_mark.present.length === 2 && res.would_mark.absent.length === 0);
ok('dry run flags ambiguity', res.conflicts.length === 1 && res.conflicts[0].reason.includes('ambiguous'));
ok('dry run wrote nothing', db.prepare('SELECT COUNT(*) n FROM attendance').get().n === before);

// commit with USNs (resolve the ambiguity explicitly)
res = await markAttendance({
  class_name: 'DAA - Sec A',
  date: '2026-09-20',
  present_usns: ['1DS22CD001', '1DS22CD002', '1DS22CD004', '1DS22CD005', '1DS22CD006', '1DS22CD007', '1DS22CD008', '1DS22CD009', '1DS22CD010', '1DS22CD019'],
  absent_usns: ['1DS22CD003'],
  confirm: true,
});
ok('commit succeeds', res.success === true && res.marked_count === 11);
ok('committed via direct-db', res.mode === 'direct-db');
ok('row count grew', db.prepare('SELECT COUNT(*) n FROM attendance').get().n === before + 11);

// audit trail
const lastAudit = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();
ok('audit row written', lastAudit.action === 'mark_attendance' && lastAudit.actor === 'teacher:anil.kumar');
const details = JSON.parse(lastAudit.details);
ok('audit details name every student', details.present.length === 10 && details.absent.length === 1);

// failed write is audited too
process.env.ATTENDAI_USER = 'teacher:anil.kumar';
res = await markAttendance({ class_name: 'DAA - Sec A', present_usns: ['Ghost Person'], confirm: true });
ok('unknown name refuses commit', res.success === false && res.conflicts[0].reason.includes('not found'));

console.log(`\nAll ${passed} assertions passed.`);
