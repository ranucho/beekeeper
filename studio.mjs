// Studio: redraw rooms in a new theme from the page (local only, the VM has no Studio).
// A draw runs the same pipeline as by hand: pixel-gen room2 → pixel-cut room → pixel-selout,
// into public/sprites/rooms/_drafts/. "Keep" swaps the draft in (the old room goes to rooms/_old/)
// and writes the theme back to ROOM-THEMES.md. The style is always pixel art: the theme (and an
// optional reference picture) only changes what is in the room; the pixel rules live in the
// prompt and can't be edited.
// Two profiles: "main" = the author's real rooms; "preview" = the "Try as new user" sandbox in
// rooms/_preview/ (starts with no art, so every room shows the starter room).
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { listProjects } from './live.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOMS = path.join(ROOT, 'public', 'sprites', 'rooms');
const DRAFTS = path.join(ROOMS, '_drafts');
const PREVIEW = path.join(ROOMS, '_preview');
const THEMES = path.join(ROOT, 'ROOM-THEMES.md');
const MODEL = 'gemini-3.1-flash-image', SIZE = '2K';     // the author's pick 2026-10-31 ("a flash 2k are perfect")
const FIT = 0.906;                                        // taller than this (height / width) draws smaller in the hive
const TRIES = 2, MIN_W = Number(process.env.BK_MIN_W) || 370, MAX_W = 540;                // a good room is about 392 px wide; coarse ones come out small, odd ones wide
const PARALLEL = 3;                                       // draws at the same time; the rest wait their turn

const jobs = new Map();                                   // "profile|project" → { status: waiting | drawing | ready | error, started, draft, w, h, fits, error, theme, autoKeep }
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const profileOf = v => v === 'preview' ? 'preview' : 'main';
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; } };
// "My rooms": every room the user added with "Add to my rooms", kept as its own copy so it can be used for any project
const mineDir = profile => profile === 'preview' ? path.join(PREVIEW, 'mine') : path.join(ROOMS, 'mine');
const minePrefix = profile => profile === 'preview' ? '_preview/mine/' : 'mine/';
const isShared = f => /^(pack|mine|_preview\/mine)\//.test(f || '');          // shared room files are never overwritten
const mineList = profile => { const l = readJson(path.join(mineDir(profile), 'list.json')); return Array.isArray(l) ? l.filter(r => fs.existsSync(path.join(mineDir(profile), r.file))) : []; };
const shortName = theme => { const w = String(theme || '').replace(/^(an?|the)\s+/i, '').split(/[\s,.:;]+/).filter(Boolean).slice(0, 3).join(' '); return w ? w[0].toUpperCase() + w.slice(1) : 'My room'; };
function addMine(profile, srcCut, theme) {
  const dir = mineDir(profile); fs.mkdirSync(dir, { recursive: true });
  const list = readJson(path.join(dir, 'list.json')), l = Array.isArray(list) ? list : [];
  const id = 'm' + Date.now().toString(36), file = `${id}.cut.png`;
  fs.copyFileSync(srcCut, path.join(dir, file));
  l.push({ id, name: shortName(theme), file, theme: String(theme || '').slice(0, 600), added: Date.now() });
  fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify(l, null, 2) + '\n');
}
const indexFile = profile => profile === 'preview' ? path.join(PREVIEW, 'index.json') : path.join(ROOMS, 'index.json');

function readThemes(profile) {
  if (profile === 'preview') return readJson(path.join(PREVIEW, 'themes.json'));
  const out = {};
  try {
    for (const line of fs.readFileSync(THEMES, 'utf-8').split('\n')) {
      const m = line.match(/^- \*\*(.+?)\*\*(?: \([^)]*\))?: (.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}
function writeTheme(profile, project, theme) {
  if (profile === 'preview') {
    const f = path.join(PREVIEW, 'themes.json'), t = readJson(f); t[project] = theme;
    return fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\n');
  }
  let text = ''; try { text = fs.readFileSync(THEMES, 'utf-8'); } catch {}
  const lines = text.split('\n'), i = lines.findIndex(l => l.startsWith(`- **${project}**`));
  const line = `- **${project}** (made): ${theme}`;
  if (i >= 0) lines[i] = line; else lines.push(line);
  fs.writeFileSync(THEMES, lines.join('\n'));
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(out.trim().split('\n').slice(-2).join(' ') || `${cmd} failed`)));
  });
}

