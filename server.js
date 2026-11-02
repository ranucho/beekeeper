import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collect, projectDirs } from './live.mjs';
import { history } from './history.mjs';
import { listAgents, listSkills } from './catalog.mjs';
import { studio } from './studio.mjs';

const app = express();
app.use(cors());
app.use('/api/studio', studio);   // redraw rooms from the page (local only)

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
// agents + skills catalog lives in catalog.mjs (shared with push.mjs)
app.get('/api/agents', (req, res) => { res.json({ agents: listAgents(), timestamp: new Date().toISOString() }); });
app.get('/api/skills', (req, res) => { res.json({ skills: listSkills(), timestamp: new Date().toISOString() }); });

// ─── /api/hooks ─────────────────────────────────────────────────────────
// Walk user settings + every project under PROJECTS_ROOT for configured hooks.
app.get('/api/hooks', (req, res) => {
  const out = [];

  function ingest(settingsPath, source) {
    if (!fs.existsSync(settingsPath)) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
    catch { return; }
    const hooks = parsed.hooks;
    if (!hooks || typeof hooks !== 'object') return;
    for (const eventType of Object.keys(hooks)) {
      const entries = hooks[eventType];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const matcher = entry.matcher || '*';
        const list = Array.isArray(entry.hooks) ? entry.hooks : [];
        for (const h of list) {
          out.push({
            event: eventType,
            matcher,
            type: h.type || 'command',
            command: h.command || '',
            source,
          });
        }
      }
    }
  }

  ingest(path.join(CLAUDE_DIR, 'settings.json'), 'global');

  for (const dir of projectDirs()) {
    const projClaude = path.join(dir, '.claude'), proj = path.basename(dir);
    if (!fs.existsSync(projClaude)) continue;
    ingest(path.join(projClaude, 'settings.json'), proj);
    ingest(path.join(projClaude, 'settings.local.json'), `${proj} (local)`);
  }

  res.json({ hooks: out, timestamp: new Date().toISOString() });
});

// ─── /api/activity ──────────────────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const now = Date.now();
  const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000;
  const RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

  const activeSessions = [];
  const recentActivity = [];
  const agentLastSeen = {};
  const toolUsage24h = {};
  const hourlyActivity = new Array(24).fill(0);

  if (!fs.existsSync(projectsDir)) {
    return res.json({ activeSessions, recentActivity, agentLastSeen, toolUsage24h, hourlyActivity, timestamp: new Date().toISOString() });
  }

  for (const projDir of fs.readdirSync(projectsDir)) {
    if (projDir.startsWith('.')) continue;
    const projPath = path.join(projectsDir, projDir);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
    } catch { continue; }

    const projectName = projDir
      .replace(/^-Users-[^-]+-/, '')
      .replace(/^D-/, '')
      .replace(/--/g, ' / ')
      .replace(/-/g, ' ')
      .trim();

    let jsonlFiles;
    try {
      jsonlFiles = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const jf of jsonlFiles) {
      const filePath = path.join(projPath, jf);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }

      if (now - stat.mtimeMs > RECENT_THRESHOLD_MS) continue;

      let lines;
      try {
        lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      } catch { continue; }

      const sessionId = jf.replace('.jsonl', '').slice(0, 8);
      let sessionLastActivity = null;
      let sessionMessageCount = 0;
      const sessionToolsUsed = new Set();

      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const ts = d.timestamp;
          if (!ts) continue;
          const tsMs = new Date(ts).getTime();
          if (isNaN(tsMs)) continue;

          if (now - tsMs < RECENT_THRESHOLD_MS) {
            const hoursAgo = Math.floor((now - tsMs) / (60 * 60 * 1000));
            if (hoursAgo >= 0 && hoursAgo < 24) {
              hourlyActivity[23 - hoursAgo]++;
            }
          }

          if (!sessionLastActivity || ts > sessionLastActivity) sessionLastActivity = ts;
          sessionMessageCount++;

          if (d.type === 'assistant') {
            const content = d.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_use') {
                  const toolName = block.name;
                  sessionToolsUsed.add(toolName);

                  if (now - tsMs < RECENT_THRESHOLD_MS) {
                    toolUsage24h[toolName] = (toolUsage24h[toolName] || 0) + 1;
                  }

                  if (toolName === 'Agent') {
                    const agentType = block.input?.subagent_type || 'general-purpose';
                    const desc = block.input?.description || '';

                    recentActivity.push({ timestamp: ts, agentType, description: desc, projectName });

                    if (!agentLastSeen[agentType] || ts > agentLastSeen[agentType].timestamp) {
                      agentLastSeen[agentType] = { timestamp: ts, description: desc, projectName };
                    }
                  }
                }
              }
            }
          }
        } catch {}
      }

      if (sessionLastActivity) {
        const lastMs = new Date(sessionLastActivity).getTime();
        if (now - lastMs < ACTIVE_THRESHOLD_MS) {
          activeSessions.push({
            projectName, sessionId, lastActivity: sessionLastActivity,
            messageCount: sessionMessageCount, toolsUsed: [...sessionToolsUsed],
          });
        }
      }
    }
  }

  recentActivity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  recentActivity.splice(50);
  activeSessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  res.json({ activeSessions, recentActivity, agentLastSeen, toolUsage24h, hourlyActivity, timestamp: new Date().toISOString() });
});

// ─── /api/projects ──────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const results = [];

  if (!fs.existsSync(projectsDir)) return res.json(results);

  for (const projDir of fs.readdirSync(projectsDir)) {
    if (projDir.startsWith('.')) continue;
    const projPath = path.join(projectsDir, projDir);
    try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }

    const projectName = projDir
      .replace(/^-Users-[^-]+-/, '')
      .replace(/^D-/, '')
      .replace(/--/g, ' / ')
      .replace(/-/g, ' ')
      .trim();

    let jsonlFiles;
    try { jsonlFiles = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    let totalLines = 0;
    let firstTimestamp = null;
    let lastTimestamp = null;
    const agentUsage = {};

    for (const jf of jsonlFiles) {
      let lines;
      try { lines = fs.readFileSync(path.join(projPath, jf), 'utf-8').split('\n').filter(Boolean); } catch { continue; }
      totalLines += lines.length;

      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const ts = d.timestamp;
          if (ts) {
            if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
            if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
          }
          if (d.type === 'assistant') {
            const content = d.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_use' && block?.name === 'Agent') {
                  const agentType = block.input?.subagent_type || 'general-purpose';
                  const desc = block.input?.description || '';
                  if (!agentUsage[agentType]) agentUsage[agentType] = { count: 0, descriptions: [] };
                  agentUsage[agentType].count++;
                  if (agentUsage[agentType].descriptions.length < 3) {
                    agentUsage[agentType].descriptions.push(desc);
                  }
                }
              }
            }
          }
        } catch {}
      }
    }

    if (totalLines > 0) {
      results.push({ projectName, sessions: jsonlFiles.length, totalLines, firstTimestamp, lastTimestamp, agentUsage });
    }
  }

  results.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
  res.json(results);
});

// Live picture of every chat on this machine (the office reads this every few seconds)
// the record behind the profile cards: agent calls, chats, skills from every chat log (history.mjs)
app.get('/api/history', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(history()); });

app.get('/api/live', (req, res) => {
  try { res.json(collect()); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(Number(process.env.BK_API_PORT) || 8081, () => {
  console.log('API server running on http://localhost:8081');
});
