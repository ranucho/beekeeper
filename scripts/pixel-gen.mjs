// Draws one isometric room with Google's image model (called by the Studio tab).
//   node scripts/pixel-gen.mjs room2 <name> <model> <size> "<project>" "<theme>"
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The Gemini key: the GEMINI_API_KEY variable, else the key saved from Studio (~/.beekeeper/gemini.key)
const readSafe = f => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } };
const KEY = process.env.GEMINI_API_KEY?.trim() || readSafe(path.join(os.homedir(), '.beekeeper', 'gemini.key')).trim();
if (!KEY) { console.error('No Gemini key yet: add it in the Studio tab'); process.exit(1); }
const MODEL = 'gemini-3.1-flash-image';
const SPR = path.join(ROOT, 'public', 'sprites');
const img = p => ({ inlineData: { mimeType: 'image/png', data: fs.readFileSync(p).toString('base64') } });


async function call(parts, outFile, aspect = '1:1', model = MODEL, size = null) {
  // busy servers (503) and the odd blocked answer are random: try again a few times before giving up
  for (let i = 1; ; i++) {
    try { return await call1(parts, outFile, aspect, model, size); }
    catch (e) { if (i >= 5) throw e; console.log(`  again ${i}: ${e.message.slice(0, 80)}`); await new Promise(r => setTimeout(r, 8000 * i)); }
  }
}
async function call1(parts, outFile, aspect, model, size) {
  const imageConfig = { aspectRatio: aspect }; if (size) imageConfig.imageSize = size;
  const body = { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig } };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path.basename(outFile)}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error(`${path.basename(outFile)}: no image (${JSON.stringify(json).slice(0, 200)})`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(part.inlineData.data, 'base64'));
  console.log('✓', path.relative(ROOT, outFile));
}

const [job, who, ...rest] = process.argv.slice(2);

if (job === 'room2') {
  // High-detail room: node scripts/pixel-gen.mjs room2 <variant-name> <model> <size> "<project>" "<theme>"
  // ROOM_REF (optional, set by the Studio) = the user's reference picture for what is in the room
  const [model, size, project, theme] = rest;
  const refList = (process.env.ROOM_REFS || process.env.ROOM_REF || '').split('|').filter(Boolean);   // up to 6 reference pictures
  const mimeOf = f => /\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.webp$/i.test(f) ? 'image/webp' : 'image/png';
  const refText = !refList.length ? '' : refList.length === 1
    ? " The third image is the owner's REFERENCE for what goes in the room: take its objects, colours and mood, but redraw all of it in the pixel-art style of the first two images. Never copy its own rendering style (photo, 3D, painting): the result is pixel art."
    : ` The other ${refList.length} images are the owner's REFERENCES for what goes in the room (use them together): take their objects, colours and mood, but redraw all of it in the pixel-art style of the first two images. Never copy their own rendering style (photo, 3D, painting): the result is pixel art.`;
  await call([
    img(path.join(SPR, 'refs', 'office-iso.png')), img(path.join(SPR, 'refs', 'room-mine.png')),
    ...refList.map(f => ({ inlineData: { mimeType: mimeOf(f), data: fs.readFileSync(f).toString('base64') } })),
    { text: `The first two images are STYLE references for high-quality isometric pixel art.${refText}
Draw ONE isometric room as a polished, HIGH-DETAIL 16-bit pixel art game asset, same isometric angle as the first reference (two back walls meeting at the far corner, open front, floor is a diamond, the floor slab has a visible thickness at the front edges).
Pixel-art craft rules: a strict pixel grid, the whole room about 360 pixels wide (fine pixels, lots of small detail), every object built from clean pixel clusters, 3-5 hand-picked shades per material, crisp 1-pixel highlights, NO black outlines anywhere: every outline is a darker shade of that object's own colour (selective outlining). No anti-aliasing blur, no gradients, no noise, no dithering mess. Clean 2:1 isometric stair-step lines.
The room belongs to the project "${project}". Theme: ${theme}. Rich, playful and exaggerated, but tidy and readable: decor along the two back walls and in the corners only. STRICT: no desks, no tables, no chairs, no computers, no monitors, no keyboards. The middle of the floor is open floor (characters stand there). The whole room is bright, well lit and readable: NEVER use pure black or near-black for walls, floors or any large area (a dark colour must be a deep coloured shade such as navy, plum or chocolate brown with visible detail), and the floor is a clearly lit mid-tone with a visible pattern or texture. NO dark stains: no dark blotches, no dark patches, no big dark shadow shapes on the floor or the walls, no dark corners; every wall and the whole floor stay light or mid-tone (only small objects and thin outlines may be dark).
Background outside the room: one flat pure MAGENTA (#FF00FF). NO TEXT ANYWHERE: no letters, words, names, numbers or fake writing on any sign, plaque, banner, poster, board, screen, label, box or book (a blank wall plaque is fine). Rooms are shared, so a project name on the wall would make the room useless to anyone else (the author, 2026-11-12). No frame, no shadow under the room.` },
  ], path.join(SPR, 'rooms', `${who}.png`), '1:1', model, size);
}
