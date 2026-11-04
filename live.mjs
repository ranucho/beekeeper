// Live picture of every Claude Code chat on this machine, read from the chat logs that
// Claude Code already writes (~/.claude/projects/<project>/<session>.jsonl).
// Nothing is invented: "doing" is the chat's own current step, or its last tool action.
//   import { collect } from './live.mjs'   →  collect() → { generatedAt, machine, sessions, agents }
//   node live.mjs                           →  prints the picture as text
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readUsage } from './usage.mjs';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const WORKSPACE = /(?!)/;   // never matches: a project is named after its folder
const TAIL_BYTES = 4 * 1024 * 1024;     // read only the end of a log: the present is there
export const ASLEEP_AFTER = 5 * 60 * 1000;        // no activity → asleep (5 minutes)
export const GONE_AFTER = 2 * 60 * 60 * 1000;     // no activity → the chat is gone
const AGENT_MAX = 30 * 60 * 1000;                 // an agent with no end seen is over after 30 min

function tailLines(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf-8').split('\n');
  if (len < size) lines.shift();                   // first line is cut in the middle
  const out = [];
  for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function projectName(cwd) {
  if (!cwd) return null;
  const m = cwd.split(WORKSPACE)[1];
  if (m) return m.split('/')[0] || path.basename(cwd);
  for (let d = cwd; d !== path.dirname(d); d = path.dirname(d)) if (drawnRooms().has(path.basename(d))) return path.basename(d);   // a sub-folder of a project that has a room goes to that room
  return path.basename(cwd);
}

// tool names in plain words, for when a chat has no step list
function plainTool(name) {
  if (!name) return 'Thinking';
  const map = { Bash: 'Running a command', Read: 'Reading a file', Edit: 'Editing a file', Write: 'Writing a file', Grep: 'Searching the code', Glob: 'Looking for files',
    WebSearch: 'Searching the web', WebFetch: 'Reading a web page', ToolSearch: 'Loading a tool', AskUserQuestion: 'Asking you', SendUserFile: 'Sending you a file',
    Agent: 'Calling an agent', Skill: 'Using a skill', SendMessage: 'Messaging an agent' };
  if (map[name]) return map[name];
  if (/Browser|Chrome/.test(name)) return 'Checking in the browser';
  if (/update_plan/.test(name)) return 'Updating the task list';
  if (/wrap_up/.test(name)) return 'Wrapping up';
  if (/mark_chapter|show_pane/.test(name)) return 'Organising the chat';
  return 'Using ' + name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
}
// context window per model: every current model has 1M; Haiku 4.5 and the models before Opus/Sonnet 4.6 have 200K
function contextWindow(model) {
  const m = String(model || '');
  if (/\[1m\]/i.test(m)) return 1e6;
  if (/haiku-4|haiku-3|-3-|opus-4-[015]\b|opus-4-5|sonnet-4-[05]\b|sonnet-4-5|opus-4-2|sonnet-4-2/.test(m)) return 2e5;
  return 1e6;
}
const firstLine = s => String(s || '').split('\n').find(l => l.trim()) || '';
const short = (s, n = 90) => { s = firstLine(s).trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function readSession(file, now = Date.now()) {
  const recs = tailLines(file);
  if (!recs.length) return null;
  let cwd = null, title = null, sessionId = null, lastPrompt = null;
  let lastActivity = 0, lastRole = null, lastStop = null, pendingTool = null, lastToolName = null, lastToolDesc = null;
  let plan = null, planAt = 0;
  const agents = new Map();            // tool_use id → { type, description, since, until }
  const skills = [];
  let turnStart = 0;                   // when the current turn began (the last message that is not a tool result): skill creatures stay for the turn
  let sidechain = 0, main = 0;
  let ctxTokens = null, ctxModel = null;   // how full the chat's context is: the token count of its latest reply

  for (const r of recs) {
    if (r.cwd) cwd = r.cwd;   // the LAST folder: a session moved to another project is shown there
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
    if (r.type === 'last-prompt' && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.type === 'attachment' || r.type === 'queue-operation') {            // a background agent's "done" notice arrives here
      const txt = JSON.stringify(r.attachment || r.content || '');
      if (txt.includes('<task-id>')) { const ts = r.timestamp ? Date.parse(r.timestamp) : lastActivity;
        for (const m of txt.matchAll(/<task-id>([^<]+)<\/task-id>/g)) for (const a of agents.values()) if (!a.until && a.agentId === m[1]) a.until = ts; }
      continue;
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.isSidechain) { sidechain++; continue; } else main++;
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0;
    if (ts > lastActivity) { lastActivity = ts; lastRole = r.type; lastStop = r.stopReason || null; }
    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    const u = r.type === 'assistant' && r.message?.usage;
    if (u && r.message.model !== '<synthetic>') { ctxTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0); ctxModel = r.message.model || ctxModel; }
    if (r.type === 'user' && !r.isMeta && !content.some(c => c?.type === 'tool_result')) turnStart = ts;
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use') {
        pendingTool = { id: c.id, name: c.name, at: ts };
        lastToolName = c.name;
        const inp = c.input || {};
        lastToolDesc = inp.description || (c.name === 'Read' && inp.file_path ? 'Reading ' + path.basename(inp.file_path) : null)
                    || (c.name === 'Edit' || c.name === 'Write' ? (c.name === 'Edit' ? 'Editing ' : 'Writing ') + path.basename(inp.file_path || '') : null)
                    || (c.name === 'Agent' ? `Calling ${inp.subagent_type}: ${inp.description || ''}` : null)
                    || (c.name === 'Skill' ? `Using /${inp.skill}` : null)
                    || null;
        if (c.name === 'mcp__ccd_turn__update_plan' && inp.items) { plan = inp.items; planAt = ts; }
        if (c.name === 'mcp__ccd_turn__update_plan' && inp.advance && plan) {
          const i = plan.findIndex(p => p.status === 'in_progress');
          if (i >= 0) { plan[i].status = 'completed'; const n = plan.findIndex(p => p.status === 'pending'); if (n >= 0) plan[n].status = 'in_progress'; }
          planAt = ts;
        }
        if (c.name === 'Agent') agents.set(c.id, { type: inp.subagent_type || 'agent', description: inp.description || '', since: ts, until: null });
        if (c.name === 'Skill' && inp.skill) skills.push({ name: inp.skill, at: ts });
      }
      if (c.type === 'tool_result') {
        if (pendingTool && c.tool_use_id === pendingTool.id) pendingTool = null;
        const a = agents.get(c.tool_use_id);
        if (a) {
          const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          const m = txt.match(/agentId:\s*([a-z0-9]+)/);
          if (m) a.agentId = m[1];                               // background agent: ends when its task-notification arrives
          else a.until = ts;                                     // foreground agent: the result IS the end
        }
      }
      if (c.type === 'text' && typeof c.text === 'string') {
        for (const m of c.text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) for (const a of agents.values()) if (!a.until && a.agentId === m[1]) a.until = ts;
      }
    }
    // slash commands typed by the user count as skill use
    if (r.type === 'user' && typeof r.message?.content === 'string') {
      const m = r.message.content.match(/^\/([a-z0-9:_-]+)/i); if (m) skills.push({ name: m[1], at: ts });
    }
  }
  if (!lastActivity || main === 0 && sidechain > 0) return null;      // a subagent transcript, not a chat
  const idle = now - lastActivity;
  if (idle > GONE_AFTER) return null;

  let state;
  if (idle > ASLEEP_AFTER) state = 'asleep';
  else if (lastRole === 'assistant' && !pendingTool && (lastStop === 'end_turn' || lastStop === 'stop_sequence' || !lastStop)) state = 'waiting';
  else state = 'working';

  const inProg = plan?.find(p => p.status === 'in_progress');
  const nextStep = plan?.find(p => p.status === 'pending');
  const done = plan ? plan.filter(p => p.status === 'completed').length : 0;
  const allDone = plan && !inProg && !nextStep;
  const doing = state === 'waiting' ? "Waiting for your reply"
              : state === 'asleep' ? `Idle for ${Math.round(idle / 60000)} min`
              : short(inProg?.content || (allDone ? 'Wrapping up' : null) || lastToolDesc || plainTool(lastToolName));
  const activeAgents = [...agents.values()].filter(a => !a.until && now - a.since < AGENT_MAX);

  return {
    id: path.basename(file, '.jsonl'),   // the file, not the sessionId: a forked chat copies the old id
    file,
    project: projectName(cwd), projectPath: cwd,
    title: title || short(lastPrompt, 60) || '(untitled chat)',
    state, lastActivity: new Date(lastActivity).toISOString(), idleMs: idle,
    doing, next: nextStep ? short(nextStep.content) : null,
    steps: plan ? { done, total: plan.length } : null,
    lastTool: lastToolName,
    agents: activeAgents.map(a => ({ type: a.type, description: short(a.description, 60), since: new Date(a.since).toISOString() })),
    skills: skills.slice(-5).reverse().map(s => ({ name: s.name, at: new Date(s.at).toISOString() })),
    context: ctxTokens == null ? null : { tokens: ctxTokens, window: contextWindow(ctxModel), pct: Math.min(100, Math.round(ctxTokens / contextWindow(ctxModel) * 100)) },
    turnSkills: [...new Set(skills.filter(s => s.at >= turnStart).reverse().map(s => s.name))],   // skills used in this turn, newest first
  };
}

