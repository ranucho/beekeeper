// Plan usage (5-hour limit, weekly, weekly per model), shown as the pill in the top right corner.
// The numbers come from Anthropic's usage endpoint, read with this machine's own Claude Code login
// (Mac: the login Claude Code keeps in the Keychain; elsewhere ~/.claude/.credentials.json).
// The login is only read, never changed or sent anywhere but api.anthropic.com. When it has expired,
// one tiny Claude Code call (at most every 6 h) lets Claude Code renew it itself.
// The last reading is kept in ~/.beekeeper/usage.json: { at, windows: [{ key, label, pct, resetsAt }] }.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

const DIR = path.join(os.homedir(), '.beekeeper');
export const USAGE_FILE = path.join(DIR, 'usage.json');
const TRY_FILE = path.join(DIR, 'usage.try');       // when any process last asked (server.js and push.mjs share it)
const NUDGE_FILE = path.join(DIR, 'usage.nudge');   // when Claude Code was last asked to renew its login
const STALE_AFTER = 6 * 60 * 60 * 1000;             // older than 6 h: not shown (the 5-hour window has moved on)
const EVERY = 60 * 1000, BACKOFF = 5 * 60 * 1000, NUDGE_EVERY = 6 * 60 * 60 * 1000;
const RENEW = !!process.env.BK_RENEW;            // let Claude Code renew an expired login (the public copy: only with BK_RENEW=1)

export function readUsage(now = Date.now()) {
  refreshUsage(now);
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (!u || !Array.isArray(u.windows) || now - Date.parse(u.at) > STALE_AFTER) return null;
    return { at: u.at, windows: u.windows.filter(w => w && typeof w.pct === 'number').map(w => ({ key: String(w.key || w.label), label: String(w.label || w.key), pct: Math.max(0, Math.min(100, Math.round(w.pct))), resetsAt: w.resetsAt || null })) };
  } catch { return null; }
}

const age = f => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return Infinity; } };
const touch = f => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, String(Date.now())); } catch {} };
const run = (cmd, args, ms) => new Promise(res => execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (e, out) => res(e ? null : String(out))));

async function readLogin() {
  let raw = null;
  if (process.platform === 'darwin') raw = await run('security', ['find-generic-password', '-a', os.userInfo().username, '-s', 'Claude Code-credentials', '-w'], 5000);
  if (!raw) { try { raw = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8'); } catch {} }
  try { const o = JSON.parse(raw).claudeAiOauth; return o?.accessToken ? o : null; } catch { return null; }
}

// "seven_day_fable" → "Fable"; 5h and Week first, then Fable, then the rest
const LABELS = { five_hour: '5h', seven_day: 'Week' };
const ORDER = k => k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : /fable/.test(k) ? 2 : 3;
function toWindows(j) {
  const out = [];
  if (Array.isArray(j?.limits) && j.limits.length) {          // the newer list: session, weekly, weekly per model (Fable)
    for (const l of j.limits) {
      if (!l || typeof l.percent !== 'number') continue;
      const name = l.scope?.model?.display_name || l.scope?.surface?.display_name || l.scope?.surface || null;
      const key = l.kind === 'session' ? 'five_hour' : l.kind === 'weekly_all' ? 'seven_day' : 'seven_day_' + String(name || l.kind).toLowerCase().replace(/\W+/g, '_');
      out.push({ key, label: LABELS[key] || String(name || l.kind), pct: l.percent, resetsAt: l.resets_at || null });
    }
    if (out.length) return out.sort((a, b) => ORDER(a.key) - ORDER(b.key));
  }
  for (const [k, v] of Object.entries(j || {})) {
    if (!/^(five_hour|seven_day)/.test(k) || !v || typeof v !== 'object' || typeof v.utilization !== 'number' || /oauth_apps/.test(k)) continue;
    const label = LABELS[k] || k.replace(/^seven_day_/, '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    const r = v.resets_at; const resetsAt = r == null ? null : typeof r === 'number' ? new Date(r < 1e12 ? r * 1000 : r).toISOString() : String(r);
    out.push({ key: k, label, pct: v.utilization, resetsAt });
  }
  return out.sort((a, b) => ORDER(a.key) - ORDER(b.key));
}

let busy = false;
async function refreshUsage() {
  if (busy || age(TRY_FILE) < EVERY) return;
  busy = true; touch(TRY_FILE);
  try {
    let login = await readLogin();
    if (!login) return;
    if (RENEW && login.expiresAt && login.expiresAt < Date.now() + 60000 && age(NUDGE_FILE) > NUDGE_EVERY) {
      touch(NUDGE_FILE);                                                  // expired: let Claude Code renew its own login with one tiny call
      await run('claude', ['-p', 'Reply with the single word OK', '--model', 'haiku'], 90000);
      login = await readLogin(); if (!login) return;
    }
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + login.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000) });
    if (r.status === 429) { fs.utimesSync(TRY_FILE, new Date(Date.now() + BACKOFF), new Date(Date.now() + BACKOFF)); return; }   // asked too often: wait 5 min
    if (!r.ok) return;
    const windows = toWindows(await r.json());
    if (!windows.length) return;
    const tmp = USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), windows }, null, 1)); fs.renameSync(tmp, USAGE_FILE);
  } catch {} finally { busy = false; }
}
