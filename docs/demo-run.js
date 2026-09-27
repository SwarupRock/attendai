#!/usr/bin/env node
/**
 * Demo runner — plays the PLAN.md §11 script against the REAL tool
 * implementations (same code the AI agent calls over MCP).
 *
 *   node docs/demo-run.js
 *
 * Beats: teacher marks attendance (with the confirm step) -> class summary ->
 * ambiguity handling (two Rahuls) -> student reads own attendance -> access
 * denials -> audit trail. Identity switches are done by flipping ATTENDAI_USER,
 * exactly like configuring a real MCP client per session.
 *
 * Requires the seeded DB. The portal does NOT need to run for this script,
 * except in browser mode.
 */
process.env.DB_PATH = process.env.DB_PATH || './data/attendai.db';

const ROOT = process.cwd();

function resetIdentity(value) {
  if (value === undefined) delete process.env.ATTENDAI_USER;
  else process.env.ATTENDAI_USER = value;
}

const line = '─'.repeat(66);
const say = (msg) => console.log(`\n${line}\n${msg}\n${line}`);

// The MCP server's identity is read per call; flip the env between scenes.
async function asTeacher(fn) {
  resetIdentity('teacher:anil.kumar');
  const { markAttendance } = await import('../mcp-server/tools/markAttendance.js');
  return fn({ markAttendance });
}
async function asStudent(fn) {
  resetIdentity('student:1DS22CD001');
  const { checkAttendance } = await import('../mcp-server/tools/checkAttendance.js');
  return fn({ checkAttendance });
}
async function asTeacherRead(fn) {
  resetIdentity('teacher:anil.kumar');
  const [{ listStudents }, { getClassSummary }] = await Promise.all([
    import('../mcp-server/tools/listStudents.js'),
    import('../mcp-server/tools/getClassSummary.js'),
  ]);
  return fn({ listStudents, getClassSummary });
}

const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- Scene 2
say('Scene 2 — Teacher: "Mark Priya and Arjun absent for DAA today, everyone else present."');

await asTeacherRead(async ({ listStudents }) => {
  const roster = listStudents('DAA - Sec A');
  console.log(`agent -> list_students("DAA - Sec A")  =>  ${roster.students.length} students`);
});

const absentees = ['Priya Reddy', 'Arjun Iyer'];
let everyone = [];
await asTeacherRead(async ({ listStudents }) => {
  const roster = listStudents('DAA - Sec A');
  // The agent resolves spoken names against the roster, then marks everyone
  // except the named absentees — "everyone else present".
  const absentSet = new Set(absentees.map((n) => n.toLowerCase()));
  everyone = roster.students
    .filter((s) => !absentSet.has(s.name.toLowerCase()))
    .map((s) => s.usn);
});

await asTeacher(async ({ markAttendance }) => {
  console.log('agent -> mark_attendance(confirm=false)  [dry run, echoes before writing]');
  const dry = await markAttendance({
    class_name: 'DAA - Sec A', date: TODAY,
    present_usns: everyone, absent_usns: absentees,
  });
  console.log(`   would mark ${dry.would_mark.present.length} present, ${dry.would_mark.absent.length} absent: ${dry.would_mark.absent.map((s) => s.name).join(', ')}`);
  if (dry.conflicts.length) console.log(`   conflicts: ${JSON.stringify(dry.conflicts)}`);

  const res = await markAttendance({
    class_name: 'DAA - Sec A', date: TODAY,
    present_usns: everyone, absent_usns: absentees, confirm: true,
  });
  console.log(`agent -> mark_attendance(confirm=true)  =>  success=${res.success}, mode=${res.mode}, marked_count=${res.marked_count}`);
  if (res.error || (res.conflicts && res.conflicts.length)) {
    console.log(`   refused: ${res.error || JSON.stringify(res.conflicts)}`);
  }
});

