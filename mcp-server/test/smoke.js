/**
 * Smoke test of the real MCP protocol layer: spawns mcp-server/index.js as a
 * child process over stdio, connects as a client, lists tools, and calls
 * check_attendance + list_students. Run from mcp-server/: node test/smoke.js
 */
process.env.ATTENDAI_USER = 'teacher:anil.kumar';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.js'],
  cwd: fileURLToPath(new URL('..', import.meta.url)),
});

const client = new Client({ name: 'attendai-smoke', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
assert.deepStrictEqual(names, ['check_attendance', 'get_class_summary', 'list_students', 'mark_attendance']);
console.log('tools listed:', names.join(', '));

const roster = await client.callTool({ name: 'list_students', arguments: { class_name: 'DAA - Sec A' } });
const rosterBody = JSON.parse(roster.content[0].text);
assert.ok(rosterBody.students.length === 16, 'roster has 16 students');
console.log('list_students ok:', rosterBody.students.length, 'students');

const rec = await client.callTool({
  name: 'check_attendance',
  arguments: { student_usn: '1DS22CD001', class_name: 'DAA - Sec A' },
});
const recBody = JSON.parse(rec.content[0].text);
assert.ok(typeof recBody.percentage === 'number', 'percentage returned');
console.log('check_attendance ok:', recBody.student, recBody.percentage + '%');

const summary = await client.callTool({
  name: 'get_class_summary',
  arguments: { class_name: 'DAA - Sec A' },
});
const sumBody = JSON.parse(summary.content[0].text);
assert.ok(Array.isArray(sumBody.present), 'summary returns buckets');
console.log('get_class_summary ok:', sumBody.present.length, 'present,', sumBody.absent.length, 'absent,', sumBody.not_marked.length, 'not marked');

const denied = await client.callTool({
  name: 'mark_attendance',
  arguments: { class_name: 'OS - Sec B', present_usns: ['1DS22CD001'], confirm: true },
});
const deniedBody = JSON.parse(denied.content[0].text);
assert.ok(deniedBody.error.includes('Access denied'), 'non-owned class denied over MCP');
console.log('mark_attendance access rule ok:', deniedBody.error.slice(0, 60) + '…');

const dry = await client.callTool({
  name: 'mark_attendance',
  arguments: { class_name: 'DBMS - Sec A', absent_usns: ['1DS22CD001'] },
});
const dryBody = JSON.parse(dry.content[0].text);
assert.ok(dryBody.needs_confirmation === true, 'dry run asks for confirmation over MCP');
console.log('mark_attendance confirmation step ok');

await client.close();
console.log('\nMCP smoke test passed.');
