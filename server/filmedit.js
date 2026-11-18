// Film editor for Remotion films played through the VideoHub Remotion bridge (<workspace>/templates/remotion-bridge).
// The film folder's remotion-bridge.json names its Remotion project; the user's edits (blocks moved / trimmed, texts
// retyped, elements nudged, sound levels, replaced SFX, removed pieces of the clip) live in that project's
// src/vh-edits.json, which the film reads through src/vh-edit.tsx, so Remotion Studio and renders use them too.
// The hub is the one writer; Claude may edit the file by hand (an open editor then reloads it, SSE 'film-edits').
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { project } from './scan.js';
import { isInside } from './util.js';
import { writeTweaks } from './tweaks.js';

export const NOTE = 'VideoHub film editor: overrides over the film\'s own values (src/vh-edit.tsx). items: element id → {ds, de: seconds added to the coded start/end; text, text2; dx, dy: px; k: size ×; gain: volume ×; duck: music dB under the voice; off: hidden/muted; file/fdur/fname: replacement sound; base: the coded values when it was changed}. cuts: removed pieces [a, b] in seconds of the uncut film. Keep the element ids stable when changing the code.';
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// ---------------------------------------------------------------- the film's Remotion project
export function bridgeOf(p) {
  if (!p || p.studio || p.group) return null;
  let j; try { j = JSON.parse(fs.readFileSync(path.join(p.path, 'remotion-bridge.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
  if (!j || typeof j.project !== 'string') return null;
  const proj = path.resolve(j.project), rel = typeof j.editsFile === 'string' && !j.editsFile.includes('..') ? j.editsFile : 'src/vh-edits.json';
  const editsFile = path.join(proj, rel);
  if (!isInside(editsFile, proj)) return null;
  return {
    project: proj, composition: j.composition || null, editsFile, editsRel: rel,
    publicDir: typeof j.publicDir === 'string' ? path.resolve(j.publicDir) : path.join(proj, 'public'),
    mirror: path.join(p.path, 'node_modules', 'remotion-public'),
    helper: fs.existsSync(path.join(proj, 'src', 'vh-edit.tsx')), edit: !!j.edit,
  };
}

// ---------------------------------------------------------------- the document
export function cleanOv(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const k of ['ds', 'de']) if (fin(o[k]) && Math.abs(o[k]) > 1e-4) out[k] = r4(clamp(o[k], -3600, 3600));
  for (const k of ['text', 'text2']) if (typeof o[k] === 'string') out[k] = o[k].slice(0, 2000);
  for (const k of ['dx', 'dy']) if (fin(o[k]) && Math.abs(o[k]) >= 0.05) out[k] = Math.round(clamp(o[k], -8000, 8000) * 10) / 10;
  if (fin(o.k) && Math.abs(o.k - 1) > 1e-3) { out.k = r4(clamp(o.k, 0.05, 20)); for (const k of ['ox', 'oy']) if (fin(o[k])) out[k] = Math.round(clamp(o[k], -8000, 8000)); }
  if (fin(o.gain) && Math.abs(o.gain - 1) > 1e-4) out.gain = r4(clamp(o.gain, 0, 16));
  if (fin(o.duck)) out.duck = Math.round(clamp(o.duck, -60, 0) * 100) / 100;
  if (o.off === true) out.off = true;
  if (typeof o.file === 'string' && /^[\w\-./ ()]+$/.test(o.file) && !o.file.split('/').includes('..') && !o.file.startsWith('/')) {
    out.file = o.file;
    if (fin(o.fdur)) out.fdur = r4(clamp(o.fdur, 0.01, 3600));
    if (typeof o.fname === 'string') out.fname = o.fname.slice(0, 200);
  }
  const keys = Object.keys(out);
  if (!keys.length) return null;
  if (o.base && typeof o.base === 'object') {
    const b = {};
    for (const k of ['s', 'e']) if (fin(o.base[k])) b[k] = r4(o.base[k]);
    for (const k of ['text', 'text2', 'label']) if (typeof o.base[k] === 'string') b[k] = o.base[k].slice(0, 2000);
    if (Object.keys(b).length) out.base = b;
  }
  return out;
}
export function cleanCuts(arr) {
  const cs = (Array.isArray(arr) ? arr : []).filter((c) => c && fin(c.a) && fin(c.b) && c.b - c.a >= 0.01 && c.b > 0)
    .map((c) => ({ a: r4(Math.max(0, c.a)), b: r4(c.b) })).sort((p, q) => p.a - q.a);
  const out = [];
  for (const c of cs) { const l = out[out.length - 1]; if (l && c.a <= l.b + 1e-4) l.b = Math.max(l.b, c.b); else out.push({ ...c }); }
  return out.slice(0, 1000);
}
export const cleanSplits = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter((t) => fin(t) && t > 0).map(r4))].sort((a, b) => a - b).slice(0, 1000);
export function normDoc(x) {
  const o = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  const items = {};
  if (o.items && typeof o.items === 'object' && !Array.isArray(o.items)) for (const [id, ov] of Object.entries(o.items)) { const c = cleanOv(ov); if (c && id.length <= 300) items[id] = c; }
  return { ...o, v: 1, note: NOTE, items, cuts: cleanCuts(o.cuts), splits: cleanSplits(o.splits) };
}
/** patch = { items: { id: override | null }, cuts?: [...], splits?: [...] }: a given id's override is replaced whole */
export function applyPatch(doc, patch) {
  const d = normDoc(doc), b = patch && typeof patch === 'object' ? patch : {};
  if (b.items && typeof b.items === 'object' && !Array.isArray(b.items)) {
    for (const [id, ov] of Object.entries(b.items)) {
      if (typeof id !== 'string' || !id || id.length > 300) continue;
      const c = ov === null ? null : cleanOv(ov);
      if (c) d.items[id] = c; else delete d.items[id];
    }
  }
  if ('cuts' in b) d.cuts = cleanCuts(b.cuts);
  if ('splits' in b) d.splits = cleanSplits(b.splits);
  return d;
}
const revOf = (txt) => crypto.createHash('sha1').update(txt || '').digest('hex').slice(0, 12);
export function readDoc(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!txt.trim()) return { doc: normDoc({}), rev: revOf(txt), exists: !!txt };
  try { return { doc: normDoc(JSON.parse(txt.replace(/^﻿/, ''))), rev: revOf(txt), exists: true }; }
  catch { throw Object.assign(new Error('Could not read ' + path.basename(file) + ' (broken JSON); fix it by hand first'), { code: 409 }); }
}
function writeDoc(file, doc) {
  const out = { v: 1, note: NOTE, items: doc.items, cuts: doc.cuts, splits: doc.splits };
  writeTweaks(file, out);   // tmp + rename, Windows-safe
  return revOf(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------- the SFX library (the global-video-styles skill's sounds)
// library/index.json (title, category, dur, file) + bank/ (the brand sounds); never the « glass » sounds
const SFX_ROOT = () => process.env.VIDEOHUB_SFX_LIBRARY || path.join(os.homedir(), '.claude', 'skills', 'global-video-styles', 'sfx');
const AUDIO_RE = /\.(wav|mp3|m4a|ogg|flac|aac)$/i;
let libCache = null;
function libList() {
  const root = SFX_ROOT();
  if (libCache && libCache.root === root) return libCache.list;
  const list = [];
  const banned = (s) => /glass/i.test(s || '');
  try {
    const bank = JSON.parse(fs.readFileSync(path.join(root, 'bank', 'bank.json'), 'utf8'));
    for (const [name, x] of Object.entries(bank)) {
      const f = path.join(root, 'bank', x.file || name + '.wav');
      if (!banned(name) && !banned(x.title) && fs.existsSync(f)) list.push({ id: 'bank/' + (x.file || name + '.wav'), title: name.replace(/_/g, ' '), cat: 'brand', dur: null, use: x.use || '' });
    }
  } catch { }
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(root, 'library', 'index.json'), 'utf8'));
    for (const x of Object.values(idx)) {
      if (!x || typeof x.file !== 'string' || !AUDIO_RE.test(x.file)) continue;
      if (banned(x.file) || banned(x.title) || (x.tags || []).some(banned)) continue;
      list.push({ id: 'library/' + x.file, title: x.title || path.basename(x.file), cat: x.category || 'other', dur: fin(x.dur) ? x.dur : null, src: x.source || '' });
    }
  } catch { }
  libCache = { root, list };
  return list;
}
function libFile(id) {
  const root = SFX_ROOT(), f = path.resolve(root, String(id || ''));
  if (!AUDIO_RE.test(f) || !isInside(f, root) || /glass/i.test(path.basename(f)) || !fs.existsSync(f)) throw Object.assign(new Error('Sound not found in the library'), { code: 404 });
  return f;
}
// the length of a WAV from its header (enough for the library's WAVs), else ffprobe-free estimate: null
function wavDur(f) {
  try {
    const fd = fs.openSync(f, 'r'), b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
    let o = 12, rate = 0, block = 0;
    while (o + 8 <= n) {
      const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4);
      if (id === 'fmt ') { rate = b.readUInt32LE(o + 12); block = b.readUInt16LE(o + 20); }
      if (id === 'data' && rate && block) return r4(Math.min(sz, fs.statSync(f).size - o - 8) / (rate * block));
      o += 8 + sz + (sz & 1);
    }
  } catch { }
  return null;
}
/** a library sound into the film: copied into the Remotion project's public/vh-sfx/ (renders) and hard-linked into the
 *  film's public mirror (the open preview); returns its public path and length */