await asTeacherRead(async ({ getClassSummary }) => {
  const s = getClassSummary({ class_name: 'DAA - Sec A', date: TODAY });
  console.log(`agent -> get_class_summary  =>  present=${s.present.length}  absent=${s.absent.length}  not_marked=${s.not_marked.length}`);
});

// ---------------------------------------------------------------- Scene 3
say('Scene 3 — Teacher: "Mark Rahul absent for DAA."  (two Rahuls are seeded)');

await asTeacher(async ({ markAttendance }) => {
  const dry = await markAttendance({
    class_name: 'DAA - Sec A', date: TODAY, absent_usns: ['Rahul'],
  });
  const c = dry.conflicts[0];
  console.log(`agent -> list_students + mark_attendance  =>  CONFLICT: ${c.reason}`);
  console.log(`   candidates: ${c.candidates.join('  |  ')}`);
  console.log('   -> the agent asks WHICH Rahul instead of guessing (nothing written)');
});

// ---------------------------------------------------------------- Scene 4
say('Scene 4 — Student: "What\'s my attendance in DAA?"');

await asStudent(async ({ checkAttendance }) => {
  const own = checkAttendance({ student_usn: '1DS22CD001', class_name: 'DAA - Sec A' });
  console.log(`agent -> check_attendance(1DS22CD001, "DAA - Sec A")  =>  ${own.student}: ${own.percentage}%  (${own.present_days} present / ${own.absent_days} absent)`);
});

// ---------------------------------------------------------------- Scene 5
say('Scene 5 — Security: the rules hold even when the model misbehaves');

await asStudent(async ({ checkAttendance }) => {
  const snooped = checkAttendance({ student_usn: '1DS22CD002', class_name: 'DAA - Sec A' });
  console.log(`student asks for a classmate's attendance  =>  ${snooped.error}`);
});
await asStudent(async () => {
  const { markAttendance } = await import('../mcp-server/tools/markAttendance.js');
  const forged = await markAttendance({ class_name: 'DAA - Sec A', present_usns: ['1DS22CD001'], confirm: true });
  console.log(`student tries to mark attendance          =>  ${forged.error}`);
});
await asTeacher(async () => {
  const { markAttendance } = await import('../mcp-server/tools/markAttendance.js');
  const forged = await markAttendance({
    class_name: 'DAA - Sec A', teacher_id: 'meera.rao', present_usns: ['1DS22CD001'], confirm: true,
  });
  console.log(`agent spoofs another teacher_id           =>  ${forged.error}`);
});
resetIdentity('teacher:anil.kumar');
{
  const { markAttendance } = await import('../mcp-server/tools/markAttendance.js');
  const wrong = await markAttendance({ class_name: 'OS - Sec B', present_usns: ['1DS22CD001'], confirm: true });
  console.log(`teacher marks a class they don't teach    =>  ${wrong.error}`);
}

// ---------------------------------------------------------------- Audit
say('Audit trail — every write is logged (who / what / when / mode)');

// Resolve better-sqlite3 from mock-portal's node_modules.
const { createRequire } = await import('node:module');
const requireFromPortal = createRequire(new URL('../mock-portal/package.json', import.meta.url));
const Database = requireFromPortal('better-sqlite3');
const db = new Database('data/attendai.db', { readonly: true });
const rows = db.prepare('SELECT timestamp, actor, action, class_name, details FROM audit_log ORDER BY id').all();
for (const r of rows) {
  const d = JSON.parse(r.details);
  const detail = r.action === 'mark_attendance'
    ? `present=${(d.present || []).length} absent=${(d.absent || []).map((s) => s.usn).join(',') || '-'} mode=${d.mode}`
    : d.error;
  console.log(`  ${r.timestamp}  ${r.actor.padEnd(18)} ${r.action.padEnd(12)} ${r.class_name || ''}  ${detail}`);
}
db.close();

console.log(`\nDemo complete. Open http://localhost:3000 (anil.kumar / teacher123) to see it in the portal.`);
process.exit(0);