// Every known project = every numbered folder in the workspace, plus any folder Claude Code has a
// chat log for. lastActivity = the newest chat log for it (null = never seen).
const WORKSPACE_DIR = process.env.BK_WORKSPACE ? path.resolve(process.env.BK_WORKSPACE) : path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, ' ')), '..');   // folder of numbered project folders (the author's setup); empty for everyone else
const enc = p => p.replace(/[^A-Za-z0-9]/g, '-');
// The folder a chat-log folder belongs to, read from the "cwd" in its newest log (cached)
const cwdCache = new Map();
function cwdOfFolder(folder) {
  if (cwdCache.has(folder)) return cwdCache.get(folder);
  let cwd = null;
  try {
    const dir = path.join(CLAUDE_DIR, folder);
    const newest = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => [f, fs.statSync(path.join(dir, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0];
    if (newest) {
      const fd = fs.openSync(path.join(dir, newest[0]), 'r'), buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, 65536, 0); fs.closeSync(fd);
      const m = buf.toString('utf-8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) cwd = JSON.parse('"' + m[1] + '"');
    }
  } catch {}
  cwdCache.set(folder, cwd);
  return cwd;
}
const JUNK_CWD = /(^|[\\/])(tmp|private[\\/]tmp|scratchpad|node_modules|worktrees)([\\/]|$)|[\\/]\.claude[\\/]/i;
const RECENT_MS = 90 * 24 * 3600 * 1000;          // a project nobody has touched for 90 days gets no room of its own
// Every folder Claude Code has been used in on this machine (for the project-level agents and hooks)
export function projectDirs() {
  const dirs = new Set();
  try { for (const d of fs.readdirSync(WORKSPACE_DIR)) { const f = path.join(WORKSPACE_DIR, d); if (/^\d\d /.test(d) && fs.statSync(f).isDirectory()) dirs.add(f); } } catch {}
  try { for (const folder of fs.readdirSync(CLAUDE_DIR)) { const c = cwdOfFolder(folder); if (c && !JUNK_CWD.test(c) && c !== os.homedir() && fs.existsSync(c)) dirs.add(c); } } catch {}
  return [...dirs];
}
// Projects that have room art (public/sprites/rooms/index.json), read at most once a minute
let roomsCache = { at: 0, names: new Set() };
function drawnRooms() {
  if (Date.now() - roomsCache.at > 60000) {
    let names = new Set(); try { names = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, ' ')), 'public/sprites/rooms/index.json'), 'utf8')))); } catch {}
    roomsCache = { at: Date.now(), names };
  }
  return roomsCache.names;
}
export function listProjects() {
  const out = new Map();
  let dirs = []; try { dirs = fs.readdirSync(WORKSPACE_DIR).filter(d => /^\d\d /.test(d) && fs.statSync(path.join(WORKSPACE_DIR, d)).isDirectory()); } catch {}
  for (const d of dirs) out.set(d, { name: d, path: path.join(WORKSPACE_DIR, d), lastActivity: null });
  const byEnc = new Map([...out.values()].map(p => [enc(p.path), p]));
  if (fs.existsSync(CLAUDE_DIR)) for (const folder of fs.readdirSync(CLAUDE_DIR)) {
    let latest = 0; try { for (const f of fs.readdirSync(path.join(CLAUDE_DIR, folder))) if (f.endsWith('.jsonl')) latest = Math.max(latest, fs.statSync(path.join(CLAUDE_DIR, folder, f)).mtimeMs); } catch { continue; }
    if (!latest) continue;
    let p = byEnc.get(folder);
    if (!p) {                                                   // a chat folder outside the numbered projects (sub-folders map to their project)
      const hit = [...byEnc.entries()].find(([e]) => folder.startsWith(e + '-'));
      if (hit) p = hit[1];
      else if (dirs.length && folder.startsWith(enc(WORKSPACE_DIR) + '-') && !/scratchpad|-tmp-|-\.|node-modules/i.test(folder)) { const name = folder.slice(enc(WORKSPACE_DIR).length + 1).replace(/-/g, ' '); p = { name, path: null, lastActivity: null }; out.set(name, p); }
      else {                                                    // any other folder Claude Code was used in: its own room, named after the folder
        const cwd = cwdOfFolder(folder);
        if (!cwd || JUNK_CWD.test(cwd) || cwd === os.homedir() || Date.now() - latest > RECENT_MS) continue;
        const name = projectName(cwd);
        if (dirs.length && !drawnRooms().has(name)) continue;   // with numbered project folders (the author's workspace) a chat outside it is a project only once its room is drawn
        p = out.get(name) || { name, path: null, lastActivity: null }; out.set(name, p);
      }
    }
    if (!p.lastActivity || latest > Date.parse(p.lastActivity)) p.lastActivity = new Date(latest).toISOString();
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(p => ({ name: p.name, lastActivity: p.lastActivity }));
}

export function collect(now = Date.now()) {
  const sessions = [];
  if (fs.existsSync(CLAUDE_DIR)) {
    for (const proj of fs.readdirSync(CLAUDE_DIR)) {
      const dir = path.join(CLAUDE_DIR, proj);
      let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const full = path.join(dir, f);
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (now - st.mtimeMs > GONE_AFTER) continue;           // untouched for 2 h: not on the floor
        try { const s = readSession(full, now); if (s) sessions.push(s); } catch (e) { /* a half-written line: skip this round */ }
      }
    }
  }
  sessions.sort((a, b) => a.idleMs - b.idleMs);
  const agents = [];
  for (const s of sessions) for (const a of s.agents) agents.push({ ...a, session: s.id, project: s.project, chat: s.title });
  return { generatedAt: new Date(now).toISOString(), machine: os.hostname().replace(/\.local$/, ''), sessions, agents, projects: listProjects(), usage: readUsage(now) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/%20/g, ' '))) {
  const live = collect();
  console.log(`${live.machine} · ${live.sessions.length} chats on the floor · ${live.generatedAt}\n`);
  for (const s of live.sessions) {
    const idle = Math.round(s.idleMs / 1000);
    console.log(`[${s.state.toUpperCase().padEnd(7)}] ${s.project}  ·  "${s.title}"  ·  ${idle < 60 ? idle + ' s' : Math.round(idle / 60) + ' min'} ago`);
    console.log(`          doing: ${s.doing}`);
    if (s.next) console.log(`          next:  ${s.next}`);
    if (s.steps) console.log(`          steps: ${s.steps.done}/${s.steps.total}`);
    if (s.context) console.log(`          context: ${s.context.pct}% (${Math.round(s.context.tokens / 1000)}k of ${s.context.window / 1000}k)`);
    for (const a of s.agents) console.log(`          agent: ${a.type} — ${a.description}`);
    if (s.skills.length) console.log(`          skills: ${s.skills.map(k => '/' + k.name).join(' ')}`);
    console.log();
  }
}
