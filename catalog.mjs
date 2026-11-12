// The catalog of this machine's agents and skills, read from ~/.claude (and the projects' .claude folders).
// Used by server.js (/api/agents, /api/skills) and by push.mjs (sent to the office server).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { projectDirs } from './live.mjs';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');


// ─── YAML frontmatter parser (minimal, handles the shapes we see) ───────
// Supports:
//   key: value
//   key: "quoted value"
//   key:
//     - item                  → array
//     - item
//   key: a, b, c              → string (caller can split if needed)
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fm: {}, body: text };
  const body = text.slice(m[0].length).trimStart();
  const fm = {};
  let currentKey = null;
  let currentMode = null; // 'scalar' | 'list'
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue;

    // List item under the previous key
    const listItem = rawLine.match(/^\s+-\s+(.*)$/);
    if (listItem && currentKey && (currentMode === 'list' || (Array.isArray(fm[currentKey])))) {
      let val = listItem[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(val);
      currentMode = 'list';
      continue;
    }

    const kv = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let val = kv[2].trim();
      if (val === '') {
        // Could be opening a list — leave undefined; first list item will create the array
        fm[currentKey] = '';
        currentMode = 'list';
      } else {
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        fm[currentKey] = val;
        currentMode = 'scalar';
      }
    } else if (currentKey && rawLine.startsWith(' ')) {
      // continuation line — append to last scalar
      if (currentMode === 'scalar') {
        fm[currentKey] = (fm[currentKey] ? fm[currentKey] + ' ' : '') + rawLine.trim();
      }
    }
  }
  return { fm, body };
}