function importSfx(p, br, id) {
  const src = libFile(id), base = path.basename(src).replace(/[^\w\-.]+/g, '_');
  const rel = 'vh-sfx/' + base, dst = path.join(br.publicDir, 'vh-sfx', base);
  if (!isInside(dst, br.publicDir)) throw Object.assign(new Error('bad sound name'), { code: 400 });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
  const m = path.join(br.mirror, 'vh-sfx', base);
  if (fs.existsSync(br.mirror) && !fs.existsSync(m)) { fs.mkdirSync(path.dirname(m), { recursive: true }); try { fs.linkSync(dst, m); } catch { fs.copyFileSync(dst, m); } }
  return { file: rel, dur: wavDur(dst), mirrorPath: fs.existsSync(m) ? m : null };
}

// ---------------------------------------------------------------- watching the file (Claude's hand edits → open editors)
const watched = new Map();   // project id → { file, rev }
function watchDoc(p, br, broadcast) {
  const w = watched.get(p.id);
  if (w && w.file === br.editsFile) return w;
  if (w) fs.unwatchFile(w.file);
  const rec = { file: br.editsFile, rev: null };
  watched.set(p.id, rec);
  fs.watchFile(br.editsFile, { interval: 1000 }, () => {
    let rev = null; try { rev = readDoc(br.editsFile).rev; } catch { return; }
    if (rev !== rec.rev) { rec.rev = rev; broadcast('film-edits', { project: p.id, rev }); }
  });
  return rec;
}