function dropDraft(job) {
  if (!job?.draft || !fs.existsSync(DRAFTS)) return;
  for (const f of fs.readdirSync(DRAFTS, { withFileTypes: true }).filter(e => e.name.startsWith(job.draft + '.'))) fs.rmSync(path.join(DRAFTS, f.name), { force: true });
}

// one queue for every draw, so "Draw my rooms" never fires 40 calls at once
let running = 0; const queue = [];
function pump() { while (running < PARALLEL && queue.length) { running++; queue.shift()().finally(() => { running--; pump(); }); } }

// Reference pictures (up to 6, data URLs from the page) are written once to a temp folder and shared by every draw of the call.
const MAX_REFS = 6;
function saveRefs(list) {
  const out = []; let dir = null;
  (Array.isArray(list) ? list : []).slice(0, MAX_REFS).forEach((d, i) => {
    const m = String(d || '').match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/); if (!m) return;
    dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'bk-refs-'));
    const f = path.join(dir, `ref${i}.${m[1].replace('jpeg', 'jpg')}`); fs.writeFileSync(f, Buffer.from(m[2], 'base64')); out.push(f);
  });
  return out;
}
const refsOf = body => saveRefs(body?.refs || (body?.ref ? [body.ref] : []));

// refFiles = optional reference pictures (content, colours, mood; redrawn as pixel art)
function draw(profile, project, theme, refFiles, autoKeep = false) {
  const key = `${profile}|${project}`;
  dropDraft(jobs.get(key));
  const draft = `${slug(project)}-${Date.now()}`, job = { status: 'waiting', started: Date.now(), draft, theme, autoKeep, hasRef: refFiles.length > 0 };
  jobs.set(key, job);
  fs.mkdirSync(DRAFTS, { recursive: true });
  queue.push(async () => {
    if (jobs.get(key) !== job) return;                    // discarded while waiting
    Object.assign(job, { status: 'drawing', started: Date.now(), attempt: 1 });
    // The model sometimes draws on a coarse grid (a small, chunky room that looks nothing like the rest), a tall room, or a room with big black parts.
    // A result outside the good range is thrown away and drawn again, up to 3 tries; the best try is kept.
    const rm = name => { for (const ext of ['.png', '.cut.png', '.ink.png']) fs.rmSync(path.join(DRAFTS, name + ext), { force: true }); };
    const wantsDark = /\b(black|dark\w*|night\w*|goth\w*|metal|noir|shadow\w*|haunt\w*|neon|cyber\w*|midnight|vampire|horror|hell\w*|demon\w*|devil\w*|evil|spook\w*|lava|volcan\w*|dungeon|cave\w*|crypt|grave\w*|witch\w*|fire)\b/i.test(theme);   // a dark theme the user asked for gets a looser darkness limit
    const CORE = wantsDark ? 0.09 : 0.04;   // share of the room covered by dark patches (stains / black areas); good rooms measure <= 0.011, stained ones >= 0.031
    const score = (w, h, core, coarse) => (w < MIN_W || w > MAX_W ? 1 : 0) + (core > CORE ? 1 : 0) + (coarse ? 1 : 0) + Math.max(0, h / w - 0.96) + Math.abs(w - 392) / 784 + core * 4;   // 0 = a good room; otherwise the closest to a normal size, and the least stained, wins
    let best = null, lastErr = null;
    const attempt = async a => {                         // one full try: draw, cut, measure
      const name = `${draft}-a${a}`;
      try {
        await run('node', ['scripts/pixel-gen.mjs', 'room2', `_drafts/${name}`, MODEL, SIZE, project, theme], refFiles.length ? { ROOM_REFS: refFiles.join('|') } : {});
        const cut = await run('python3', ['scripts/pixel-cut.py', 'room', `_drafts/${name}`]);
        const [, w, h] = (cut.match(/-> (\d+)x(\d+)/) || []).map(Number);
        if (!w) throw new Error('The room could not be cut out');
        const grain = Number((cut.match(/grain ([\d.]+)/) || [])[1] ?? 1), coarse = grain < 0.35;   // drawn on a 2x grid: every pixel doubled, half the detail of the other rooms (the author, 2026-11-04: "simpler and lower resolution")
        const [dark, vdark, core] = (await run('python3', ['scripts/pixel-dark.py', `_drafts/${name}`])).trim().split(/\s+/).map(Number);
        const good = w >= MIN_W && w <= MAX_W && h / w <= 0.96 && (core || 0) <= CORE && !coarse;
        console.log(`[studio] ${project} try ${a}: ${w}x${h} grain ${grain} dark ${dark} very dark ${vdark} stains ${core} -> ${good ? 'good' : 'redraw'}`);
        return { name, w, h, core: core || 0, s: score(w, h, core || 0, coarse), good };
      } catch (e) { lastErr = e; console.log(`[studio] ${project} try ${a} failed: ${String(e.message || e).slice(0, 200)}`); rm(name); return null; }
    };
    const consider = r => { if (!r) return; if (!best || r.s < best.s) { if (best) rm(best.name); best = r; } else rm(r.name); };
    try {
      // One try is enough almost every time (the coarse cuts came from a grid-detection bug, fixed in pixel-cut.py); a flawed result is drawn again, up to 3 tries.
      for (let a = 1; a <= TRIES && !best?.good; a++) { job.attempt = a; consider(await attempt(a)); }
      if (!best) throw lastErr || new Error('No picture came back');
      await run('python3', ['scripts/pixel-selout.py', `_drafts/${best.name}`]);
      for (const ext of ['.png', '.cut.png', '.ink.png']) { const f = path.join(DRAFTS, best.name + ext); if (fs.existsSync(f)) fs.renameSync(f, path.join(DRAFTS, draft + ext)); }
      Object.assign(job, { status: 'ready', w: best.w, h: best.h, fits: best.h / best.w <= FIT, stained: best.core > CORE });
      fs.writeFileSync(path.join(DRAFTS, `${draft}.json`), JSON.stringify({ profile, project, theme, w: best.w, h: best.h }));   // so a restart can bring it back
      if (job.autoKeep && jobs.get(key) === job) keep(profile, project);
    } catch (e) {
      if (best) rm(best.name);
      if (jobs.get(key) === job) Object.assign(job, { status: 'error', error: String(e.message || e).slice(0, 300) });
    }
  });
  pump();
}

