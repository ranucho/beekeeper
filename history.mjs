// The record behind the profile cards: every agent call and skill use in every chat log on this
// machine (~/.claude/projects, ~5 GB). Each log is read once and kept in a cache keyed by its size,
// so later rounds only re-read the logs that grew. Lines are filtered by text before parsing, so the
// whole scan is a few seconds, not a full JSON parse of every line.
//   node history.mjs        prints a summary
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, ' '));
const CACHE = path.join(ROOT, '.cache', 'history.json');
const WEEK = 7 * 24 * 3600 * 1000;

function projectName(cwd) {
  if (!cwd) return null;
  const m = cwd.replace(/\\/g, '/').split(/(?!)/)[1];
  return m ? m.split('/')[0] : path.basename(cwd);
}

// one log → { started, title, project, calls: [{type, description, at, id}], failed: [ids], skills: [{name, at}] }
async function scanFile(file) {
  const out = { started: null, title: null, project: null, calls: [], failed: [], skills: [] };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!out.started && line.includes('"timestamp"')) { const m = line.match(/"timestamp":"([^"]+)"/); if (m) out.started = m[1]; }
    if (!out.project && line.includes('"cwd"')) { const m = line.match(/"cwd":"([^"]+)"/); if (m) out.project = projectName(m[1].replace(/\\\\/g, '/')); }
    if (line.includes('"custom-title"')) { try { const r = JSON.parse(line); if (r.customTitle) out.title = r.customTitle; } catch {} continue; }
    const agent = line.includes('"name":"Agent"'), skill = line.includes('"name":"Skill"'), err = line.includes('"is_error":true');
    const slash = line.includes('"type":"user"') && /"content":"\/[a-z]/i.test(line);
    if (!agent && !skill && !err && !slash) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain) continue;                                   // inside an agent's own transcript
    const at = r.timestamp || null;
    const content = Array.isArray(r.message?.content) ? r.message.content : [];
    for (const c of content) {
      if (c?.type === 'tool_use' && c.name === 'Agent') out.calls.push({ id: c.id, type: c.input?.subagent_type || 'general-purpose', description: c.input?.description || '', at });
      if (c?.type === 'tool_use' && c.name === 'Skill' && c.input?.skill) out.skills.push({ name: c.input.skill, at });
      if (c?.type === 'tool_result' && c.is_error) out.failed.push(c.tool_use_id);
    }
    if (typeof r.message?.content === 'string') { const m = r.message.content.match(/^\/([a-z0-9:_-]+)/i); if (m) out.skills.push({ name: m[1], at }); }
  }
  out.failed = out.failed.filter(id => out.calls.some(c => c.id === id));
  return out;
}

let cache = null;            // file → { size, data }
let summary = null, building = null;
function loadCache() { if (cache) return; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { cache = {}; } }
function saveCache() { try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch {} }

async function refresh() {
  loadCache();
  const files = [];
  if (fs.existsSync(CLAUDE_DIR)) for (const d of fs.readdirSync(CLAUDE_DIR)) {
    let fl; try { fl = fs.readdirSync(path.join(CLAUDE_DIR, d)); } catch { continue; }
    for (const f of fl) if (f.endsWith('.jsonl')) files.push(path.join(CLAUDE_DIR, d, f));
  }
  let changed = false;
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (cache[f]?.size === st.size) continue;
    try { cache[f] = { size: st.size, data: await scanFile(f) }; changed = true; } catch {}
  }
  for (const f of Object.keys(cache)) if (!files.includes(f)) { delete cache[f]; changed = true; }
  if (changed) saveCache();
  summary = summarize();
}

function summarize(now = Date.now()) {
  const agents = {}, chats = {}, skills = {};
  for (const [file, { data }] of Object.entries(cache)) {
    const id = path.basename(file, '.jsonl');
    const chat = { started: data.started, title: data.title, project: data.project, agents: {}, skills: {} };
    for (const c of data.calls) {
      const a = (agents[c.type] ??= { total: 0, week: 0, projects: {}, jobs: [] });
      a.total++; if (c.at && now - Date.parse(c.at) < WEEK) a.week++;
      if (data.project) a.projects[data.project] = (a.projects[data.project] || 0) + 1;
      a.jobs.push({ at: c.at, project: data.project, chat: data.title, description: c.description, result: data.failed.includes(c.id) ? 'failed' : 'done' });
      chat.agents[c.type] = (chat.agents[c.type] || 0) + 1;
    }
    for (const s of data.skills) {
      chat.skills[s.name] = (chat.skills[s.name] || 0) + 1;
      const k = (skills[s.name] ??= { total: 0, week: 0, last: null });
      k.total++; if (s.at && now - Date.parse(s.at) < WEEK) k.week++; if (s.at && (!k.last || s.at > k.last)) k.last = s.at;
    }
    chats[id] = chat;
  }
  for (const a of Object.values(agents)) {
    a.jobs.sort((x, y) => (y.at || '').localeCompare(x.at || '')); a.jobs = a.jobs.slice(0, 10);
    a.projects = Object.entries(a.projects).sort((x, y) => y[1] - x[1]).slice(0, 3);
  }
  return { generatedAt: new Date(now).toISOString(), agents, chats, skills };
}

// The latest summary right away (built in the background); refreshed at most once a minute.
let lastRun = 0;
export function history() {
  if (!building && Date.now() - lastRun > 60000) { lastRun = Date.now(); building = refresh().catch(() => {}).finally(() => { building = null; }); }
  return summary || { generatedAt: null, agents: {}, chats: {}, skills: {}, loading: true };
}
export async function historyNow() { await refresh(); return summary; }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/%20/g, ' '))) {
  const t = Date.now(); const h = await historyNow();
  console.log(`scanned in ${((Date.now() - t) / 1000).toFixed(1)} s · ${Object.keys(h.chats).length} chats`);
  for (const [k, a] of Object.entries(h.agents).sort((x, y) => y[1].total - x[1].total)) console.log(`${k.padEnd(20)} ${String(a.total).padStart(4)} calls · ${a.week} this week · ${a.projects.map(p => p[0] + ' ' + p[1]).join(', ')}`);
}