export function routes(route, readBody, broadcast = () => { }) {
  const need = (id) => {
    const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
    const br = bridgeOf(p); if (!br) throw Object.assign(new Error('This film is not a Remotion bridge film (no remotion-bridge.json)'), { code: 404 });
    return { p, br };
  };
  route('GET', '/api/project/:id/film-edits', (req, url, { id }) => {
    const { p, br } = need(id), r = readDoc(br.editsFile), w = watchDoc(p, br, broadcast);
    w.rev = r.rev;
    return { ok: true, ...r, file: br.editsFile, rel: br.editsRel, helper: br.helper, edit: br.edit, composition: br.composition, mirror: br.mirror };
  });
  // { patch, rev? }: applied on the file as it is now (an element's override is replaced whole); rev = the version the
  // change was made on: a different file (Claude edited it meanwhile) still takes the patch, and says so (outside: true)
  route('PATCH', '/api/project/:id/film-edits', async (req, url, { id }) => {
    const { p, br } = need(id), b = await readBody(req);
    if (!b || typeof b.patch !== 'object' || !b.patch) throw Object.assign(new Error('missing patch'), { code: 400 });
    if (!fs.existsSync(path.dirname(br.editsFile))) throw Object.assign(new Error('The Remotion project has no ' + path.dirname(br.editsRel) + ' folder'), { code: 409 });
    const cur = readDoc(br.editsFile), doc = applyPatch(cur.doc, b.patch), w = watchDoc(p, br, broadcast);
    const rev = writeDoc(br.editsFile, doc); w.rev = readDoc(br.editsFile).rev;
    return { ok: true, doc, rev: w.rev || rev, outside: !!(b.rev && b.rev !== cur.rev) };
  });
  route('GET', '/api/sfx-library', (req, url) => {
    const q = (url.searchParams.get('q') || '').toLocaleLowerCase('en-US').trim(), cat = url.searchParams.get('cat') || '';
    const all = libList(), cats = {};
    for (const x of all) cats[x.cat] = (cats[x.cat] || 0) + 1;
    const words = q.split(/\s+/).filter(Boolean);
    const hits = all.filter((x) => (!cat || x.cat === cat) && words.every((w) => (x.title + ' ' + x.cat + ' ' + x.id).toLocaleLowerCase('en-US').includes(w)));
    return { ok: true, root: SFX_ROOT(), total: all.length, cats, items: hits.slice(0, 400), more: Math.max(0, hits.length - 400) };
  });
  route('GET', '/api/sfx-library/play', (req, url, _, res) => {
    let f; try { f = libFile(url.searchParams.get('f')); } catch { res.writeHead(404); return res.end(); }
    const type = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac' }[path.extname(f).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'no-store' });
    fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
  });
  route('POST', '/api/project/:id/film-sfx', async (req, url, { id }) => {
    const { p, br } = need(id), b = await readBody(req);
    return { ok: true, ...importSfx(p, br, b.id) };
  });
}
