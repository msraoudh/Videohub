// Film editor for Remotion films (VideoHub Remotion bridge + the film's src/vh-edit.tsx, window.__VH_EDIT on the page).
// The user edits the film while watching it: every element of the film is a block on its own lane of the timeline
// (scenes, captions, chrome words, texts, graphics, SFX, music, the voice-and-face clip). Drag a block to move it, its
// edges to trim it; click a text on the picture to select it, drag it to move it, its corner to resize it, double-click
// it to retype it; set SFX volumes, mute or replace them from the library; set the music level and how far it ducks
// under the voice; split the clip and remove pieces (pauses close to ≤ 0.15 s). Every change is saved at once in the
// film's src/vh-edits.json (the film reads it, so renders use it) and the open preview redraws without a reload.
// Undo / redo go through the review page's router (tag 'film').
import { h, api, toast, confirmBox, onHubEvent } from '../app.js';

const KIND_COLOR = { scene: '#3d5a8c', caption: '#3d6fae', text: '#7b5fc4', graphic: '#2c8a7e', sfx: '#a2753a', music: '#3f6fc0', clip: '#3c8a57' };
const KIND_ORDER = { scene: 0, clip: 1, caption: 2, text: 3, graphic: 4, sfx: 5, music: 6 };
const ICON = { scene: '🎬', caption: '💬', text: '🔤', graphic: '🏷', sfx: '🔊', music: '🎵', clip: '🎙' };
const GAP = 0.15;            // the longest pause kept between two voice lines (his rule: no gap over 0.15 s)
const SUBH = 15, MAXSUB = 6, EDGE = 6, SNAP = 8;
const fmt = (s) => { s = Math.max(0, +s || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
const toDb = (g) => (g <= 0.0005 ? -60 : 20 * Math.log10(g));
const fromDb = (d) => (d <= -59.5 ? 0 : 10 ** (d / 20));
const clone = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const dbTxt = (d) => (d <= -59.5 ? 'muted' : (d > 0.05 ? '+' : '') + d.toFixed(1) + ' dB');

// the removed pieces as a time map: output (what plays) ↔ source (the uncut film), frame-rounded like vh-edit.tsx
export function cutMap(cuts, fps) {
  const F = fps || 30;
  const cs = (cuts || []).map((c) => ({ a: Math.round(c.a * F) / F, b: Math.round(c.b * F) / F })).filter((c) => c.b > c.a).sort((p, q) => p.a - q.a);
  const m = [];
  for (const c of cs) { const l = m[m.length - 1]; if (l && c.a <= l.b) l.b = Math.max(l.b, c.b); else m.push({ ...c }); }
  const out = (t) => { let sh = 0; for (const c of m) { if (t >= c.b) sh += c.b - c.a; else if (t > c.a) return c.a - sh; else break; } return t - sh; };
  const src = (t) => { let sh = 0; for (const c of m) { if (t + sh >= c.a - 1e-9) sh += c.b - c.a; else break; } return t + sh; };
  return { cuts: m, out, src, removed: m.reduce((n, c) => n + c.b - c.a, 0) };
}
// a patch that turns doc a into doc b (only what differs)
export function diffDoc(a, b) {
  const p = {}, items = {};
  for (const id of new Set([...Object.keys(a.items || {}), ...Object.keys(b.items || {})])) if (!same(a.items?.[id], b.items?.[id])) items[id] = b.items?.[id] ?? null;
  if (Object.keys(items).length) p.items = items;
  if (!same(a.cuts || [], b.cuts || [])) p.cuts = b.cuts || [];
  if (!same(a.splits || [], b.splits || [])) p.splits = b.splits || [];
  return p;
}
export function patchDoc(d, p) {
  const n = clone(d);
  if (p.items) for (const [id, ov] of Object.entries(p.items)) { if (ov) n.items[id] = ov; else delete n.items[id]; }
  if (p.cuts) n.cuts = p.cuts;
  if (p.splits) n.splits = p.splits;
  return n;
}
const emptyPatch = (p) => !p.items && !p.cuts && !p.splits;
// an override without its no-op fields (the server cleans the same way)
function tidy(o, it) {
  const n = { ...o };
  for (const k of ['ds', 'de']) if (!(Math.abs(n[k] || 0) > 1e-4)) delete n[k];
  for (const k of ['dx', 'dy']) if (!(Math.abs(n[k] || 0) >= 0.05)) delete n[k];
  if (n.k == null || Math.abs(n.k - 1) <= 1e-3) { delete n.k; delete n.ox; delete n.oy; }
  if (n.gain == null || Math.abs(n.gain - 1) <= 1e-4) delete n.gain;
  if (n.text != null && n.text === it.text0) delete n.text;
  if (n.text2 != null && n.text2 === it.text20) delete n.text2;
  if (n.duck != null && it.duck0 != null && Math.abs(n.duck - it.duck0) < 0.01) delete n.duck;
  if (!n.off) delete n.off;
  if (!n.file || n.file === it.file0) { delete n.file; delete n.fdur; delete n.fname; }
  delete n.base;
  if (!Object.keys(n).length) return null;
  n.base = { s: r4(it.s0), e: r4(it.e0), ...(it.text0 != null ? { text: it.text0 } : {}), ...(it.text20 != null ? { text2: it.text20 } : {}), ...(it.label ? { label: it.label } : {}) };
  return n;
}

export function createFilmEditor({ src, projectId, frame, panelHost, onOpen, onClose, history, keysActive, timeline, fps, seek, pause, range, clearRange, time, reloadLive }) {
  const btn = h('button', { class: 'fe-btn', hidden: true, title: 'Edit the film right here: move / trim blocks on the timeline, click a text on the picture to move, resize or retype it, sound levels, replace SFX, cut pieces of the clip. Saved in the film (vh-edits.json); renders use it.', onclick: () => (open ? close() : start()) }, '🎬 Edit film');
  let E = null, open = false, man = null, items = new Map(), lanes = [], doc = { v: 1, items: {}, cuts: [], splits: [] }, rev = null;
  let sel = null;            // { type: 'item', vid } | { type: 'piece', a, b } (output s) | { type: 'cut', i }
  let undoS = [], redoS = [], pending = 0, saveChain = Promise.resolve(), mine = false, autoClose = true;
  let drag = null;           // a timeline gesture
  let pic = null;            // a picture gesture (move / resize)
  const F = () => fps() || 30;
  const M = () => cutMap(doc.cuts, F());
  const page = () => { try { return src.win || null; } catch { return null; } };

  // ---------------------------------------------------------------- the page
  const edit = () => { try { return src.win?.__VH_EDIT || null; } catch { return null; } };
  function check() {
    const e = edit(); btn.hidden = !e;
    if (open && !e) { close(true); return; }
    E = e;
    if (open) { refresh(); }
  }
  // show the doc in the open preview at once (the bridge redraws the frame); new cuts change the film's length: reload
  // quiet = a preview while a slider / drag / text box runs: the panel is not rebuilt under the pointer
  function live(d, quiet) {
    const B = page()?.VH_BRIDGE;
    let r = null; try { r = B?.setEdits ? B.setEdits(d) : (E?.set(d) || null); } catch (e) { console.warn('film editor:', e); }
    if (r?.cutsChanged) reloadAt();
    refresh(quiet);
  }
  // a different length: reload the page, then come back to the same moment of the uncut film
  let reloadSrcT = null;
  function reloadAt() { reloadSrcT = prevMap ? prevMap.src(time()) : null; reloadLive(); }
  let prevMap = null;
  function refresh(quiet) {
    prevMap = M();
    try { man = E ? E.manifest() : null; } catch (e) { man = null; console.warn('film editor manifest:', e); }
    items = new Map((man?.items || []).map((it) => [it.vid, it]));
    if (sel?.type === 'item' && !items.has(sel.vid)) sel = null;
    const before = lanes.map((l) => l.id + ':' + l.h).join('|');
    lanes = layoutLanes();
    if (open) { if (before !== lanes.map((l) => l.id + ':' + l.h).join('|')) timeline.extChanged(); else timeline.draw(); if (!quiet) paint(); boxes(true); }
  }

  // ---------------------------------------------------------------- lanes (output time)
  function layoutLanes() {
    if (!man) return [];
    const m = M(), out = [];
    for (const L of man.lanes) {
      const its = man.items.filter((i) => i.lane === L.name).map((it) => ({ it, a: m.out(it.s), b: m.out(it.e), row: 0 })).filter((x) => x.b - x.a > 1e-4 || x.it.s >= x.it.e);
      const ends = [];
      for (const x of its.slice().sort((p, q) => p.a - q.a)) {
        let r = ends.findIndex((e) => e <= x.a + 1e-6);
        if (r < 0) { if (ends.length < MAXSUB) { r = ends.length; ends.push(0); } else r = ends.indexOf(Math.min(...ends)); }
        ends[r] = Math.max(ends[r], x.b); x.row = r;
      }
      const n = Math.max(1, ends.length);
      out.push({ id: 'fe:' + L.name, name: L.name, kind: L.kind, its, n, h: Math.max(22, n * SUBH + 4) });
    }
    if (man.clip) out.push({ id: 'fe:clip', name: man.clip.lane, kind: 'clip', clip: true, its: [], n: 1, h: 32 });
    return out.sort((p, q) => (KIND_ORDER[p.kind] ?? 9) - (KIND_ORDER[q.kind] ?? 9));
  }
  const laneOf = (r) => lanes.find((l) => l.id === r.id) || null;
  function boxOf(l, x, r, T) {
    const sh = (r.h - 4) / l.n, top = r.y + 2 + x.row * sh;
    const g = drag && drag.moved && drag.vid === x.it.vid ? drag.ghost : null;
    const a = g ? g.a : x.a, b = g ? g.b : x.b;
    return { x0: T.tx(a), x1: Math.max(T.tx(a) + 3, T.tx(b)), top, bh: Math.max(4, sh - 2) };
  }
  function itemAt(l, x, y, r, T) {
    for (let i = l.its.length - 1; i >= 0; i--) {
      const it = l.its[i], B = boxOf(l, it, r, T);
      if (y >= B.top && y <= B.top + B.bh && x >= B.x0 - 3 && x <= B.x1 + 3) return { x: it, B };
    }
    return null;
  }
  const speech = () => man?.clip?.speech || [];
  // pieces of the clip (output time) between splits and cut joins
  function pieces() {
    const m = M(), d = timelineDur(), pts = new Set([0, d]);
    for (const c of m.cuts) pts.add(r4(m.out(c.a)));
    for (const s of doc.splits || []) { const o = m.out(s); if (Math.abs(m.src(o) - s) < 1e-3) pts.add(r4(o)); }
    const P = [...pts].filter((t) => t >= 0 && t <= d).sort((a, b) => a - b), out = [];
    for (let i = 0; i < P.length - 1; i++) if (P[i + 1] - P[i] > 1e-3) out.push({ a: P[i], b: P[i + 1] });
    return out;
  }
  const timelineDur = () => src.duration || 1;
  function cutMarks(T) { const m = M(); return m.cuts.map((c, i) => ({ i, c, x: T.tx(m.out(c.a)) })); }

  const provider = {
    rows: () => lanes.map((l) => ({ id: l.id, label: `${ICON[l.kind] || '•'} ${l.name}`, h: l.h, color: KIND_COLOR[l.kind] || '#888', side: l.clip ? clipSide : null })),
    draw(g, r, T) {
      const l = laneOf(r); if (!l) return;
      const w = T.W();
      g.fillStyle = l.clip ? '#101a14' : '#121318'; g.fillRect(0, r.y, w, r.h);
      if (r.collapsed) return;
      if (l.clip) return drawClip(g, r, T);
      g.font = '600 9.5px Segoe UI'; g.textBaseline = 'middle';
      for (const x of l.its) {
        const B = boxOf(l, x, r, T); if (B.x1 < 0 || B.x0 > w) continue;
        const it = x.it, isSel = sel?.type === 'item' && sel.vid === it.vid, bw = B.x1 - B.x0;
        g.globalAlpha = it.off ? 0.28 : it.locked ? 0.6 : 1;
        g.fillStyle = KIND_COLOR[it.kind] || '#666'; g.beginPath(); g.roundRect(B.x0, B.top, bw, B.bh, 3); g.fill();
        if (it.off) { g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1; g.beginPath(); g.moveTo(B.x0, B.top + B.bh / 2); g.lineTo(B.x1, B.top + B.bh / 2); g.stroke(); }
        g.globalAlpha = 1;
        if (it.edited) { g.fillStyle = '#ffd83d'; g.beginPath(); g.arc(B.x1 - 4, B.top + 4, 2.5, 0, Math.PI * 2); g.fill(); }
        if (isSel) { g.strokeStyle = '#25d0c2'; g.lineWidth = 2; g.beginPath(); g.roundRect(B.x0 + 1, B.top + 1, Math.max(2, bw - 2), B.bh - 2, 3); g.stroke(); }
        if (bw > 16 && B.bh >= 9) {
          const gainTxt = it.kind === 'sfx' && Math.abs(toDb(it.gain)) > 0.05 ? ' ' + dbTxt(toDb(it.gain)) : '';
          const txt = (it.kind === 'sfx' || it.kind === 'music' ? (it.fname || it.label || '') : (it.text ?? it.label ?? it.vid)) + gainTxt;
          g.save(); g.beginPath(); g.rect(B.x0, B.top, bw - 2, B.bh); g.clip(); g.fillStyle = '#f1f3f7'; g.fillText(txt, Math.max(B.x0, 0) + 3, B.top + B.bh / 2 + 0.5); g.restore();
        }
      }
      if (drag?.moved && drag.guide != null) { g.fillStyle = '#25d0c2'; g.fillRect(Math.round(T.tx(drag.guide)), r.y, 1, r.h); }
    },
    down(e, x, y, r, T) {
      mine = true;
      const l = laneOf(r); if (!l) return false;
      if (l.clip) return clipDown(x, y, r, T);
      const hit = itemAt(l, x, y, r, T);
      if (!hit) { if (sel) { sel = null; paint(); boxes(true); } return false; }
      const it = hit.x.it, bw = hit.B.x1 - hit.B.x0;
      select({ type: 'item', vid: it.vid });
      const part = it.locked ? 'none' : !it.fixedLen && bw >= 3 * EDGE && x <= hit.B.x0 + EDGE ? 'trimL' : !it.fixedLen && bw >= 3 * EDGE && x >= hit.B.x1 - EDGE ? 'trimR' : 'body';
      drag = { vid: it.vid, part, x0: x, tPress: T.xt(x), a: hit.x.a, b: hit.x.b, it, moved: false, ghost: null, guide: null, playT: T.time() };
      return true;
    },
    move(e, x, y, T) {
      const D = drag; if (!D || D.part === 'none') return;
      if (!D.moved && Math.abs(x - D.x0) < 4) return;
      if (!D.moved) T.pause();
      D.moved = true;
      const dt = T.xt(x) - D.tPress, len = D.b - D.a, cands = e.shiftKey ? [] : snapCands(D.vid, T);
      let a = D.a, b = D.b, guide = null;
      const snapT = (t) => { let best = null; for (const c of cands) { const d = Math.abs(T.tx(c) - T.tx(t)); if (d <= SNAP && (!best || d < best.d)) best = { c, d }; } return best ? best.c : null; };
      if (D.part === 'body') {
        a = Math.max(0, D.a + dt); b = a + len;
        const sa = snapT(a), sb = snapT(b);
        if (sa != null && (sb == null || Math.abs(sa - a) <= Math.abs(sb - b))) { a = sa; b = a + len; guide = sa; } else if (sb != null) { b = sb; a = b - len; guide = sb; }
      } else if (D.part === 'trimL') { a = Math.min(D.b - 1 / F(), Math.max(0, D.a + dt)); const s = snapT(a); if (s != null && s < D.b) { a = s; guide = s; } }
      else { b = Math.max(D.a + 1 / F(), D.b + dt); const s = snapT(b); if (s != null && s > D.a) { b = s; guide = s; } }
      D.ghost = { a, b }; D.guide = guide;
      D.info = `${D.it.label || D.it.text || D.it.vid} · ${fmt(a)} → ${fmt(b)} · ${(a - D.a >= 0 ? '+' : '−') + Math.abs(a - D.a).toFixed(2)} s${e.shiftKey ? '' : ' · Shift: no snapping'}`;
    },
    up(e, T, cancelled) {
      const D = drag; drag = null; if (!D) return;
      if (cancelled || !D.moved || !D.ghost) {
        if (!cancelled && !D.moved) { const t = T.time(); if (t < D.a - 1e-3 || t > D.b) seek(D.a + Math.min(0.25, (D.b - D.a) / 3)); }
        return;
      }
      const m = M(), it = D.it, o = doc.items[it.vid] || {};
      const s1 = D.part === 'trimR' ? it.s : m.src(D.ghost.a), e1 = D.part === 'trimL' ? it.e : D.part === 'body' ? s1 + (it.e - it.s) : m.src(D.ghost.b - 1e-6) + 1e-6;
      setItem(it, { ...o, ds: s1 - it.s0, ...(it.fixedLen ? {} : { de: e1 - it.e0 }) }, 'Move');
    },
    hover(x, y, r, T) {
      const l = laneOf(r); if (!l || r.collapsed) return null;
      if (l.clip) return cutMarks(T).some((c) => Math.abs(c.x - x) <= 5) ? 'pointer' : 'pointer';
      const hit = itemAt(l, x, y, r, T); if (!hit) return null;
      const it = hit.x.it, bw = hit.B.x1 - hit.B.x0;
      if (it.locked) return 'pointer';
      if (!it.fixedLen && bw >= 3 * EDGE && (x <= hit.B.x0 + EDGE || x >= hit.B.x1 - EDGE)) return 'ew-resize';
      return 'grab';
    },
    tip(x, y, r, T) {
      if (drag?.moved) return drag.info || '';
      const l = r && laneOf(r); if (!l) return null;
      if (l.clip) {
        const c = cutMarks(T).find((k) => Math.abs(k.x - x) <= 5);
        if (c) return `✂ removed ${(c.c.b - c.c.a).toFixed(2)} s here · click: select · Delete: put it back`;
        const t = T.xt(x), w = speech().find(([s, e]) => { const m = M(); return t >= m.out(s) && t <= m.out(e); });
        return `${l.name}${w ? ' · «' + w[2] + '»' : ''} · click: select a piece · S: split at the playhead · Delete: remove the piece`;
      }
      const hit = itemAt(l, x, y, r, T); if (!hit) return `${l.name} · ${fmt(T.xt(x))}`;
      const it = hit.x.it;
      return `${it.label || it.text || it.vid} · ${fmt(hit.x.a)} → ${fmt(hit.x.b)}${it.kind === 'sfx' || it.kind === 'music' ? ' · volume ' + dbTxt(toDb(it.gain)) : ''}${it.locked ? ' · locked (built on these times)' : ' · drag: move' + (it.fixedLen ? '' : ' · edges: trim')}${it.edited ? ' · edited' : ''}`;
    },
    dbl(x, y, r, T) { const l = laneOf(r); if (!l || l.clip) return; const hit = itemAt(l, x, y, r, T); if (hit) seek(hit.x.a + 0.001); },
  };
  function snapCands(vid, T) {
    const m = M(), c = [drag ? drag.playT : T.time(), 0];
    for (const l of lanes) for (const x of l.its) if (x.it.vid !== vid) c.push(x.a, x.b);
    const [v0, v1] = T.view();
    for (const [s, e] of speech()) { const a = m.out(s), b = m.out(e); if (b >= v0 && a <= v1) c.push(a, b); }
    return c;
  }

  // ---------------------------------------------------------------- the clip lane: words, pieces, cuts, splits
  function drawClip(g, r, T) {
    const w = T.W(), m = M(), y0 = r.y + 3, hh = r.h - 6, [v0, v1] = T.view();
    // selected piece
    if (sel?.type === 'piece') { g.fillStyle = 'rgba(37,208,194,.22)'; g.fillRect(T.tx(sel.a), r.y, T.tx(sel.b) - T.tx(sel.a), r.h); }
    // words
    g.font = '9px Segoe UI'; g.textBaseline = 'middle';
    for (const [s, e, t] of speech()) {
      const a = m.out(s), b = m.out(e); if (b < v0 || a > v1 || b - a < 1e-4) continue;
      const x0 = T.tx(a), x1 = T.tx(b);
      g.fillStyle = 'rgba(120,220,150,.32)'; g.fillRect(x0, y0 + 4, Math.max(1, x1 - x0 - 1), hh - 8);
      if (x1 - x0 > 18) { g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0 - 1, hh); g.clip(); g.fillStyle = '#d8f5e0'; g.fillText(t, x0 + 2, y0 + hh / 2); g.restore(); }
    }
    // splits
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.setLineDash([3, 2]); g.lineWidth = 1;
    for (const s of doc.splits || []) { const o = m.out(s); if (Math.abs(m.src(o) - s) > 1e-3) continue; const x = Math.round(T.tx(o)) + 0.5; g.beginPath(); g.moveTo(x, r.y); g.lineTo(x, r.y + r.h); g.stroke(); }
    g.setLineDash([]);
    // cut joins: red marker with a scissors tab
    for (const k of cutMarks(T)) {
      if (k.x < -8 || k.x > w + 8) continue;
      const on = sel?.type === 'cut' && sel.i === k.i;
      g.fillStyle = on ? '#ff8a80' : '#e5484d'; g.fillRect(k.x - 1, r.y, 2, r.h);
      g.beginPath(); g.moveTo(k.x - 6, r.y); g.lineTo(k.x + 6, r.y); g.lineTo(k.x, r.y + 7); g.closePath(); g.fill();
      if (on) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(k.x - 4, r.y + 1, 8, r.h - 2); }
    }
  }
  function clipDown(x, y, r, T) {
    const c = cutMarks(T).find((k) => Math.abs(k.x - x) <= 5);
    if (c) { select({ type: 'cut', i: c.i }); return true; }
    const t = T.xt(x), p = pieces().find((q) => t >= q.a && t < q.b);
    if (p) { select({ type: 'piece', a: p.a, b: p.b }); return true; }
    return false;
  }
  // the clip lane's own buttons (always in view): split at the playhead, remove the I→O range
  const clipSide = h('span', { class: 'fe-lanebtns' },
    h('button', { class: 'tl2-hadd', title: 'Split the clip at the playhead (S); click a piece, Delete removes it', onclick: () => splitHere() }, '✂'),
    h('button', { class: 'tl2-hadd fe-cutbtn', title: 'Remove the range set with I and O (ruler) from the clip; the pause around the join closes to ' + GAP + ' s', onclick: () => removeRange() }, '⌫ I→O'));

  // ---------------------------------------------------------------- selection
  function select(s) { sel = s; libPop = null; paint(); boxes(true); timeline.draw(); }

  // ---------------------------------------------------------------- changes (commit = undo step + live + save)
  function commit(next, label) {
    const after = diffDoc(doc, next), before = diffDoc(next, doc);
    if (emptyPatch(after)) return false;
    undoS.push({ before, after, label }); if (undoS.length > 300) undoS.shift(); redoS = [];
    history?.push();
    doc = next; live(doc); persist(after);
    return true;
  }
  function setItem(it, ov, label) {
    const n = clone(doc), t = tidy(ov, it);
    if (t) n.items[it.vid] = t; else delete n.items[it.vid];
    return commit(n, label);
  }
  // a preview of a change while a slider / drag runs (not saved, no undo step)
  function preview(it, ov) { const n = clone(doc), t = tidy(ov, it); if (t) n.items[it.vid] = t; else delete n.items[it.vid]; live(n, true); }
  function persist(patch) {
    pending++; status();
    saveChain = saveChain.then(() => api(`/api/project/${projectId}/film-edits`, { method: 'PATCH', body: { patch, rev } }).then((r) => {
      rev = r.rev;
      if (r.outside) toast('The edits file had been changed outside VideoHub (Claude?); your change was added to it.');
    }).catch((e) => toast('Could not save the edit: ' + e.message, true)).finally(() => { pending--; status(); }));
    return saveChain;
  }
  function undo() {
    const s = undoS.pop(); if (!s) return false;
    redoS.push(s); doc = patchDoc(doc, s.before); live(doc); persist(s.before); toast('Undone: ' + (s.label || 'edit')); return true;
  }
  function redo() {
    const s = redoS.pop(); if (!s) return false;
    undoS.push(s); doc = patchDoc(doc, s.after); live(doc); persist(s.after); toast('Redone: ' + (s.label || 'edit')); return true;
  }

  // ---------------------------------------------------------------- the clip: split, remove, put back, close pauses
  function snapSilence(t) {   // an edge inside a word moves to that word's edge when it is close (≤ 0.08 s)
    for (const [s, e] of speech()) if (t > s && t < e) return t - s <= 0.08 ? s : e - t <= 0.08 ? e : t;
    return t;
  }
  // a new removed piece [a, b] (source s); with « close the pause » the silence left around the join is cut to ≤ GAP
  function removeSrc(a, b, label) {
    a = snapSilence(a); b = snapSilence(b);
    if (b - a < 1 / F()) return;
    if (autoClose) {   // both edges in the silence between two words: what is left of that pause becomes ≤ GAP
      const sp = speech().slice().sort((p, q) => p[0] - q[0]), prev = sp.filter(([, e]) => e <= a + 1e-3).pop(), next = sp.find(([s]) => s >= b - 1e-3);
      if (prev && next) {
        const m0 = M(), left = m0.out(a) - m0.out(prev[1]), right = m0.out(next[0]) - m0.out(b);
        if (left + right > GAP) {
          let keepL = Math.min(left, GAP / 2); const keepR = Math.min(right, GAP - keepL); keepL = Math.min(left, GAP - keepR);
          a = Math.min(a, m0.src(m0.out(prev[1]) + keepL)); b = Math.max(b, m0.src(m0.out(next[0]) - keepR - 1e-6) + 1e-6);
        }
      }
    }
    const n = clone(doc); n.cuts = [...n.cuts, { a: r4(a), b: r4(b) }];
    if (commit(n, label || 'Remove piece')) toast(`Removed ${(b - a).toFixed(2)} s of the clip`);
  }
  function removePiece(p) { const m = M(); removeSrc(m.src(p.a), m.src(p.b - 1e-6) + 1e-6, 'Remove piece'); sel = null; paint(); }
  function restoreCut(i) {
    const m = M(), c = m.cuts[i]; if (!c) return;
    const n = clone(doc); n.cuts = n.cuts.filter((x) => !(x.a < c.b + 1e-4 && x.b > c.a - 1e-4));
    sel = null; if (commit(n, 'Put back')) toast(`Put back ${(c.b - c.a).toFixed(2)} s`);
  }
  function splitHere() {
    const m = M(), s = r4(m.src(time()));
    const n = clone(doc); if ((n.splits || []).some((x) => Math.abs(x - s) < 1 / F())) return toast('There is already a split here');
    n.splits = [...(n.splits || []), s].sort((a, b) => a - b);
    commit(n, 'Split'); toast('Split at ' + fmt(time()) + ' · click a piece, Delete removes it');
  }
  function removeRange() {
    const R = range(); if (!R) return toast('Set a range first: I = start, O = end (on the timeline ruler)', true);
    const m = M(); removeSrc(m.src(R[0]), m.src(R[1] - 1e-6) + 1e-6, 'Remove range');
    clearRange?.();   // the range now points at other pictures
  }
  async function closePauses() {
    const m = M(), sp = speech().slice().sort((p, q) => p[0] - q[0]), add = [];
    for (let i = 0; i < sp.length - 1; i++) {
      const e = sp[i][1], s = sp[i + 1][0], og = m.out(s) - m.out(e);
      if (og > GAP + 0.02) add.push({ a: r4(e + GAP / 2), b: r4(s - GAP / 2), g: og });
    }
    // a pause already partly cut: cut only what is left (the server merges overlapping pieces)
    if (!add.length) return toast('No pause longer than ' + GAP + ' s between the voice lines 👍');
    const total = add.reduce((n, c) => n + c.g - GAP, 0);
    const ok = await confirmBox('Close the pauses?', h('div', {}, h('p', {}, `${add.length} pause${add.length > 1 ? 's' : ''} longer than ${GAP} s between the words. Closing them removes ${total.toFixed(2)} s; each keeps ${GAP} s of silence.`),
      h('ul', { class: 'fe-list' }, add.slice(0, 12).map((c) => h('li', {}, `${fmt(m.out(c.a))} · ${c.g.toFixed(2)} s → ${GAP} s`))), add.length > 12 ? h('p', { class: 'dim' }, `…and ${add.length - 12} more`) : null), 'Close them');
    if (!ok) return;
    const n = clone(doc); n.cuts = [...n.cuts, ...add.map(({ a, b }) => ({ a, b }))];
    if (commit(n, 'Close pauses')) toast(`Closed ${add.length} pause${add.length > 1 ? 's' : ''} (−${total.toFixed(2)} s)`);
  }

  // ---------------------------------------------------------------- the picture: find, select, move, resize, retype
  const ov = h('div', { class: 'fe-ov', title: '' });
  const hoverBox = h('div', { class: 'fe-box fe-hover', hidden: true });
  const handle = h('div', { class: 'fe-handle', title: 'Drag: resize' });
  const selBox = h('div', { class: 'fe-box fe-sel', hidden: true }, h('span', { class: 'fe-tag' }), handle);
  const textIn = h('input', { class: 'fe-textin', hidden: true, dir: 'auto', spellcheck: false });
  ov.append(hoverBox, selBox, textIn);
  const info = () => src.info || { w: 1080, h: 1920 };
  const k = () => ov.offsetWidth / (info().w || 1);   // overlay px per film px
  const opacityChain = (n, stop) => { let o = 1; for (let p = n; p && p !== stop; p = p.parentElement) { const s = p.style; if (s.display === 'none' || s.visibility === 'hidden') return 0; if (s.opacity !== '') o *= parseFloat(s.opacity) || 0; } return o; };
  function contentBox(el, w) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (r) => { if (r.width < 1 || r.height < 1) return; x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); };
    const d = w.document, tw = d.createTreeWalker(el, 4), rg = d.createRange();
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (!n.nodeValue.trim() || opacityChain(n.parentElement, el) < 0.05) continue; rg.selectNodeContents(n); for (const r of rg.getClientRects()) add(r); }
    for (const m of el.querySelectorAll('img, svg, canvas, video')) if (opacityChain(m, el) >= 0.05) add(m.getBoundingClientRect());
    return x0 < x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  function onPicture() {
    const w = page(); if (!w?.document) return [];
    const out = [];
    for (const el of w.document.querySelectorAll('[data-vh]')) {
      if (!el.firstElementChild) continue;
      const vid = el.getAttribute('data-vh'), it = items.get(vid); if (!it || it.kind === 'sfx' || it.kind === 'music' || it.kind === 'scene') continue;
      const b = contentBox(el, w); if (b) out.push({ vid, el, b, it });
    }
    return out;
  }
  const at = (list, fx, fy) => list.filter((x) => fx >= x.b.x - 6 && fx <= x.b.x + x.b.w + 6 && fy >= x.b.y - 6 && fy <= x.b.y + x.b.h + 6).sort((p, q) => p.b.w * p.b.h - q.b.w * q.b.h)[0] || null;
  const filmXY = (e) => { const R = ov.getBoundingClientRect(), s = ov.offsetWidth / (R.width || 1); return [((e.clientX - R.left) * s) / k(), ((e.clientY - R.top) * s) / k()]; };
  function place(node, b) { const K = k(); node.style.left = b.x * K + 'px'; node.style.top = b.y * K + 'px'; node.style.width = b.w * K + 'px'; node.style.height = b.h * K + 'px'; node.hidden = false; }
  let boxRaf = 0, lastBoxes = 0, hoverVid = null;
  function boxes(now) {
    if (!open) return;
    if (!now && performance.now() - lastBoxes < 90) { if (!boxRaf) boxRaf = requestAnimationFrame(() => { boxRaf = 0; boxes(true); }); return; }
    lastBoxes = performance.now();
    requestAnimationFrame(() => {   // after the page committed the frame
      const list = onPicture(), s = sel?.type === 'item' ? list.find((x) => x.vid === sel.vid) : null;
      if (s) { place(selBox, s.b); selBox.querySelector('.fe-tag').textContent = (s.it.text || s.it.label || '').slice(0, 40); handle.hidden = !!pic && pic.mode === 'move'; } else selBox.hidden = true;
      const hv = hoverVid && hoverVid !== sel?.vid ? list.find((x) => x.vid === hoverVid) : null;
      if (hv) place(hoverBox, hv.b); else hoverBox.hidden = true;
      if (!textIn.hidden && s) { const K = k(); textIn.style.left = s.b.x * K + 'px'; textIn.style.top = (s.b.y + s.b.h) * K + 4 + 'px'; }
    });
  }
  function layerScale(el) { const p = el.parentElement; if (!p || !p.offsetWidth) return 1; return p.getBoundingClientRect().width / p.offsetWidth || 1; }
  ov.addEventListener('pointermove', (e) => {
    if (pic) return picMove(e);
    const [fx, fy] = filmXY(e), hit = at(onPicture(), fx, fy);
    const v = hit?.vid || null;
    ov.style.cursor = hit ? (hit.vid === sel?.vid ? 'move' : 'pointer') : 'default';
    if (v !== hoverVid) { hoverVid = v; boxes(true); }
  });
  ov.addEventListener('pointerleave', () => { if (!pic && hoverVid) { hoverVid = null; boxes(true); } });
  ov.addEventListener('pointerdown', (e) => {
    mine = true;
    if (e.target === textIn) return;
    e.preventDefault(); e.stopPropagation();
    const [fx, fy] = filmXY(e), list = onPicture();
    const isHandle = e.target === handle;
    const hit = isHandle ? list.find((x) => x.vid === sel?.vid) : at(list, fx, fy);
    if (!hit) { if (sel) { sel = null; paint(); boxes(true); timeline.draw(); } return; }
    pause();
    if (sel?.vid !== hit.vid) select({ type: 'item', vid: hit.vid });
    const o = doc.items[hit.vid] || {}, ls = layerScale(hit.el);
    pic = { mode: isHandle ? 'size' : 'move', vid: hit.vid, it: hit.it, fx, fy, o, ls, moved: false, b: hit.b, el: hit.el };
    if (isHandle) {
      const cx = hit.b.x + hit.b.w / 2, cy = hit.b.y + hit.b.h / 2;
      pic.cx = cx; pic.cy = cy; pic.d0 = Math.max(4, Math.hypot(fx - cx, fy - cy)); pic.k0 = o.k ?? 1;
      if (o.k == null || o.ox == null) {   // scale around the element's own centre, in its layer's px (before the nudge)
        const P = hit.el.parentElement.getBoundingClientRect();
        pic.ox = (cx - P.left) / ls - (o.dx || 0); pic.oy = (cy - P.top) / ls - (o.dy || 0);
      } else { pic.ox = o.ox; pic.oy = o.oy; }
    }
    try { ov.setPointerCapture(e.pointerId); } catch { }
  });
  let picRaf = 0;
  function picMove(e) {
    const P = pic, [fx, fy] = filmXY(e);
    if (!P.moved && Math.hypot(fx - P.fx, fy - P.fy) < 3) return;
    P.moved = true;
    if (P.mode === 'move') { const dx = (fx - P.fx) / P.ls, dy = (fy - P.fy) / P.ls; P.next = { ...P.o, dx: Math.round(((P.o.dx || 0) + dx) * 10) / 10, dy: Math.round(((P.o.dy || 0) + dy) * 10) / 10 }; }
    else { const kk = Math.max(0.2, Math.min(6, P.k0 * Math.hypot(fx - P.cx, fy - P.cy) / P.d0)); P.next = { ...P.o, k: Math.round(kk * 1000) / 1000, ox: Math.round(P.ox), oy: Math.round(P.oy) }; }
    if (!picRaf) picRaf = requestAnimationFrame(() => { picRaf = 0; if (pic?.next) { preview(pic.it, pic.next); } });
  }
  function picUp(e, cancel) {
    const P = pic; pic = null; if (!P) return;
    try { ov.releasePointerCapture(e.pointerId); } catch { }
    if (!P.moved || !P.next) return;
    if (cancel) { live(doc, true); return; }
    setItem(P.it, P.next, P.mode === 'move' ? 'Move on the picture' : 'Resize');
  }
  ov.addEventListener('pointerup', (e) => picUp(e, false));
  ov.addEventListener('pointercancel', (e) => picUp(e, true));
  ov.addEventListener('dblclick', (e) => {
    const [fx, fy] = filmXY(e), hit = at(onPicture(), fx, fy);
    if (hit && hit.it.text != null) retype(hit.it);
  });
  // retype right on the picture: a box under the element, Enter = keep, Esc = cancel
  let typing = null;
  function retype(it) {
    if (it.text == null) return toast('This element has no text to retype');
    typing = it; textIn.value = it.text; textIn.hidden = false; boxes(true);
    setTimeout(() => { textIn.focus(); textIn.select(); }, 0);
  }
  textIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { const it = typing; typing = null; textIn.blur(); textIn.hidden = true; if (it) setItem(it, { ...(doc.items[it.vid] || {}), text: textIn.value }, 'Retype'); }
    else if (e.key === 'Escape') { typing = null; textIn.blur(); textIn.hidden = true; live(doc, true); }
  });
  textIn.addEventListener('input', () => { if (typing) preview(typing, { ...(doc.items[typing.vid] || {}), text: textIn.value }); });
  textIn.addEventListener('blur', () => { if (typing) { const it = typing; typing = null; textIn.hidden = true; if (textIn.value !== it.text) setItem(it, { ...(doc.items[it.vid] || {}), text: textIn.value }, 'Retype'); } });

  // ---------------------------------------------------------------- the panel
  const panel = h('div', { class: 'fe-panel' });
  const stEl = h('span', { class: 'fe-st dim' });
  function status() { stEl.textContent = pending ? 'Saving…' : rev ? 'Saved ✓' : ''; }
  const field = (label, ...kids) => h('div', { class: 'fe-row' }, h('span', { class: 'fe-lab' }, label), ...kids);
  const small = (txt, title, fn, cls = 'ghost') => h('button', { class: cls + ' fe-sm', title, onclick: fn }, txt);
  function slider(min, max, step, val, fmtV, onInput, onChange) {
    const out = h('span', { class: 'fe-val' }, fmtV(val));
    const r = h('input', { type: 'range', min, max, step, value: val, class: 'fe-range' });
    r.addEventListener('input', () => { out.textContent = fmtV(+r.value); onInput(+r.value); });
    r.addEventListener('change', () => onChange(+r.value));
    r.addEventListener('dblclick', () => { r.value = 0; out.textContent = fmtV(0); onChange(0); });
    return [r, out];
  }
  function timeInput(val, onSet) {
    const i = h('input', { type: 'text', class: 'fe-time', value: fmt(val), title: 'm:ss.ss — Enter to set' });
    i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const m = String(i.value).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); if (!m) return toast('Write the time as m:ss.ss', true); onSet((+m[1] || 0) * 60 + +m[2]); } });
    return i;
  }
  let libPop = null;
  function paint() {
    if (!open) return;
    const kids = [h('div', { class: 'fe-head' }, h('b', {}, '🎬 Film editor'), stEl,
      h('span', { class: 'spacer' }),
      small('↶', 'Undo (Ctrl+Z)', () => { if (undo()) history?.undone?.(); }), small('↷', 'Redo (Ctrl+Y)', () => redo()))];
    status();
    kids.push(selCard());
    kids.push(clipCard(), musicCard(), h('div', { class: 'fe-help dim' },
      'Picture: click a text to select it · drag = move · corner square = size · double-click = retype · arrows = nudge. Timeline: drag a block = move, its edges = trim. Delete hides / mutes. Every change is saved in the film (renders use it).'));
    panel.replaceChildren(...kids);
  }
  function selCard() {
    if (!sel) return h('div', { class: 'fe-card dim' }, 'Nothing selected. Click a text on the picture, or a block on the timeline.');
    const m = M();
    if (sel.type === 'piece') {
      return h('div', { class: 'fe-card' }, h('div', { class: 'fe-title' }, `🎙 Piece of the clip`),
        h('div', { class: 'dim' }, `${fmt(sel.a)} → ${fmt(sel.b)} · ${(sel.b - sel.a).toFixed(2)} s`),
        h('div', { class: 'fe-row' }, h('button', { class: 'primary', onclick: () => removePiece(sel) }, '✂ Remove this piece'), small('▶ Play it', 'Play this piece', () => { seek(sel.a); })),
        h('label', { class: 'fe-chk' }, h('input', { type: 'checkbox', checked: autoClose, onchange: (e) => { autoClose = e.target.checked; } }), ` close the pause around the cut (≤ ${GAP} s)`));
    }
    if (sel.type === 'cut') {
      const c = m.cuts[sel.i]; if (!c) return h('div', { class: 'fe-card dim' }, '—');
      return h('div', { class: 'fe-card' }, h('div', { class: 'fe-title' }, '✂ Removed piece'),
        h('div', { class: 'dim' }, `${(c.b - c.a).toFixed(2)} s removed at ${fmt(m.out(c.a))} (from ${fmt(c.a)} to ${fmt(c.b)} of the uncut clip)`),
        h('div', { class: 'fe-row' }, h('button', { class: 'primary', onclick: () => restoreCut(sel.i) }, '↺ Put it back'), small('▶ Play the join', '', () => seek(Math.max(0, m.out(c.a) - 1.5)))));
    }
    const it = items.get(sel.vid); if (!it) return h('div', { class: 'fe-card dim' }, '—');
    const o = doc.items[it.vid] || {}, a = m.out(it.s), b = m.out(it.e);
    const card = h('div', { class: 'fe-card' });
    card.append(h('div', { class: 'fe-title' }, `${ICON[it.kind] || ''} ${it.lane} · ${it.label || it.text || it.vid}`, it.edited ? h('span', { class: 'pill fe-pill' }, 'edited') : null,
      it.edited ? small('Reset', 'Back to the film\'s own values for this element', () => setItem(it, {}, 'Reset')) : null));
    if (it.locked) { card.append(h('div', { class: 'dim' }, `${fmt(a)} → ${fmt(b)} · built on these times (locked)`)); return card; }
    // time
    const setStart = (t) => setItem(it, { ...o, ds: m.src(t) - it.s0, ...(it.fixedLen ? {} : { de: o.de ?? 0 }) }, 'Start');
    const setEnd = (t) => setItem(it, { ...o, de: m.src(t - 1e-6) + 1e-6 - it.e0 }, 'End');
    const step = (n) => () => setItem(it, { ...o, ds: (o.ds || 0) + n / F(), ...(it.fixedLen ? {} : { de: (o.de || 0) + n / F() }) }, 'Nudge in time');
    card.append(field('Start', timeInput(a, setStart), small('−1f', 'One frame earlier (Alt+←)', step(-1)), small('+1f', 'One frame later (Alt+→)', step(1)), small('⇤ here', 'Start at the playhead', () => setStart(time()))));
    if (!it.fixedLen) card.append(field('End', timeInput(b, setEnd), small('−1f', 'End one frame earlier', () => setItem(it, { ...o, de: (o.de || 0) - 1 / F() }, 'End')), small('+1f', 'End one frame later', () => setItem(it, { ...o, de: (o.de || 0) + 1 / F() }, 'End')), small('⇥ here', 'End at the playhead', () => setEnd(time()))));
    else card.append(h('div', { class: 'dim fe-sub' }, `${fmt(a)} → ${fmt(b)} (${(b - a).toFixed(2)} s)`));
    // texts
    if (it.text != null) {
      const ti = h('input', { type: 'text', class: 'fe-text', value: it.text, dir: 'auto' });
      ti.addEventListener('input', () => preview(it, { ...o, text: ti.value }));
      ti.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ti.blur(); if (e.key === 'Escape') { ti.value = it.text; live(doc, true); ti.blur(); } });
      ti.addEventListener('change', () => setItem(it, { ...o, text: ti.value }, 'Retype'));
      card.append(field(it.kind === 'caption' ? 'Caption' : 'Text', ti));
    }
    if (it.text2 != null || it.text20 != null) {
      const t2 = h('input', { type: 'text', class: 'fe-text', value: it.text2 ?? '', dir: 'auto' });
      t2.addEventListener('input', () => preview(it, { ...o, text2: t2.value }));
      t2.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') t2.blur(); });
      t2.addEventListener('change', () => setItem(it, { ...o, text2: t2.value }, 'Retype'));
      card.append(field(it.kind === 'caption' ? 'Big line' : 'Second line', t2));
    }
    // picture
    if (['caption', 'text', 'graphic'].includes(it.kind)) {
      const nud = (dx, dy) => (e) => { const n = e?.shiftKey ? 10 : 1; setItem(it, { ...o, dx: (o.dx || 0) + dx * n, dy: (o.dy || 0) + dy * n }, 'Nudge'); };
      card.append(field('Place', small('←', '2 px left (Shift: 20)', nud(-2, 0)), small('→', '2 px right', nud(2, 0)), small('↑', '2 px up', nud(0, -2)), small('↓', '2 px down', nud(0, 2)),
        h('span', { class: 'dim fe-sub' }, `${Math.round(o.dx || 0)}, ${Math.round(o.dy || 0)} px`)));
      const [sr, sv] = slider(-100, 100, 1, Math.round(Math.log2(o.k ?? 1) * 100), (v) => Math.round(2 ** (v / 100) * 100) + '%',
        (v) => preview(it, { ...o, k: 2 ** (v / 100), ...originFor(it, o) }), (v) => setItem(it, { ...o, k: 2 ** (v / 100), ...originFor(it, o) }, 'Resize'));
      card.append(field('Size', sr, sv));
      if (o.dx || o.dy || o.k) card.append(h('div', { class: 'fe-row' }, small('Reset place & size', '', () => { const n = { ...o }; delete n.dx; delete n.dy; delete n.k; delete n.ox; delete n.oy; setItem(it, n, 'Reset place'); })));
      card.append(h('label', { class: 'fe-chk' }, h('input', { type: 'checkbox', checked: !it.off, onchange: (e) => setItem(it, { ...o, off: !e.target.checked }, e.target.checked ? 'Show' : 'Hide') }), ' shown in the film'));
    }
    // sound
    if (it.kind === 'sfx' || it.kind === 'music') {
      const g0 = o.gain ?? 1;
      const [vr, vv] = slider(-30, 12, 0.5, Math.max(-30, toDb(g0)), dbTxt, (v) => preview(it, { ...o, gain: fromDb(v) }), (v) => setItem(it, { ...o, gain: fromDb(v) }, 'Volume'));
      card.append(field(it.kind === 'music' ? 'Level' : 'Volume', vr, vv));
      if (it.kind === 'music') {
        const d0 = o.duck ?? it.duck ?? -3;
        const [dr, dv] = slider(-24, 0, 0.5, d0, (v) => v.toFixed(1) + ' dB', (v) => preview(it, { ...o, duck: v }), (v) => setItem(it, { ...o, duck: v }, 'Ducking'));
        card.append(field('Under voice', dr, dv), h('div', { class: 'dim fe-sub' }, 'How much lower the music plays while he talks (0 = no ducking).'));
      }
      card.append(h('div', { class: 'fe-row' },
        h('label', { class: 'fe-chk' }, h('input', { type: 'checkbox', checked: it.off, onchange: (e) => setItem(it, { ...o, off: e.target.checked }, e.target.checked ? 'Mute' : 'Unmute') }), ' muted'),
        small('▶ Listen', 'Play this sound alone', () => listen(it.file)),
        it.kind === 'sfx' ? small('🔁 Replace…', 'Pick another sound from the library', () => openLib(it)) : null,
        o.file ? small('Original', 'Back to the film\'s own sound', () => { const n = { ...o }; delete n.file; delete n.fdur; delete n.fname; setItem(it, n, 'Original sound'); }) : null));
      if (o.file) card.append(h('div', { class: 'dim fe-sub' }, 'Now: ' + (o.fname || o.file)));
      if (libPop && libPop.vid === it.vid) card.append(libPop.el);
    }
    return card;
  }
  function originFor(it, o) {
    if (o.ox != null && o.oy != null) return { ox: o.ox, oy: o.oy };
    const s = onPicture().find((x) => x.vid === it.vid); if (!s) return {};
    const P = s.el.parentElement.getBoundingClientRect(), ls = layerScale(s.el);
    return { ox: Math.round((s.b.x + s.b.w / 2 - P.left) / ls - (o.dx || 0)), oy: Math.round((s.b.y + s.b.h / 2 - P.top) / ls - (o.dy || 0)) };
  }
  function clipCard() {
    const m = M();
    return h('div', { class: 'fe-card' }, h('div', { class: 'fe-title' }, `🎙 ${man?.clip?.label || 'Voice + face'}`),
      h('div', { class: 'fe-row' },
        small('✂ Split here', 'Split the clip at the playhead (S); click a piece, Delete removes it', () => splitHere(), 'ghost'),
        small('✂ Remove I→O', 'Remove the range set with I and O (on the ruler)', () => removeRange(), 'primary'),
        small('⏩ Close pauses', `Every pause longer than ${GAP} s between his words becomes ${GAP} s`, () => closePauses())),
      m.cuts.length ? h('div', { class: 'fe-cuts' }, h('div', { class: 'dim' }, `${m.cuts.length} piece${m.cuts.length > 1 ? 's' : ''} removed · ${m.removed.toFixed(2)} s`),
        m.cuts.map((c, i) => h('div', { class: 'fe-cut' + (sel?.type === 'cut' && sel.i === i ? ' on' : '') }, h('span', { onclick: () => { select({ type: 'cut', i }); seek(Math.max(0, m.out(c.a) - 1)); } }, `✂ ${fmt(m.out(c.a))} · ${(c.b - c.a).toFixed(2)} s`),
          small('↺', 'Put this piece back', () => restoreCut(i))))) : h('div', { class: 'dim fe-sub' }, 'Nothing removed. Pauses and bad takes: set I/O and Remove, or split and Delete the piece.'));
  }
  function musicCard() {
    const ms = [...items.values()].filter((it) => it.kind === 'music');
    if (!ms.length) return null;
    return h('div', { class: 'fe-card' }, h('div', { class: 'fe-title' }, '🎵 Music'), ms.map((it) => {
      const o = doc.items[it.vid] || {};
      const [vr, vv] = slider(-24, 12, 0.5, toDb(o.gain ?? 1), dbTxt, (v) => preview(it, { ...o, gain: fromDb(v) }), (v) => setItem(it, { ...o, gain: fromDb(v) }, 'Music level'));
      const d0 = o.duck ?? it.duck ?? -3;
      const [dr, dv] = slider(-24, 0, 0.5, d0, (v) => v.toFixed(1) + ' dB', (v) => preview(it, { ...o, duck: v }), (v) => setItem(it, { ...o, duck: v }, 'Ducking'));
      return h('div', {}, h('div', { class: 'fe-sub' }, it.label || it.vid), field('Level', vr, vv), field('Under voice', dr, dv));
    }));
  }
  // ▶ a sound alone (the film's public mirror is served by /media)
  const player = new Audio();
  function listen(file) {
    const mirror = man && filmMirror; if (!file || !mirror) return;
    player.src = '/media?p=' + encodeURIComponent(mirror + '\\' + file.replace(/\//g, '\\')); player.play().catch(() => toast('Could not play the sound', true));
  }
  let filmMirror = null;
  // the library picker (the global-video-styles skill's sounds; never the glass ones)
  function openLib(it) {
    if (libPop?.vid === it.vid) { libPop = null; paint(); return; }
    const q = h('input', { type: 'search', placeholder: 'Search: whoosh, ping, impact…', class: 'fe-text' }), cat = h('select', {}), list = h('div', { class: 'fe-lib' });
    const pop = { vid: it.vid, el: h('div', { class: 'fe-libbox' }, h('div', { class: 'fe-row' }, q, cat), list) };
    let timer = 0;
    const load = () => api(`/api/sfx-library?q=${encodeURIComponent(q.value)}&cat=${encodeURIComponent(cat.value)}`).then((r) => {
      if (!cat.options.length) cat.append(h('option', { value: '' }, `All (${r.total})`), ...Object.entries(r.cats).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([c, n]) => h('option', { value: c }, `${c} (${n})`)));
      list.replaceChildren(...r.items.slice(0, 150).map((x) => h('div', { class: 'fe-libitem' },
        small('▶', 'Listen', () => { player.src = '/api/sfx-library/play?f=' + encodeURIComponent(x.id); player.play().catch(() => { }); }),
        h('span', { class: 'fe-libname', title: x.id }, x.title, h('span', { class: 'dim' }, ` · ${x.cat}${x.dur ? ' · ' + x.dur.toFixed(1) + ' s' : ''}`)),
        small('Use', 'Replace this SFX with it', () => useSfx(it, x), 'primary'))), r.more ? h('div', { class: 'dim' }, `+${r.more} more: search to narrow`) : null);
    }).catch((e) => list.replaceChildren(h('div', { class: 'dim' }, 'Library: ' + e.message)));
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    q.addEventListener('keydown', (e) => e.stopPropagation());
    cat.addEventListener('change', load);
    libPop = pop; load(); paint(); setTimeout(() => q.focus(), 0);
  }
  async function useSfx(it, x) {
    try {
      const r = await api(`/api/project/${projectId}/film-sfx`, { method: 'POST', body: { id: x.id } });
      libPop = null;
      setItem(it, { ...(doc.items[it.vid] || {}), file: r.file, fdur: r.dur || x.dur || undefined, fname: x.title }, 'Replace sound');
      toast('Replaced with « ' + x.title + ' »');
    } catch (e) { toast('Could not use that sound: ' + e.message, true); }
  }

  // ---------------------------------------------------------------- keys (only while open; capture, before the review page)
  let lastArea = null;
  const onDown = (e) => { lastArea = e.target.closest?.('.fe-ov') ? 'picture' : e.target.closest?.('.fe-panel') ? 'panel' : null; if (!lastArea && !e.target.closest?.('.tl2')) mine = false; };
  function onKey(e) {
    if (!open || e.target.matches?.('input, textarea, select, [contenteditable]')) return;
    const it = sel?.type === 'item' ? items.get(sel.vid) : null, o = it ? doc.items[it.vid] || {} : null;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.ctrlKey || e.metaKey) return;
    if ((e.key === 's' || e.key === 'S') && !e.altKey && !e.shiftKey) { stop(); splitHere(); return; }
    if (!mine) return;   // the last click was elsewhere (a sound clip, the notes): the page's own keys
    if (e.key === 'Escape' && sel) { stop(); sel = null; paint(); boxes(true); timeline.draw(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel?.type === 'piece') { stop(); removePiece(sel); return; }
      if (sel?.type === 'cut') { stop(); restoreCut(sel.i); return; }
      if (it && !it.locked) { stop(); setItem(it, { ...o, off: !it.off }, it.kind === 'sfx' || it.kind === 'music' ? (it.off ? 'Unmute' : 'Mute') : it.off ? 'Show' : 'Hide'); toast((it.off ? 'Back: ' : 'Removed: ') + (it.label || it.text || it.vid) + ' · Ctrl+Z undoes'); return; }
    }
    if (it && !it.locked && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      stop(); const n = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) / F();
      setItem(it, { ...o, ds: (o.ds || 0) + n, ...(it.fixedLen ? {} : { de: (o.de || 0) + n }) }, 'Nudge in time'); return;
    }
    if (it && !it.locked && lastArea === 'picture' && ['caption', 'text', 'graphic'].includes(it.kind) && e.key.startsWith('Arrow') && !e.altKey) {
      stop(); const n = e.shiftKey ? 20 : 2, d = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[e.key];
      setItem(it, { ...o, dx: (o.dx || 0) + d[0], dy: (o.dy || 0) + d[1] }, 'Nudge'); return;
    }
    if (it && e.key === 'Enter' && it.text != null && lastArea === 'picture') { stop(); retype(it); }
  }

  // ---------------------------------------------------------------- open / close
  async function start() {
    E = edit(); if (!E) return;
    try {
      const r = await api(`/api/project/${projectId}/film-edits`);
      doc = { v: 1, items: r.doc.items || {}, cuts: r.doc.cuts || [], splits: r.doc.splits || [] }; rev = r.rev; filmMirror = r.mirror;
    } catch (e) { toast('Could not open the film editor: ' + e.message, true); return; }
    open = true; btn.classList.add('on'); pause();
    frame.append(ov); (panelHost || frame).append(panel);
    undoS = []; redoS = []; sel = null;
    window.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', onDown, true);
    live(doc);   // the page may hold an older copy (edits made since it loaded)
    timeline.setExt(provider);
    onOpen?.(); paint(); boxes(true);
  }
  function close(silent) {
    if (!open) return;
    open = false; btn.classList.remove('on'); ov.remove(); panel.remove(); sel = null; pic = null; drag = null; libPop = null;
    window.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true);
    timeline.setExt(null); player.pause();
    onClose?.(); void silent;
  }
  // the page reloaded / became ready: offer the button; an open editor reads the new page (and its new length)
  src.addEventListener('loadedmetadata', () => {
    check();
    if (open && reloadSrcT != null) { const t = M().out(reloadSrcT); reloadSrcT = null; seek(t); }
  });
  // follow the picture while it moves (seek, play, frame steps)
  const onTime = () => { if (open) boxes(false); };
  src.addEventListener('timeupdate', onTime); src.addEventListener('seeked', onTime);
  // Claude (or anyone) changed vh-edits.json by hand: take it
  const offEv = onHubEvent('film-edits', (ev) => {
    if (!open || ev?.project !== projectId || ev.rev === rev || pending) return;
    api(`/api/project/${projectId}/film-edits`).then((r) => {
      if (r.rev === rev) return;
      doc = { v: 1, items: r.doc.items || {}, cuts: r.doc.cuts || [], splits: r.doc.splits || [] }; rev = r.rev; undoS = []; redoS = [];
      live(doc); toast('The film\'s edits were changed outside VideoHub; showing them now.');
    }).catch(() => { });
  });
  return {
    el: btn, check, isOpen: () => open, open: () => (open ? null : start()), close,
    undo: () => (open ? undo() : false), redo: () => (open ? redo() : false),
    destroy() { close(true); offEv(); src.removeEventListener('timeupdate', onTime); src.removeEventListener('seeked', onTime); },
  };
}
