/**
 * Session identity for the MCP server.
 *
 * The AI agent connects as ONE identity configured via ATTENDAI_USER, e.g.
 *   ATTENDAI_USER=teacher:anil.kumar     -> can mark attendance for anil.kumar's classes
 *   ATTENDAI_USER=student:1DS22CD001     -> can only read that student's attendance
 *   ATTENDAI_USER=                       -> read-only demo session
 *
 * Role checks happen HERE and inside every tool, server-side — never by
 * trusting the model's prompts or arguments. The agent cannot ask its way
 * into another role: it simply has no identity to authenticate as.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

export function getSession() {
  const raw = readEnv('ATTENDAI_USER', '');
  if (!raw) {
    return { role: 'guest', actor: 'guest:read-only', name: 'Read-only demo session' };
  }
  const [role, ...rest] = raw.split(':');
  const key = rest.join(':').trim();
  if (role === 'teacher' && key) {
    const t = db.prepare('SELECT id, name, username FROM teachers WHERE username = ?').get(key.toLowerCase());
    if (!t) {
      console.error(`[attendai-mcp] ATTENDAI_USER refers to unknown teacher "${key}"`);
      process.exit(1);
    }
    return { role: 'teacher', id: t.id, name: t.name, username: t.username, actor: `teacher:${t.username}` };
  }
  if (role === 'student' && key) {
    const s = db.prepare('SELECT id, name, usn FROM students WHERE usn = ?').get(key.toUpperCase());
    if (!s) {
      console.error(`[attendai-mcp] ATTENDAI_USER refers to unknown student USN "${key}"`);
      process.exit(1);
    }
    return { role: 'student', id: s.id, name: s.name, usn: s.usn, actor: `student:${s.usn}` };
  }
  console.error(
    `[attendai-mcp] Invalid ATTENDAI_USER "${raw}". Use "teacher:<username>", "student:<USN>", or leave empty.`
  );
  process.exit(1);
}