function toolsFromFrontmatter(fm) {
  if (Array.isArray(fm.tools)) return fm.tools.map(s => String(s).trim()).filter(Boolean);
  if (typeof fm.tools === 'string') {
    return fm.tools.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// Try to extract a "Persona Name (Role)" pattern from descriptions.
function parsePersona(description) {
  if (!description) return { role: null, persona: null };
  const m = description.match(/^([^.(]{2,60})\s*\(([^)]+)\)\.?/);
  if (!m) return { role: null, persona: null };
  return { role: m[1].trim(), persona: m[2].trim() };
}

// Curated persona/role fallbacks (from the original dashboard's hand-authored
// names). Used when an agent's description doesn't embed them.
const PERSONA_FALLBACKS = {
  'brand-agent':       { persona: 'Arlo Venn',        role: 'Brand Strategist' },
  'ui-agent':          { persona: 'Lena Kovac',       role: 'UI Architect' },
  'ui-ux-designer':    { persona: 'Zara Lindström',   role: 'Design Director' },
  'ux-agent':          { persona: 'Felix Moreau',     role: 'UX Strategist' },
  'visual-agent':      { persona: 'Mika Solis',       role: 'Visual Designer' },
  'code-builder':      { persona: 'Marcus Cole',      role: 'TDD Architect' },
  'test-writer':       { persona: 'Rina Patel',       role: 'Test Engineer' },
  'linter':            { persona: 'Kit Tanaka',       role: 'Code Quality Lead' },
  'qa-auditor':        { persona: 'Daniel Marchetti',  role: 'Senior QA Auditor' },
  'doc-updater':       { persona: 'Sam Okafor',       role: 'Documentation Specialist' },
  'Explore':           { persona: 'Nova Chen',        role: 'Codebase Scout' },
  'Plan':              { persona: 'Iris Nakamura',    role: 'Systems Architect' },
  'general-purpose':   { persona: 'Theo Vasquez',     role: 'Multi-Tool Generalist' },
  'claude-code-guide': { persona: 'Eli Frost',        role: 'Knowledge Navigator' },
  'statusline-setup':  { persona: 'Sage Park',        role: 'Status Line Curator' },
};


export function listAgents() {
  // Map<agentId, { meta, scopes: Set<string> }> — dedupes across projects
  const agentMap = new Map();

  function ingestAgentFile(fullPath, scope, defaultGroup) {
    let txt;
    try { txt = fs.readFileSync(fullPath, 'utf-8'); } catch { return; }
    const { fm } = parseFrontmatter(txt);
    if (!fm.name) return;
    const id = String(fm.name);

    if (!agentMap.has(id)) {
      const tools = toolsFromFrontmatter(fm);
      const parsed = parsePersona(fm.description || '');
      const fb = PERSONA_FALLBACKS[id] || {};
      agentMap.set(id, {
        meta: {
          id,
          name: id,
          persona: fb.persona || parsed.persona || null,
          role: fb.role || parsed.role || null,
          description: fm.description || '',
          model: fm.model || 'inherit',
          tools,
          source: 'user',
          group: defaultGroup,
          scopes: [],
        },
      });
    }
    const entry = agentMap.get(id);
    if (!entry.meta.scopes.includes(scope)) entry.meta.scopes.push(scope);
  }

  // Global user agents
  const globalAgentsDir = path.join(CLAUDE_DIR, 'agents');
  if (fs.existsSync(globalAgentsDir)) {
    for (const f of fs.readdirSync(globalAgentsDir).filter(f => f.endsWith('.md'))) {
      ingestAgentFile(path.join(globalAgentsDir, f), 'global', 'design');
    }
  }

  // Project-scoped agents (<project folder>/.claude/agents/), for every folder Claude Code was used in
  for (const dir of projectDirs()) {
    const projAgentsDir = path.join(dir, '.claude', 'agents');
    let files;
    try { files = fs.readdirSync(projAgentsDir).filter(f => f.endsWith('.md')); }
    catch { continue; }
    for (const f of files) ingestAgentFile(path.join(projAgentsDir, f), path.basename(dir), 'project');
  }

  const out = [...agentMap.values()].map(e => e.meta);

  // Built-in agents (shipped with Claude Code itself — known, fixed list)
  const BUILTINS = [
    { id: 'general-purpose', name: 'general-purpose', role: 'General Researcher',
      description: 'Multi-step research, complex search, open-ended tasks across the codebase.',
      tools: ['*'], model: 'inherit' },
    { id: 'Explore', name: 'Explore', role: 'Read-only Search',
      description: 'Fast read-only search agent for locating code, finding files by pattern, grepping symbols.',
      tools: ['Read', 'Grep', 'Glob', 'WebSearch'], model: 'inherit' },
    { id: 'Plan', name: 'Plan', role: 'Implementation Architect',
      description: 'Designs implementation plans, identifies critical files, weighs architectural trade-offs.',
      tools: ['Read', 'Grep', 'Glob'], model: 'inherit' },
    { id: 'claude-code-guide', name: 'claude-code-guide', role: 'CC/SDK/API Expert',
      description: 'Answers questions about Claude Code, Agent SDK, and the Anthropic API.',
      tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'], model: 'inherit' },
    { id: 'statusline-setup', name: 'statusline-setup', role: 'Status Line Configurator',
      description: 'Configures the Claude Code status line setting.',
      tools: ['Read', 'Edit'], model: 'inherit' },
  ];
  for (const b of BUILTINS) {
    const fb = PERSONA_FALLBACKS[b.id] || {};
    out.push({
      ...b,
      persona: fb.persona || null,
      role: fb.role || b.role,
      source: 'builtin',
      group: 'builtin',
    });
  }

  return out;
}

const plainDashes = t => String(t).replace(/\s*[\u2012-\u2015]\s*/g, ' - ');

export function listSkills() {
  // every skill on this machine, Claude's and Codex's in one list (the author, 2026-11-12: "show all skills");
  // `tools` says which app has it, the Skills tab shows that app's logo
  const home = os.homedir(), byId = new Map();
  const sources = [
    [path.join(CLAUDE_DIR, 'skills'), 'claude'],
    [path.join(home, '.agents', 'skills'), 'codex'],
    [path.join(home, '.codex', 'skills'), 'codex'],
    [path.join(home, '.codex', 'skills', '.system'), 'codex'],
  ];
  for (const [dir, tool] of sources) {
    let slugs = []; try { slugs = fs.readdirSync(dir); } catch { continue; }
    for (const slug of slugs) {
      if (slug.startsWith('.')) continue;
      const skillFile = path.join(dir, slug, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const have = byId.get(slug);
      if (have) { if (!have.tools.includes(tool)) have.tools.push(tool); continue; }
      try {
        const { fm } = parseFrontmatter(fs.readFileSync(skillFile, 'utf-8'));
        byId.set(slug, {
          id: slug,
          name: fm.name || slug,
          description: plainDashes(fm.description || ''),   // Codex's own skill texts use long dashes; the author's rule: never show them
          argumentHint: fm['argument-hint'] || null,
          invocable: true,
          source: 'user',
          tools: [tool],
        });
      } catch {}
    }
  }
  const out = [...byId.values()];
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
