# AttendAI — AI-Driven Attendance Management via MCP

An **MCP (Model Context Protocol) server** that lets an AI agent manage classroom
attendance through natural language — backed by a **mock college portal you
control**, with an optional Playwright layer that visibly clicks through the
portal for demos.

> Teachers say *"Mark Priya and Arjun absent for DAA today, everyone else
> present"* — the agent resolves names to USNs, asks for confirmation, writes
> to the database, and every write is audited (who / what / when).
> Students can ask their own attendance and are denied everyone else's —
> enforced server-side, not by prompting.

Full architecture and design rationale: **[PLAN.md](PLAN.md)** ·
Presentation run-of-show: **[docs/demo-script.md](docs/demo-script.md)** ·
Scripted demo: `node docs/demo-run.js`

---

## What's inside

| Piece | Tech | What it does |
|---|---|---|
| `mcp-server/` | Node.js, `@modelcontextprotocol/server` v2, Zod v4 | Exposes 4 tools over stdio: `check_attendance`, `mark_attendance`, `list_students`, `get_class_summary` |
| `mock-portal/` | Express 5, SQLite (`better-sqlite3`) | Fake college portal: login, teacher attendance grid, student dashboard |
| `automation/` | Playwright | Logs into the mock portal and marks attendance by clicking the UI (demo flourish). **Hard rule: refuses any non-localhost URL** |
| `docs/` | — | Demo script for judges + scripted demo runner |
| `.agents/mcp_config.json` | — | Ready-made Antigravity MCP config |

---

## Prerequisites (per OS)

You need **Node.js 20 or newer** (22 LTS recommended), **Git**, and optionally a
C compiler toolchain (only if a prebuilt SQLite binary isn't available for your
platform — the install step below handles the common cases).

### Windows

Open **PowerShell** (or install via direct downloads — links at the end):

```powershell
# Install Node.js LTS and Git
winget install OpenJS.NodeJS.LTS
winget install Git.Git

# Close and reopen the terminal, then verify:
node -v    # should print v20.x or newer
npm -v
git --version
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y git curl build-essential python3

# Node.js 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v    # should print v22.x
npm -v
```

### macOS

```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node git

node -v    # should print v20.x or newer
npm -v
```

---

## 1. Download (clone) the repo

Works the same on all three OSes — open a terminal (PowerShell on Windows) and run:

```bash
git clone https://github.com/SwarupRock/attendai.git
cd attendai
```

(Prefer SSH or the GitHub Desktop app? Same idea — any way to get the folder
onto your machine is fine.)

---

## 2. Install dependencies

The project has three npm packages. Install all of them from the repo root:

```bash
npm install --prefix mock-portal
npm install --prefix mcp-server
npm install --prefix automation      # only needed for the browser-automation demo
```

<details>
<summary>One-liner alternative (bash / macOS / Linux)</summary>

```bash
for d in mock-portal mcp-server automation; do (cd $d && npm install); done
```
</details>

---

## 3. Configure (optional — defaults work)

```bash
# macOS / Linux / Git Bash on Windows
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Every setting has a working default. The one you may want to change is
`ATTENDAI_USER` — the identity the AI agent acts as:

```ini
ATTENDAI_USER=teacher:anil.kumar   # can mark attendance for anil.kumar's classes
ATTENDAI_USER=student:1DS22CD001   # can only read that student's attendance
ATTENDAI_USER=                     # read-only demo session
```

`.env` is gitignored — never commit real credentials.

---

## 4. Create and seed the database

```bash
node mock-portal/db/seed.js
```

Creates `data/attendai.db` with fake data: 2 teachers, 19 students, 3 classes,
~370 attendance rows. Safe to re-run anytime (it rebuilds the file).

> **Windows note:** if you get `EPERM / Permission denied`, the portal server is
> still running and holding the file. Stop it first (Ctrl+C in its terminal),
> then reseed.

---

## 5. Start the mock portal

```bash
npm start --prefix mock-portal
```

Open **http://localhost:3000** — a believable college portal ("DSATM Connect").
Log in with the seeded fake accounts:

| Role | Username | Password |
|---|---|---|
| Teacher | `anil.kumar` | `teacher123` |
| Teacher | `meera.rao` | `teacher123` |
| Student | `1ds22cd001` | `student123` |

---

## 6. Verify the MCP tools

```bash
cd mcp-server
npm run selftest        # 25 assertions across all four tools
node test/smoke.js      # spawns the real MCP server over stdio and calls the tools
```

Both should end green. The portal does **not** need to be running for these.

---

## 7. Connect an AI client

### Claude Desktop

Add to your config file and restart Claude Desktop:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "attendai": {
      "command": "node",
      "args": ["C:\\path\\to\\attendai\\mcp-server\\index.js"],
      "env": { "ATTENDAI_USER": "teacher:anil.kumar" }
    }
  }
}
```

(Use forward slashes on macOS/Linux: `/home/you/attendai/mcp-server/index.js`.)

### Google Antigravity

A ready-made config ships in this repo at `.agents/mcp_config.json` (workspace
level). After cloning, edit the `args` path to point at **your** clone
directory. For all-workspace access, copy the same JSON to
`~/.gemini/config/mcp_config.json` (Windows: `C:\Users\<you>\.gemini\config\mcp_config.json`).

### Then just talk to it

With the **teacher** server active:

> "Mark Priya and Arjun absent for DAA today, everyone else present."
> "Mark Rahul absent for DAA."   ← two Rahuls are seeded; the agent must ask which one

