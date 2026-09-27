# AttendAI — Demo Script

A step-by-step run-of-show for presenting. Total time: ~4 minutes (plus
optional browser-automation flourish).

## Before the demo (one-time setup)

```bash
npm install in mock-portal/, mcp-server/, automation/
npx playwright install chromium
node mock-portal/db/seed.js
```

Start the portal in one terminal: `cd mock-portal && npm start`
(→ http://localhost:3000). Keep a second terminal ready for the MCP server.

Verify the tools once before judges arrive: `cd mcp-server && npm run selftest`.
A scripted dry run of the whole show (same tool code, printed beats):
`node docs/demo-run.js`.

## 1. The portal (30s)

Open http://localhost:3000. Say: *"This simulates a real college portal —
same login, same dashboards — but it's a mock we own, so the AI can safely
write to it."*

Log in as `anil.kumar / teacher123`, show the class list and the attendance
grid briefly. Don't linger.

## 2. Teacher flow (90s)

Connect your MCP client with `ATTENDAI_USER=teacher:anil.kumar`, then say:

> "Mark Priya and Arjun absent for DAA today, everyone else present."

The agent should: call `list_students` (resolving names → USNs), call
`mark_attendance` (dry run — it echoes back exactly who would be marked),
then commit with `confirm=true`. Point out the **confirmation step**: a
misheard name can't silently corrupt records.

Refresh the portal grid to show the writes actually landed. Then open the
`audit_log` table:

```bash
node -e "require('mock-portal/node_modules/better-sqlite3')('data/attendai.db').prepare('SELECT timestamp,actor,action,class_name,details FROM audit_log ORDER BY id DESC LIMIT 3').all().forEach(r=>console.log(r.timestamp,r.actor,r.action,r.class_name))"
```

Every AI write says **who**, **what**, **when**.

## 3. Ambiguity handling (30s, safety flex)

> "Mark Rahul absent for DAA."

The roster has two Rahuls (deliberately seeded). The tool returns a conflict
with candidates instead of guessing — the agent asks *which one*.

## 4. Student flow (30s)

Switch the client's env to `ATTENDAI_USER=student:1DS22CD001` and ask:

> "What's my attendance in DAA?"

Then try: *"What's Rahul Patil's attendance?"* — denied server-side. Students
can only query their own USN; that's enforced in the tool, not the prompt.

## 5. Browser-automation flourish (optional, 60s)

In `.env`: set `USE_BROWSER_AUTOMATION=true` and `HEADED=true`.
Repeat the step-2 command. A Chromium window appears, logs into the mock
portal, clicks through the grid, and saves — visible proof the pipeline drives
a real UI. (Fast DB mode stays the default for reliability.)

## 6. Close with the framing (20s)

*"Everything here runs on infrastructure we own — a fake portal, seeded fake
data, audited writes. The architecture is exactly what a real integration
would look like: swap the mock portal for an institution's official API, and
the MCP tools above stay identical. That's the deliberate next step, not
something this project does on its own."*

## Backup plans

- **Portal won't start**: check port 3000 (`PORTAL_PORT` in `.env`), and that
  `data/attendai.db` exists (reseed).
- **Windows can't reseed**: the portal holds the SQLite file — stop the portal
  (`Ctrl+C`), then `node mock-portal/db/seed.js`.
- **Live demo hiccups**: record a backup video of steps 1–5 the night before.
