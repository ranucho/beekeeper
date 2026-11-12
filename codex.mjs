// Codex chats (the Codex app and CLI) on the hive, next to the Claude ones (the author, 2026-11-11).
// Read from what Codex already writes, nothing invented:
//   ~/.codex/state_N.sqlite        → threads (title, folder, sub-agents) and Codex's own projects (name + folder)
//   ~/.codex/sessions/.../*.jsonl  → what each chat is doing now (turn open or done, tool, context)
// Every Codex project is a room. A chat goes to the room of its folder: a numbered workspace project
// (same room as its Claude chats) or the Codex project whose folder holds it. Chats in no project are left out.
import fs from 'fs';
import os from 'os';
import path from 'path';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const TAIL_BYTES = 2 * 1024 * 1024;
const RECENT_MS = 90 * 24 * 3600 * 1000;

let sqlite = null;                                   // node:sqlite (Node 22.5+); without it Codex chats are simply not shown
try {
  const quiet = process.emitWarning; process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : quiet.call(process, w, ...a));
  sqlite = await import('node:sqlite');
} catch {}

function stateDb() {
  if (!sqlite) return null;
  let files = []; try { files = fs.readdirSync(CODEX_DIR).filter(f => /^state_\d+\.sqlite$/.test(f)); } catch { return null; }
  const f = files.sort((a, b) => parseInt(b.slice(6)) - parseInt(a.slice(6)))[0];
  if (!f) return null;
  try { return new sqlite.DatabaseSync(path.join(CODEX_DIR, f), { readOnly: true }); } catch { return null; }
}
function query(sql, ...args) {
  const db = stateDb(); if (!db) return [];
  try { return db.prepare(sql).all(...args); } catch { return []; } finally { try { db.close(); } catch {} }
}

