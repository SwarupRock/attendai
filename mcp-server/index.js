/**
 * AttendAI MCP server entrypoint.
 * Registers the four attendance tools and serves them over stdio so any
 * MCP-compatible client (Claude Desktop, Claude Code, etc.) can use them.
 *
 * Identity comes from ATTENDAI_USER (see .env.example):
 *   teacher:anil.kumar   -> may mark attendance for anil.kumar's classes
 *   student:1DS22CD001   -> may only read that student's attendance
 *   (empty)              -> read-only demo session
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { getSession } from './identity.js';
import { allClassNames } from './tools/listStudents.js';
import { checkAttendance } from './tools/checkAttendance.js';
import { listStudents } from './tools/listStudents.js';
import { getClassSummary } from './tools/getClassSummary.js';
import { markAttendance } from './tools/markAttendance.js';

/** Wrap a tool implementation so errors come back as text, not crashes. */
function text(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(err.message || err) }, null, 2) }],
        isError: true,
      };
    }
  };
}

const server = new McpServer({ name: 'attendai', version: '1.0.0' });

const classNameSchema = z
  .string()
  .describe(`Class name, e.g. one of: ${allClassNames().join(' | ')}`);

server.registerTool(
  'check_attendance',
  {
    description:
      'Check a student’s attendance percentage and day-by-day records, optionally scoped to one class. ' +
      'Students can only query their own USN (enforced server-side).',
    inputSchema: z.object({
      student_usn: z.string().describe('Student USN, e.g. 1DS22CD001'),
      class_name: classNameSchema.optional(),
    }),
  },
  text((args) => checkAttendance(args))
);

server.registerTool(
  'mark_attendance',
  {
    description:
      'Mark attendance for a class on a date. ALWAYS call once with confirm=false (default) first: ' +
      'it echoes back exactly who would be marked without writing. Review that, resolve any conflicts ' +
      '(ambiguous names must use USNs), then call again with confirm=true to commit. ' +
      'Teacher sessions only; the teacher must own the class; every write is audited.',
    inputSchema: z.object({
      class_name: classNameSchema,
      date: z.string().optional().describe('ISO date YYYY-MM-DD; defaults to today'),
      present_usns: z.array(z.string()).default([]).describe('USNs or full names marked present'),
      absent_usns: z.array(z.string()).default([]).describe('USNs or full names marked absent'),
      confirm: z.boolean().optional().describe('false = dry run (default), true = commit'),
    }),
  },
  text((args) => markAttendance(args))
);

server.registerTool(
  'list_students',
  {
    description:
      'List the students (name + USN) enrolled in a class. Use this to resolve spoken names ' +
      'into USNs before marking attendance, and to detect duplicate names.',
    inputSchema: z.object({ class_name: classNameSchema }),
  },
  text((args) => listStudents(args.class_name))
);

server.registerTool(
  'get_class_summary',
  {
    description:
      'One-glance summary of a class on a date: who is present, absent, and not yet marked. ' +
      'Use to sanity-check a day’s attendance.',
    inputSchema: z.object({
      class_name: classNameSchema,
      date: z.string().optional().describe('ISO date YYYY-MM-DD; defaults to today'),
    }),
  },
  text((args) => getClassSummary(args))
);

async function main() {
  const session = getSession();
  console.error(`[attendai-mcp] session: ${session.actor} (${session.role})`);
  if (session.role === 'guest') {
    console.error('[attendai-mcp] read-only session: set ATTENDAI_USER=teacher:<username> to enable marking.');
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[attendai-mcp] connected over stdio, waiting for tool calls…');
}

main().catch((err) => {
  console.error('[attendai-mcp] fatal:', err);
  process.exit(1);
});
