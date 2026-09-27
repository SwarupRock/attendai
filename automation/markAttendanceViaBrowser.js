/**
 * Browser-automation write path (Phase 5, demo-only).
 *
 * HARD RULE (PLAN.md §7): this script only ever targets the local mock portal.
 * The URL comes from PORTAL_URL and is REJECTED unless its host is
 * localhost / 127.0.0.1 / [::1]. It must never be generalized to accept an
 * arbitrary URL — that line is what keeps this a demo, not a scraper aimed at
 * a real institution's login.
 *
 * Flow: launch Chromium -> log into the MOCK portal with the seeded teacher
 * account -> open the class attendance grid -> set each student's dropdown ->
 * save. Uses playwright-core with the Chromium bundled by `npx playwright
 * install chromium`; launch fails with a clear hint if no browser is present.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** HARD RULE enforcement: localhost only, or we refuse to run. */
function assertLocalUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl || 'http://localhost:3000');
  } catch {
    throw new Error(`Invalid PORTAL_URL "${rawUrl}"`);
  }
  const h = url.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  if (!isLocal || url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Refusing to run: browser automation may only target the local mock portal ` +
      `(got "${rawUrl}"). This guard is intentional — do not remove it.`
    );
  }
  return url.origin;
}

function findChromium() {
  // 1. Env override, e.g. PLAYWRIGHT_CHROMIUM_PATH=C:\...\<chrome.exe>
  const fromEnv = envValue('PLAYWRIGHT_CHROMIUM_PATH');
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // 2. Standard Playwright browser cache on Windows/macOS/Linux.
  const home = process.env.USERPROFILE || process.env.HOME;
  const candidates = [
    path.join(home, 'AppData', 'Local', 'ms-playwright', 'chromium-*', 'chrome-win', 'chrome.exe'),
    path.join(home, 'Library', 'Caches', 'ms-playwright', 'chromium-*', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join(home, '.cache', 'ms-playwright', 'chromium-*', 'chrome-linux', 'chrome'),
  ];
  for (const pattern of candidates) {
    const dir = path.dirname(pattern.split('*')[0]);
    if (!fs.existsSync(dir)) continue;
    const base = path.basename(path.dirname(pattern)); // e.g. 'chrome-win'
    const found = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('chromium'))
      .sort()
      .reverse()
      .map((name) => path.join(dir, name, base, path.basename(pattern)))
      .find((p) => fs.existsSync(p));
    if (found) return found;
  }

  // 3. Any installed system Chrome/Edge as a last resort.
  const systemCandidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return systemCandidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Mark attendance by visibly driving the mock portal UI.
 * Returns { mode, marked_count } on success.
 */
export async function markAttendanceViaBrowser({ className, date, present, absent }) {
  const portalUrl = assertLocalUrl(envValue('PORTAL_URL') || 'http://localhost:3000');
  const username = envValue('PORTAL_TEACHER_USERNAME');
  const password = envValue('PORTAL_TEACHER_PASSWORD');
  if (!username || !password) {
    throw new Error(
      'PORTAL_TEACHER_USERNAME / PORTAL_TEACHER_PASSWORD not set (see .env.example). ' +
      'These must be the seeded MOCK portal demo credentials.'
    );
  }

  const { chromium } = require('playwright-core');
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      'No Chromium found. Run `npx playwright install chromium` from automation/, ' +
      'or set PLAYWRIGHT_CHROMIUM_PATH to your Chrome/Edge executable.'
    );
  }

  const headed = String(envValue('HEADED') ?? 'false').toLowerCase() === 'true';
  const browser = await chromium.launch({
    executablePath,
    headless: !headed,
    slowMo: headed ? 250 : 0, // visible pauses so a live demo can follow along
  });

  try {
    const page = await browser.newPage();

    // 1. Log into the MOCK portal.
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded' });
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/teacher-dashboard.html', { timeout: 10000 });

    // 2. Open the right class grid by clicking through the UI like a teacher.
    // (The dashboard also supports #class=<id>&date=<date>&auto=1 for humans,
    // but a same-page hash change does not re-run its init, so we click.)
    await page.evaluate(async (name) => {
      const res = await fetch('/api/classes');
      if (!res.ok) throw new Error('Not logged in as a teacher');
      const classes = await res.json();
      const match = classes.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!match) throw new Error(`Class "${name}" not found among: ${classes.map((c) => c.name).join(', ')}`);
      return match.id;
    }, className);

    await page.locator('.class-item', { hasText: className }).first().click();
    await page.waitForSelector('#grid-card', { state: 'visible', timeout: 10000 });
    await page.fill('#date', date);
    await page.click('#load');
    await page.waitForSelector('#student-rows tr', { timeout: 10000 });

    // 3. Set each row's status. The grid keys rows by USN but the save
    // endpoint expects numeric student ids; rows carry both attributes.
    const wanted = new Map();
    for (const s of present) wanted.set(s.usn, 'present');
    for (const s of absent) wanted.set(s.usn, 'absent');

    const idByUsn = await page.evaluate(() => {
      const map = {};
      document.querySelectorAll('#student-rows tr').forEach((tr) => {
        map[tr.dataset.usn] = tr.querySelector('select').dataset.id;
      });
      return map;
    });
    for (const [usn, status] of wanted) {
      const id = idByUsn[usn];
      if (!id) throw new Error(`USN ${usn} not found in the loaded grid`);
      await page.selectOption(`select.status-select[data-id="${id}"]`, status);
    }

    // 4. Save and wait for the toast.
    await page.click('#save');
    await page.waitForSelector('#toast', { state: 'visible', timeout: 10000 });

    const marked = wanted.size;
    return { mode: 'browser-automation', marked_count: marked };
  } finally {
    await browser.close();
  }
}

// Allow running standalone for a quick visual check:
//   node automation/markAttendanceViaBrowser.js
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const usnArg = process.argv[2] || '1DS22CD001';
  const date = new Date().toISOString().slice(0, 10);
  const result = await markAttendanceViaBrowser({
    className: process.argv[3] || 'DAA - Sec A',
    date,
    present: [{ name: usnArg, usn: usnArg }],
    absent: [],
  });
  console.log(JSON.stringify(result, null, 2));
}