function keep(profile, project) {
  const key = `${profile}|${project}`, job = jobs.get(key);
  if (job?.status !== 'ready') throw new Error('No new version to keep');
  if (!fs.existsSync(path.join(DRAFTS, job.draft + '.cut.png'))) { dropDraft(job); jobs.delete(key); throw new Error('The new room file is gone. Please generate it again.'); }   // never touch the current room unless the new one is really there
  const idxFile = indexFile(profile), index = readJson(idxFile);
  const own = profile === 'preview' ? `_preview/${slug(project)}.cut.png` : `r-${slug(project)}.cut.png`;
  const file = index[project] && !isShared(index[project]) ? index[project] : own, base = file.replace(/\.cut\.png$/, '');   // a ready room is shared: never overwritten
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;   // local time
  fs.mkdirSync(path.dirname(path.join(ROOMS, file)), { recursive: true });
  fs.mkdirSync(path.join(ROOMS, '_old'), { recursive: true });
  for (const ext of ['.png', '.cut.png', '.ink.png']) {
    const cur = path.join(ROOMS, base + ext), neu = path.join(DRAFTS, job.draft + ext);
    if (fs.existsSync(cur)) {
      if (profile === 'main') fs.renameSync(cur, path.join(ROOMS, '_old', `${path.basename(base)}-${stamp}${ext}`));   // the old room is kept, never deleted
      else fs.rmSync(cur);                                                                                             // preview rooms are throwaway
    }
    if (fs.existsSync(neu)) fs.renameSync(neu, cur);
  }
  if (!fs.existsSync(path.join(ROOMS, file))) throw new Error('The room file did not arrive, please generate it again');
  try { addMine(profile, path.join(ROOMS, file), job.theme); } catch {}   // also into "My rooms", ready to use for any project
  dropDraft(job);                                          // the reference picture, if any
  if (index[project] !== file) { index[project] = file; fs.writeFileSync(idxFile, JSON.stringify(index, null, 2) + '\n'); }
  if (job.theme) writeTheme(profile, project, job.theme);
  jobs.delete(key);
  return file;
}