function tailLines(file) {
  const size = fs.statSync(file).size, len = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  const lines = buf.toString('utf-8').split('\n'); if (len < size) lines.shift();
  const out = []; for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
const firstLine = s => String(s || '').split('\n').find(l => l.trim()) || '';
const short = (s, n = 90) => { s = firstLine(s).trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// a skill Codex opened: it reads the skill's SKILL.md with a command (cat, sed, rg ...) inside a tool call
export const SKILL_READ = /\/skills\/(?:\.system\/)?([a-z0-9_-]+)\/SKILL\.md/gi;
export function skillsInCall(text) { return [...new Set([...String(text || '').matchAll(SKILL_READ)].map(m => m[1]))]; }
const under = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

// Codex's own projects: [{ name, root, room }]; room = the hive room it lands in
export function codexProjects(roomOfFolder) {
  return query('select p.name, r.path from projects p join project_roots r on r.project_id = p.id order by p.position')
    .map(p => ({ name: p.name, root: p.path, room: roomOfFolder(p.path) || p.name }));
}
// The room for a Codex chat's folder, or null (a chat in no project, a temp folder)
function roomFor(cwd, projects, roomOfFolder) {
  if (!cwd) return null;
  const own = roomOfFolder(cwd); if (own) return own;                       // inside a numbered workspace project or a drawn room
  const hit = projects.filter(p => under(cwd, p.root)).sort((a, b) => b.root.length - a.root.length)[0];
  return hit ? hit.room : null;
}

// What a Codex tool call is doing, in plain words
function plainCall(name, input) {
  let a = input; if (typeof a === 'string') { try { a = JSON.parse(a); } catch {} }
  if (a && typeof a === 'object' && a.title) return a.title;                // the cua tools carry their own title
  const code = typeof input === 'string' ? input : '';
  const inner = code.match(/tools\.([a-z_]+)\(/g)?.map(t => t.slice(6, -1)) || [];
  const t = inner.at(-1) || name;
  if (/apply_patch/.test(t)) return 'Editing files';
  if (/image_gen/.test(t)) return 'Drawing an image';
  if (/view_image/.test(t)) return 'Looking at an image';
  if (/web__run|web_search/.test(t)) return 'Searching the web';
  if (/exec_command|write_stdin|^exec$|shell/.test(t)) return 'Running a command';
  if (/spawn_agent|followup_task|send_message/.test(t)) return 'Messaging its agents';
  if (/wait_agent|wait_threads/.test(t)) return 'Waiting for its agents';
  if (/request_user_input/.test(t)) return 'Asking you';
  if (/update_plan/.test(t)) return 'Updating the plan';
  if (/^wait$|^sleep$/.test(t)) return 'Waiting for a command';
  return 'Using ' + t.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
}

// One Codex chat's present, from the end of its log
function readRollout(file, now, asleepAfter) {
  const recs = tailLines(file);
  let lastActivity = 0, open = false, doing = null, cwd = null, ctx = null, plan = null, turnStart = 0; const skills = [];
  for (const r of recs) {
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0, p = r.payload || {};
    if (ts > lastActivity) lastActivity = ts;
    if (r.type === 'turn_context' && p.cwd) cwd = p.cwd;                     // the latest folder: a chat moved into a project is shown there
    if (r.type === 'session_meta' && p.cwd && !cwd) cwd = p.cwd;
    if (r.type === 'event_msg') {
      if (p.type === 'task_started') { open = true; doing = null; turnStart = ts; }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') open = false;
      else if (p.type === 'token_count' && p.info?.last_token_usage && p.info.model_context_window)
        ctx = { tokens: p.info.last_token_usage.total_tokens || 0, window: p.info.model_context_window };
      else if (p.type === 'item_completed') {
        const it = p.item || {};
        if (it.type === 'FileChange') doing = 'Editing ' + Object.keys(it.changes || {}).map(f => path.basename(f)).join(', ');
        else if (it.type === 'McpToolCall') doing = plainCall(it.tool, it.arguments);
        else if (it.type === 'Extension' && /image_gen/.test(it.kind || '')) doing = 'Drawing an image';
      }
    }
    if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      if (p.name === 'update_plan') { try { plan = JSON.parse(p.arguments).plan; } catch {} }
      for (const name of skillsInCall(typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : JSON.stringify(p.arguments ?? p.input ?? ''))) skills.push({ name, at: ts });
      doing = plainCall(p.name, p.arguments ?? p.input);
    }
  }
  if (!lastActivity) return null;
  const idle = now - lastActivity;
  const state = idle > asleepAfter ? 'asleep' : open ? 'working' : 'waiting';
  const inProg = plan?.find(s => s.status === 'in_progress'), nextStep = plan?.find(s => s.status === 'pending');
  return {
    lastActivity, idle, state, cwd, turnStart,
    skills: skills.slice(-5).reverse().map(k => ({ name: k.name, at: new Date(k.at).toISOString() })),
    turnSkills: [...new Set(skills.filter(k => k.at >= turnStart).reverse().map(k => k.name))],
    doing: state === 'waiting' ? 'Ready' : state === 'asleep' ? 'Asleep' : short(inProg?.step || doing || 'Thinking'),
    next: nextStep ? short(nextStep.step) : null,
    steps: plan ? { done: plan.filter(s => s.status === 'completed').length, total: plan.length } : null,
    context: ctx ? { tokens: ctx.tokens, window: ctx.window, pct: Math.min(100, Math.round(ctx.tokens / ctx.window * 100)) } : null,
  };
}

// Codex sub-agent roles → BeeKeeper characters (Codex's own built-ins have no character of their own)
const ROLE_CHAR = { explorer: 'Explore', worker: 'general-purpose', default: 'general-purpose' };

// Live Codex chats in the same shape as live.mjs readSession()
export function codexSessions(now, { roomOfFolder, asleepAfter, goneAfter, agentMax }) {
  const projects = codexProjects(roomOfFolder);
  const since = now - goneAfter;
  const rows = query(`select id, rollout_path, cwd, title, name, first_user_message, thread_source, source, agent_role, agent_path, updated_at_ms
                      from threads where archived = 0 and coalesce(updated_at_ms, updated_at * 1000) > ?`, since);
  const edges = query('select parent_thread_id parent, child_thread_id child from thread_spawn_edges');
  const parentOf = new Map(edges.map(e => [e.child, e.parent]));
  const read = new Map();
  for (const t of rows) {
    if (t.thread_source === 'guardian_review') continue;                    // Codex's automatic approval reviews: not chats
    try { if (now - fs.statSync(t.rollout_path).mtimeMs > goneAfter) continue; const s = readRollout(t.rollout_path, now, asleepAfter); if (s) read.set(t.id, { t, s }); } catch {}
  }
  const out = [];
  for (const { t, s } of read.values()) {
    if (t.thread_source === 'subagent' || parentOf.has(t.id)) continue;      // a sub-agent shows inside its chat, below
    const project = roomFor(s.cwd || t.cwd, projects, roomOfFolder);
    if (!project) continue;
    const agents = [];
    for (const [child, parent] of parentOf) {
      if (parent !== t.id) continue;
      const c = read.get(child); if (!c || c.s.state !== 'working' || now - c.s.turnStart > agentMax) continue;
      const role = c.t.agent_role || 'worker';
      agents.push({ type: ROLE_CHAR[role] || role, description: short(c.s.doing !== 'Thinking' ? c.s.doing : String(c.t.agent_path || '').split('/').pop().replace(/_/g, ' '), 60), since: new Date(c.s.turnStart || c.s.lastActivity).toISOString() });
    }
    out.push({
      id: 'codex-' + t.id, tool: 'codex', file: t.rollout_path,
      project, projectPath: s.cwd || t.cwd,
      title: short(t.name || t.title || t.first_user_message, 60) || '(untitled chat)',
      state: s.state, lastActivity: new Date(s.lastActivity).toISOString(), idleMs: s.idle,
      doing: s.doing, next: s.next, steps: s.steps, lastTool: null,
      agents, skills: s.skills, context: s.context, turnSkills: s.turnSkills,
    });
  }
  return out;
}

// Rooms Codex works in (its projects, plus workspace rooms where a Codex chat ran), with the newest chat time in each: [{ name, lastActivity }]
export function codexRooms(roomOfFolder) {
  const projects = codexProjects(roomOfFolder); if (!projects.length) return [];
  const latest = new Map(projects.map(p => [p.room, 0]));
  for (const t of query("select cwd, coalesce(updated_at_ms, updated_at * 1000) at from threads where thread_source <> 'guardian_review' and coalesce(updated_at_ms, updated_at * 1000) > ?", Date.now() - RECENT_MS)) {
    const room = roomFor(t.cwd, projects, roomOfFolder); if (room) latest.set(room, Math.max(latest.get(room) || 0, t.at));
  }
  return [...latest].map(([name, at]) => ({ name, lastActivity: at ? new Date(at).toISOString() : null }));
}
