/**
 * Shared DB connection for the MCP server (direct-DB mode).
 * Resolves the same DB_PATH the mock portal uses (env var > .env file > default).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

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

const DB_PATH_RAW = readEnv('DB_PATH', './data/attendai.db');
export const DB_PATH = path.isAbsolute(DB_PATH_RAW) ? DB_PATH_RAW : path.join(ROOT, DB_PATH_RAW);

if (!fs.existsSync(DB_PATH)) {
  console.error(`[attendai-mcp] Database not found at ${DB_PATH}`);
  console.error('[attendai-mcp] Run `node mock-portal/db/seed.js` from the repo root first.');
  process.exit(1);
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Append one audit row. details should be a JSON-serializable object. */
export function audit(actor, action, details, extra = {}) {
  db.prepare(
    `INSERT INTO audit_log (timestamp, actor, action, class_name, date, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    actor,
    action,
    extra.class_name ?? null,
    extra.date ?? null,
    JSON.stringify(details)
  );
}