// A restart of the server must not lose finished drafts: bring back the newest one per room.
(function restoreDrafts() {
  if (!fs.existsSync(DRAFTS)) return;
  const bySlug = new Map(listProjects().map(p => [slug(p.name), p.name]));
  const files = fs.readdirSync(DRAFTS).filter(f => f.endsWith('.cut.png')).sort();
  for (const f of files) {
    const draft = f.replace(/\.cut\.png$/, ''), ts = +draft.split('-').pop();
    let meta = readJson(path.join(DRAFTS, `${draft}.json`));
    if (!meta.project) {                                       // drafts from before the .json files: the room comes from the name
      const project = bySlug.get(draft.replace(/-\d+$/, '')); if (!project) continue;
      const png = fs.readFileSync(path.join(DRAFTS, f));
      meta = { profile: 'main', project, theme: '', w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
    }
    jobs.set(`${meta.profile}|${meta.project}`, { status: 'ready', started: ts, draft, theme: meta.theme, w: meta.w, h: meta.h, fits: meta.h / meta.w <= FIT });
  }
})();

export const studio = express.Router();
studio.use(express.json({ limit: '15mb' }));             // reference pictures come in as data URLs

studio.get('/rooms', (req, res) => {
  const profile = profileOf(req.query.profile), index = readJson(indexFile(profile)), themes = readThemes(profile);
  res.set('Cache-Control', 'no-store');
  res.json({
    rooms: listProjects().map(p => {
      const j = jobs.get(`${profile}|${p.name}`);
      return { name: p.name, file: index[p.name] || null, theme: themes[p.name] || '',
        job: j && { status: j.status, attempt: j.attempt || 1, seconds: Math.round((Date.now() - j.started) / 1000), draft: j.draft && `_drafts/${j.draft}.cut.png`, fits: j.fits, stained: j.stained, error: j.error, theme: j.theme, hasRef: j.hasRef } };
    }),
  });
});

studio.post('/room/draw', (req, res) => {
  if (!keyInfo().saved) return needKey(res);
  const { project, theme } = req.body || {}, profile = profileOf(req.body?.profile);
  if (!project || !String(theme || '').trim()) return res.status(400).json({ error: 'A room and a theme are needed' });
  if (['waiting', 'drawing'].includes(jobs.get(`${profile}|${project}`)?.status)) return res.status(409).json({ error: 'Already drawing this room' });
  draw(profile, project, String(theme).trim().slice(0, 600), refsOf(req.body));
  res.json({ ok: true });
});

// "Draw my rooms": one theme for every room. Rooms with no art yet take the new one straight away;
// rooms that already have art get a New version to review.
studio.post('/rooms/draw-all', (req, res) => {
  if (!keyInfo().saved) return needKey(res);
  const { theme, projects } = req.body || {}, profile = profileOf(req.body?.profile), refFiles = refsOf(req.body);
  if (!String(theme || '').trim() || !Array.isArray(projects) || !projects.length) return res.status(400).json({ error: 'A theme and rooms are needed' });
  const index = readJson(indexFile(profile));
  let n = 0;
  for (const project of projects) {
    if (['waiting', 'drawing'].includes(jobs.get(`${profile}|${project}`)?.status)) continue;
    draw(profile, project, String(theme).trim().slice(0, 600), refFiles, !index[project] || isShared(index[project])); n++;
  }
  res.json({ ok: true, started: n });
});

// The ready rooms (free, ship with the app): rooms/pack/<id>.cut.png listed in rooms/pack.json
const packRooms = () => { const l = readJson(path.join(ROOMS, 'pack.json')); return Array.isArray(l) ? l.filter(r => fs.existsSync(path.join(ROOMS, 'pack', r.file))) : []; };
function usePack(profile, project, id) {
  const m = mineList(profile).find(x => x.id === id), r = m || packRooms().find(x => x.id === id); if (!r) throw new Error('No such ready room');
  const idxFile = indexFile(profile), index = readJson(idxFile);
  index[project] = (m ? minePrefix(profile) : 'pack/') + r.file;
  fs.mkdirSync(path.dirname(idxFile), { recursive: true });
  fs.writeFileSync(idxFile, JSON.stringify(index, null, 2) + '\n');
}
studio.get('/pack', (req, res) => {
  const profile = profileOf(req.query.profile); res.set('Cache-Control', 'no-store');
  res.json({ rooms: [...mineList(profile).reverse().map(r => ({ id: r.id, name: r.name, file: minePrefix(profile) + r.file, mine: true })), ...packRooms().map(r => ({ ...r, file: 'pack/' + r.file }))] });   // newest of my rooms first
});
// A second way to fetch a room picture, straight from disk by this server (not through the page's dev server)
studio.get('/file', (req, res) => {
  const rel = String(req.query.p || '').split('?')[0], f = path.resolve(ROOMS, rel);
  if (!f.startsWith(ROOMS + path.sep) || !/\.png$/.test(f) || !fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control', 'no-store'); res.type('png').send(fs.readFileSync(f));
});
studio.post('/room/use-pack', (req, res) => {
  try { usePack(profileOf(req.body?.profile), req.body?.project, req.body?.pack); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
// "Use the ready rooms": every room gets one, taken in turn so neighbours differ
studio.post('/rooms/use-pack-all', (req, res) => {
  const profile = profileOf(req.body?.profile), projects = req.body?.projects, pack = packRooms();
  if (!Array.isArray(projects) || !pack.length) return res.status(400).json({ error: 'No ready rooms' });
  const idxFile = indexFile(profile), index = readJson(idxFile);
  projects.forEach((project, i) => { index[project] = 'pack/' + pack[i % pack.length].file; });
  fs.mkdirSync(path.dirname(idxFile), { recursive: true });
  fs.writeFileSync(idxFile, JSON.stringify(index, null, 2) + '\n');
  res.json({ ok: true, rooms: projects.length });
});

studio.post('/room/keep', (req, res) => {
  try { res.json({ ok: true, file: keep(profileOf(req.body?.profile), req.body?.project) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

studio.post('/room/discard', (req, res) => {
  const key = `${profileOf(req.body?.profile)}|${req.body?.project}`, job = jobs.get(key);
  if (job?.status !== 'drawing') { dropDraft(job); jobs.delete(key); }
  res.json({ ok: true });
});

// The Gemini key. Lookup order (same as scripts/pixel-gen.mjs): the GEMINI_API_KEY variable, the key saved here
// (~/.beekeeper/gemini.key, private to this computer, never part of the project).
const KEY_FILE = path.join(os.homedir(), '.beekeeper', 'gemini.key');
const readSafe = f => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } };
function keyInfo() {
  const env = process.env.GEMINI_API_KEY?.trim(), file = readSafe(KEY_FILE).trim();
  const [source, key] = env ? ['env', env] : file ? ['file', file] : ['none', ''];
  return { saved: !!key, source, hint: key ? '…' + key.slice(-4) : '' };
}
const needKey = res => res.status(400).json({ error: 'Add your Gemini key first (Studio tab, "Gemini key"). The ready rooms are free.', needKey: true });
async function checkKey(key) {
  if (!/^[\w-]{20,}$/.test(key)) return { ok: false, error: "That doesn't look like a Gemini key" };
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
    return r.ok ? { ok: true } : { ok: false, error: r.status === 400 || r.status === 403 ? 'Google did not accept this key' : `Google answered ${r.status}` };
  } catch { return { ok: false, error: "Couldn't reach Google" }; }
}
studio.get('/key', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(keyInfo()); });
studio.post('/key/save', async (req, res) => {              // checked against Google first, then kept on this computer only
  const key = String(req.body?.key || '').trim(), r = await checkKey(key);
  if (!r.ok) return res.json(r);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  res.json({ ok: true, ...keyInfo() });
});
studio.delete('/key', (req, res) => { fs.rmSync(KEY_FILE, { force: true }); res.json(keyInfo()); });
// A free call that lists the models: is this key accepted by Google?
studio.post('/key/check', async (req, res) => {
  res.json(await checkKey(String(req.body?.key || '').trim()));
});

// "Start over" in the new-user preview: wipe the sandbox
studio.post('/preview/reset', (req, res) => {
  for (const [key, job] of jobs) if (key.startsWith('preview|')) { dropDraft(job); jobs.delete(key); }
  fs.rmSync(PREVIEW, { recursive: true, force: true });
  res.json({ ok: true });
});
