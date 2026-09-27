# AttendAI — AI-Driven Attendance Management via MCP

A Model Context Protocol (MCP) server that lets an AI agent manage classroom attendance through natural language — teachers say who's absent/present, students ask their own attendance — backed by a **mock college portal you control**, with an optional browser-automation layer for a live demo effect.

This document is written to be handed to **any AI coding assistant** (Claude, GPT, Gemini, local models, etc.) as a build spec. It assumes no prior context beyond this file.

---

## 1. Problem Statement

Real college portals (DSATM's included) have no public API, and directly automating logins into the live production system to write real attendance data is a security and academic-integrity risk (credential exposure, no audit trail distinguishing AI actions from human ones, fragile scraping that can silently corrupt real records).

**This project instead builds the full pipeline on infrastructure we own**: a fake student/teacher portal + a real MCP server + a real AI agent integration. The architecture is identical to what a "real" integration would look like — only the data source is safe to write to.

---

## 2. Architecture

```
┌─────────────┐     natural language      ┌──────────────────┐
│   Teacher   │ ─────────────────────────▶│                  │
│  (chat UI)  │                            │   AI Agent       │
└─────────────┘                            │ (Claude/GPT/etc) │
                                            │                  │
┌─────────────┐     natural language      │  calls MCP tools │
│   Student   │ ─────────────────────────▶│                  │
│  (chat UI)  │                            └────────┬─────────┘
└─────────────┘                                     │
                                                     │ MCP protocol
                                                     ▼
                                        ┌────────────────────────┐
                                        │      MCP Server         │
                                        │  (Node.js or Python)    │
                                        │                          │
                                        │  Tools:                 │
                                        │  - check_attendance      │
                                        │  - mark_attendance       │
                                        │  - list_students         │
                                        │  - get_class_summary     │
                                        └────────┬─────────────────┘
                                                 │
                          ┌──────────────────────┴───────────────────┐
                          ▼                                          ▼
              ┌───────────────────────┐               ┌──────────────────────────┐
              │   Direct DB mode       │               │  Browser automation mode  │
              │  (SQLite/Postgres)     │               │  (Playwright drives a     │
              │  fast, reliable        │               │   FAKE portal you built)  │
              └───────────────────────┘               └──────────────────────────┘
                          │                                          │
                          └──────────────┬───────────────────────────┘
                                          ▼
                              ┌────────────────────────┐
                              │   Mock Portal (Fake)    │
                              │  Express/Flask app +    │
                              │  login page, dashboard, │
                              │  attendance grid         │
                              └────────────────────────┘
```

**Two write paths, same tool interface**: the MCP tools call either the database directly (fast, reliable — use this as the default/primary path) or drive the mock portal's UI via Playwright (slower, but visually proves "it automated a real login and clicked through a real page" for a demo). Both are legitimate to build; direct-DB is what should actually run your demo, browser automation is the "wow" layer on top.

---

## 3. Tech Stack (pick one column, don't mix)

| Layer | Option A (recommended) | Option B |
|---|---|---|
| MCP server | Node.js + `@modelcontextprotocol/sdk` | Python + `mcp` SDK |
| Mock portal backend | Express.js | Flask |
| Mock portal frontend | Plain HTML/CSS/JS (keep it simple) | Same |
| Database | SQLite (`better-sqlite3`) | SQLite (`sqlite3`) |
| Browser automation | Playwright (Node) | Playwright (Python) |
| AI agent | Claude Desktop / Claude API with MCP connector, or any MCP-compatible client | Same |

---

## 4. Repository Structure

```
attendai/
├── README.md                  # quick start (short — links to this PLAN.md for depth)
├── PLAN.md                    # this file
├── LICENSE
├── .env.example                # DB path, portal URL, ports — no real secrets ever committed
├── mock-portal/
│   ├── server.js               # Express app: login, dashboard, attendance grid
│   ├── db/
│   │   ├── schema.sql          # students, teachers, classes, attendance tables
│   │   └── seed.js             # inserts fake students/teachers/classes
│   └── public/
│       ├── login.html
│       ├── teacher-dashboard.html
│       └── student-dashboard.html
├── mcp-server/
│   ├── index.js                # MCP server entrypoint, registers tools
│   ├── tools/
│   │   ├── checkAttendance.js
│   │   ├── markAttendance.js
│   │   ├── listStudents.js
│   │   └── getClassSummary.js
│   └── db.js                   # shared DB connection (direct-DB mode)
├── automation/
│   └── markAttendanceViaBrowser.js   # Playwright script, only targets mock-portal
└── docs/
    └── demo-script.md          # step-by-step script for presenting to judges
```

---

## 5. Database Schema (mock-portal/db/schema.sql)

```sql
CREATE TABLE teachers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  usn TEXT UNIQUE NOT NULL,          -- e.g. fake USN like 1DS22CD001
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                -- e.g. "DAA - Sec A"
  teacher_id INTEGER REFERENCES teachers(id)
);

CREATE TABLE enrollments (
  student_id INTEGER REFERENCES students(id),
  class_id INTEGER REFERENCES classes(id),
  PRIMARY KEY (student_id, class_id)
);

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY,
  student_id INTEGER REFERENCES students(id),
  class_id INTEGER REFERENCES classes(id),
  date TEXT NOT NULL,                -- ISO date
  status TEXT CHECK(status IN ('present','absent')) NOT NULL,
  marked_by INTEGER REFERENCES teachers(id),
  UNIQUE(student_id, class_id, date)
);
```

Seed this with ~15-20 fake students, 2-3 fake teachers, 2-3 fake classes so the demo has enough data to look real.

---

## 6. MCP Tool Definitions

Each tool is a plain function the AI agent can call. Keep inputs/outputs strictly typed so any model can use them reliably.

### `check_attendance`
- **Input**: `{ student_usn: string, class_name?: string }`
- **Output**: `{ present_days: number, absent_days: number, percentage: number, records: [{date, status}] }`
- **Access rule**: a student can only query their own USN. Enforce this in the tool, not just the prompt — pass the authenticated session's USN server-side, don't trust the AI to only ask for its own.

### `mark_attendance`
- **Input**: `{ teacher_id: string, class_name: string, date: string, present_usns: string[], absent_usns: string[] }`
- **Output**: `{ success: boolean, marked_count: number, conflicts: string[] }`
- **Access rule**: only callable by an authenticated teacher session, and only for classes that teacher actually teaches. Validate `teacher_id` owns `class_name` before writing anything.
- **Safety rule**: require the tool to echo back the full list of names it's about to mark before committing (a confirmation step), so a misheard/misparsed name doesn't silently mark the wrong student. Log every write with a timestamp and the acting teacher_id — this audit trail is the single most important safety feature in this project.

### `list_students`
- **Input**: `{ class_name: string }`
- **Output**: `{ students: [{name, usn}] }`
- Used by the teacher's agent to resolve "mark Rahul absent" → an actual USN, and to catch ambiguity (two Rahuls → ask which one).

### `get_class_summary`
- **Input**: `{ class_name: string, date?: string }`
- **Output**: `{ present: [...], absent: [...], not_marked: [...] }`
- Useful for a teacher to sanity-check a day's attendance in one glance.

---

## 7. Browser Automation Layer (optional, demo-only)

- Playwright script logs into **the mock portal** (never anything else) using a teacher account you seed yourself.
- Navigates to the attendance page, clicks the checkboxes/rows matching the `present_usns`/`absent_usns` lists, submits the form.
- Wrap this as an alternate implementation of `mark_attendance` (env flag `USE_BROWSER_AUTOMATION=true`), so switching between "instant DB write" and "watch it click through a fake portal live" is one config change — good for a demo where you want to show both the fast path and the flashy path.
- **Hard rule**: the target URL for this script must always point at `localhost` / your own mock-portal deployment. Never generalize this script to accept an arbitrary URL — that's the line between "demo of a concept" and "a scraper aimed at a real institution's login," and the latter is out of scope for this project.

---

## 8. Build Order (suggested phases)

1. **Phase 1 — Data layer**: build `mock-portal/db/schema.sql` + `seed.js`. Verify with a quick script that you can query fake students/attendance.
2. **Phase 2 — Mock portal UI**: minimal login + teacher dashboard (grid of checkboxes) + student dashboard (attendance %). This should look like a believable college portal, not a bare API.
3. **Phase 3 — MCP server, direct-DB mode**: implement the four tools against the SQLite DB directly. Test each tool by calling it manually before wiring up an AI agent.
4. **Phase 4 — AI agent integration**: connect the MCP server to an MCP-compatible client (Claude Desktop, or the Claude API with MCP support) and test natural-language flows: "Mark Ananya and Rahul absent for DAA today," "What's my attendance in DAA?"
5. **Phase 5 (optional) — Browser automation layer**: add the Playwright path pointed only at your own mock portal.
6. **Phase 6 — Polish for demo**: seed realistic data, write `docs/demo-script.md`, record a backup video in case live demo hiccups.

---

## 9. Security & Safety Notes (keep these, don't cut them for the demo)

- No real DSATM credentials, URLs, or data anywhere in this repo, ever — not even as a "commented out" example.
- Every `mark_attendance` write is logged with who (teacher_id), what (student list + status), and when.
- Role checks happen server-side in the MCP tool, not just via prompt instructions to the AI.
- `.env.example` ships with placeholders only; real `.env` is gitignored.

---

## 10. GitHub Setup — Commands for Anyone Cloning This

```bash
# Clone
git clone https://github.com/<your-username>/attendai.git
cd attendai

# Install dependencies (Option A stack: Node.js)
cd mock-portal && npm install && cd ..
cd mcp-server && npm install && cd ..
cd automation && npm install && cd ..   # only if using the browser automation layer

# Set up environment
cp .env.example .env
# edit .env to set DB path and ports if needed

# Initialize and seed the database
node mock-portal/db/seed.js

# Start the mock portal (in one terminal)
cd mock-portal && npm start
# → running at http://localhost:3000

# Start the MCP server (in another terminal)
cd mcp-server && npm start

# Connect an MCP-compatible AI client to the MCP server
# (e.g. add it to Claude Desktop's MCP config, pointing at mcp-server's stdio/URL)
```

Include a short **README.md** in the repo root with just the Quick Start section above and a link to this `PLAN.md` for full detail — people skimming GitHub want the commands first, the architecture doc second.

---

## 11. Demo Script Outline (put full version in docs/demo-script.md)

1. Show the mock portal briefly — "this simulates DSATM's real portal."
2. Teacher chat: "Mark Priya and Arjun absent for DAA today, everyone else present." → agent calls `list_students`, resolves names, calls `mark_attendance`, confirms back.
3. Student chat: "What's my attendance in DAA?" → agent calls `check_attendance`, reports percentage.
4. (Optional) Toggle `USE_BROWSER_AUTOMATION=true` and repeat step 2, showing Playwright visibly clicking through the mock portal.
5. Close with the real-world framing: "This is built on a safe, self-owned mock system. The same architecture could integrate with a real institution's portal once IT grants API access — that's the intentional next step, not something this project does on its own."

---

## 12. Future Work (real integration path, not part of this build)

- Requesting official API access from DSATM's IT department.
- Adding proper OAuth-based teacher/student login instead of the mock username/password.
- Multi-class, multi-department support.
- Notification layer (SMS/email to students with low attendance).