With the **student** server active:

> "What's my attendance in DAA?"
> "What's 1DS22CD002's attendance?"   ← denied, server-side

---

## 8. Browser-automation mode (optional, demo flourish)

```bash
cd automation
npx playwright install chromium    # downloads a bundled browser
```

> **Ubuntu:** if the browser fails to launch, also run
> `npx playwright install-deps chromium` (needs sudo) to install system libraries.
> **Any OS with Chrome already installed:** the script auto-detects system
> Chrome/Edge as a fallback, or set `PLAYWRIGHT_CHROMIUM_PATH` to the executable.

Then in `.env`:

```ini
USE_BROWSER_AUTOMATION=true
HEADED=true     # show the browser window during the demo
```

Now `mark_attendance` drives the real portal UI (login → grid → save) instead
of writing to SQLite directly. Same tool, same audit trail, visible clicking.
Set `USE_BROWSER_AUTOMATION=false` to go back to the fast direct-DB path.

You can also run the automation standalone:

```bash
node automation/markAttendanceViaBrowser.js 1DS22CD012 "DAA - Sec A"
```

**Hard rule:** the script refuses to target anything except localhost. That
guard is intentional — see PLAN.md §7.

---

## MCP tool reference

| Tool | Input | Output | Access |
|---|---|---|---|
| `check_attendance` | `{ student_usn, class_name? }` | percentage + day-by-day records | students: own USN only (server-enforced); teachers/guest: any |
| `mark_attendance` | `{ class_name, date?, present_usns, absent_usns, confirm }` | dry-run echo, then commit result | teacher sessions only, must own the class; every write audited |
| `list_students` | `{ class_name }` | roster `{name, usn}` | any |
| `get_class_summary` | `{ class_name, date? }` | present / absent / not_marked lists | any |

Safety model (all enforced in the server, not the prompt):

1. Role checks server-side (`ATTENDAI_USER` identity) — a student session
   cannot mark attendance, cannot read others' records.
2. Class ownership check — a teacher cannot mark another teacher's class.
3. Client-supplied `teacher_id` that disagrees with the session is rejected.
4. **Confirmation step** — `mark_attendance` echoes exactly who would be marked
   and writes nothing until called again with `confirm=true`.
5. **Audit trail** — every committed (and failed) write lands in the
   `audit_log` table: who, what, when, and which write mode.

Read the audit trail:

```bash
node -e "const Database=require('./mock-portal/node_modules/better-sqlite3');const db=new Database('data/attendai.db',{readonly:true});for(const r of db.prepare('SELECT * FROM audit_log ORDER BY id').all())console.log(r.timestamp,r.actor,r.action,r.class_name,r.details)"
```

---

## Project structure

```
attendai/
├── README.md                     ← this file
├── PLAN.md                       ← full architecture & build spec
├── LICENSE                       ← MIT
├── .env.example                  ← placeholders only
├── .agents/
│   └── mcp_config.json           ← Antigravity MCP config (edit path after cloning)
├── mock-portal/
│   ├── server.js                 ← Express app: login, dashboards, attendance APIs
│   ├── db/
│   │   ├── schema.sql
│   │   └── seed.js               ← creates + seeds data/attendai.db
│   └── public/
│       ├── login.html
│       ├── teacher-dashboard.html
│       └── student-dashboard.html
├── mcp-server/
│   ├── index.js                  ← MCP entrypoint, registers the 4 tools (stdio)
│   ├── db.js                     ← shared SQLite connection + audit helper
│   ├── identity.js               ← ATTENDAI_USER session/role resolution
│   ├── tools/
│   │   ├── checkAttendance.js
│   │   ├── markAttendance.js
│   │   ├── listStudents.js
│   │   └── getClassSummary.js
│   └── test/
│       ├── selftest.js           ← 25 assertions on tool behavior + access rules
│       └── smoke.js              ← real MCP protocol round-trip
├── automation/
│   └── markAttendanceViaBrowser.js  ← Playwright, localhost-only
└── docs/
    ├── demo-script.md            ← judge-facing run of show
    └── demo-run.js               ← scripted demo of all scenes
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `better-sqlite3` fails to build on install | Install a C toolchain: Windows: `winget install Microsoft.VisualStudio.2022.BuildTools`; Ubuntu: `sudo apt install -y build-essential python3`; macOS: `xcode-select --install`. Then reinstall. |
| Portal won't start / port 3000 busy | Change `PORTAL_PORT` in `.env`, or stop the other process using port 3000. |
| `EPERM` when reseeding (Windows) | The portal is holding the DB file — stop it (Ctrl+C), reseed, restart. |
| MCP tools don't appear in your client | Check the `args` path is absolute and points at `mcp-server/index.js`; check `node -v` ≥ 20; restart the client. |
| Playwright: "No Chromium found" | `cd automation && npx playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_PATH` to your Chrome/Edge executable. |
| Browser mode opens nothing on Ubuntu | `npx playwright install-deps chromium`, or run with `HEADED=false`. |
| Everything is marked "present" unexpectedly | Don't save the grid without touching it — unmarked rows default to "— not marked —" and are skipped (fixed behavior; older checkouts may differ). |

---

## Safety

This project deliberately never touches a real institution's portal. No real
credentials, URLs, or data exist in this repo — all data is seeded fake data,
and the browser-automation layer refuses any non-localhost target. See
**PLAN.md §9** for the full security rationale and **§12** for the intended
real-integration path (official API access, OAuth, notifications).

## License

[MIT](LICENSE)
