// VideoHub edit layer for Remotion films (VideoHub Remotion bridge). build.mjs --init-edit copies this file into the
// film's src/; run that again to update it. Keep film-specific code out of this file.
//
// What the user changes in VideoHub's film editor (blocks moved or trimmed on the timeline, texts retyped, elements
// nudged or resized on the picture, sound volumes, SFX replaced, pieces of the clip removed) is saved in
// src/vh-edits.json as OVERRIDES over the film's own values: the code stays the source of every default, the file
// only says "this element: 0.2 s later, this text, −4 dB". Timings are deltas, so a recut of the code moves the
// edited element with its anchor. Claude may edit the code freely; keep the element ids stable (see the contract).
//
//   vhList(id, meta, () => defaults[], toView, fromView)  a list of elements; returns a getter of the edited list
//   vhOne(id, meta, () => view)                           one element; returns a getter of its edited view
//   vhClip(meta)                                          the voice-and-face clip the cuts act on (speech words)
//   <Vh of={item}>…</Vh>                                  marks an element on the picture (click, nudge, size)
//   <VhCut total={frames} keep={…}>…</VhCut>              the composition root: plays the film minus the removed pieces;
//                                                        `keep` = layers that run on through a cut (the music bed)
//   vhDuration(frames, fps)                               the length after cuts (Root: calculateMetadata)
//   vhSrc(frame, fps)                                     an output frame → the frame of the uncut film (`keep` layers)
//   vhRetime(words, s0, e0, s1, e1) / vhRetext(words, text, s, e)   caption helpers
//
// Renders (Remotion Studio, the CLI) use src/vh-edits.json as bundled. VideoHub's live preview loads the newest edits
// from the hub (window.__VH_EDIT.set) and redraws at once, without a rebuild.
import React, {createContext, useContext} from 'react';
import {Sequence, useVideoConfig} from 'remotion';
import FILE from './vh-edits.json';

export type VhKind = 'scene' | 'caption' | 'text' | 'graphic' | 'sfx' | 'music' | 'clip';
/** one element's override (every field optional; absent = as coded) */
export type VhOv = {
  ds?: number; de?: number;          // seconds added to the coded start / end (uncut timeline)
  text?: string; text2?: string;     // retyped texts
  dx?: number; dy?: number;          // nudge on the picture, px of the element's own layer
  k?: number; ox?: number; oy?: number; // size × and the point it scales around (px)
  gain?: number;                     // volume × (1 = as coded)
  duck?: number;                     // music: dB under the voice
  off?: boolean;                     // hidden / muted
  file?: string; fdur?: number; fname?: string; // a replacement sound (public/ path, its length, its name)
};
export type VhCutRange = {a: number; b: number}; // a removed piece, seconds of the uncut timeline
export type VhEdits = {v: 1; items: Record<string, VhOv>; cuts: VhCutRange[]; splits: number[]};
/** what an element shows to VideoHub (the coded values) */
export type VhView = {
  id?: string | number;  // key inside its list (default: label, else text, else index); repeats get #2, #3…
  s: number; e: number;  // seconds, uncut timeline
  label?: string;        // name on the timeline block (default: text)
  text?: string; text2?: string;
  gain?: number; duck?: number; file?: string;
  fixedLen?: boolean;    // a sound: moving keeps its length (no trimming)
  locked?: boolean;      // shown, not editable
};
/** lane = the timeline row (lists with the same lane share it); always = listed even when the composition never reads it
 *  (elements are listed once the film has used them: a module imported by another composition stays out) */
export type VhMeta = {lane: string; kind: VhKind; always?: boolean};
/** an element as edited; s0/e0/text0/text20/duck0/file0 = the coded values */
export type VhItem = VhView & {vid: string; lane: string; kind: VhKind; s0: number; e0: number; text0?: string; text20?: string; duck0?: number; file0?: string;
  dx: number; dy: number; k: number; ox?: number; oy?: number; gain: number; off: boolean; edited: boolean; fdur?: number; fname?: string};

const W: any = typeof window !== 'undefined' ? window : {};
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
function norm(x: any): VhEdits {
  const o = x && typeof x === 'object' ? x : {};
  const items = o.items && typeof o.items === 'object' && !Array.isArray(o.items) ? o.items : {};
  const cuts = (Array.isArray(o.cuts) ? o.cuts : []).filter((c: any) => num(c?.a) !== undefined && num(c?.b) !== undefined && c.b > c.a).map((c: any) => ({a: c.a, b: c.b}));
  const splits = (Array.isArray(o.splits) ? o.splits : []).filter((t: unknown) => num(t) !== undefined);
  return {v: 1, items, cuts, splits};
}
let E: VhEdits = norm(W.__VH_EDITS_PRELOAD ?? FILE);
let ver = 0;
const subs = new Set<() => void>();
export const vhEdits = () => E;

// ---------------------------------------------------------------- elements
function resolve(vid: string, meta: VhMeta, v: VhView): VhItem {
  const o: VhOv = E.items[vid] || {};
  const s = v.s + (num(o.ds) ?? 0);
  // a sound keeps its length (a replaced one takes the new file's: fdur)
  const e = v.fixedLen ? s + (o.file && num(o.fdur) ? (o.fdur as number) : v.e - v.s) : Math.max(s + 1 / 60, v.e + (num(o.de) ?? 0));
  return {
    ...v, vid, lane: meta.lane, kind: meta.kind, s, e, s0: v.s, e0: v.e, text0: v.text, text20: v.text2, duck0: v.duck, file0: v.file,
    text: o.text ?? v.text, text2: o.text2 ?? v.text2, label: v.label ?? v.text,
    gain: (v.gain ?? 1) * (num(o.gain) ?? 1), duck: num(o.duck) ?? v.duck, file: o.file ?? v.file, fdur: num(o.fdur), fname: o.fname,
    dx: num(o.dx) ?? 0, dy: num(o.dy) ?? 0, k: num(o.k) ?? 1, ox: num(o.ox), oy: num(o.oy), off: !!o.off, edited: Object.keys(o).length > 0,
  };
}
type Track = {id: string; meta: VhMeta; all: () => VhItem[]; used: () => boolean};
const tracks: Track[] = [];
const addTrack = (t: Track) => { const i = tracks.findIndex((x) => x.id === t.id); if (i >= 0) tracks[i] = t; else tracks.push(t); };   // hot reload: replace

/** a list of editable elements. toView: what VideoHub shows (coded values); fromView: the element with the edited values.
 *  The getter returns the visible elements (hidden ones left out), each with `.vh` (for <Vh of>). */
export function vhList<T extends object>(id: string, meta: VhMeta, defaults: () => T[], toView: (t: T, i: number) => VhView, fromView: (t: T, v: VhItem) => T): () => (T & {vh: VhItem})[] {
  let memo: {ver: number; all: VhItem[]; on: (T & {vh: VhItem})[]} = {ver: -1, all: [], on: []}, used = !!meta.always;
  const compute = () => {
    if (memo.ver === ver) return memo;
    const seen = new Map<string, number>(), all: VhItem[] = [], on: (T & {vh: VhItem})[] = [];
    defaults().forEach((t, i) => {
      const view = toView(t, i), key = String(view.id ?? view.label ?? view.text ?? i);
      const n = (seen.get(key) || 0) + 1; seen.set(key, n);
      const v = resolve(`${id}:${key}${n > 1 ? '#' + n : ''}`, meta, view);
      all.push(v);
      if (!v.off) on.push({...fromView(t, v), vh: v});
    });
    memo = {ver, all, on};
    return memo;
  };
  addTrack({id, meta, all: () => compute().all, used: () => used});
  return () => { used = true; return compute().on; };
}
/** one editable element: the getter returns its edited view (also when hidden: check .off) */
export function vhOne(id: string, meta: VhMeta, view: () => VhView): () => VhItem {
  let memo: {ver: number; v: VhItem | null} = {ver: -1, v: null}, used = !!meta.always;
  const get = () => { if (memo.ver !== ver || !memo.v) memo = {ver, v: resolve(id, meta, view())}; return memo.v as VhItem; };
  addTrack({id, meta, all: () => [get()], used: () => used});
  return () => { used = true; return get(); };
}

// the clip the cuts act on: its lane name and the words spoken in it (for snapping cuts and closing pauses)
let clip: {lane: string; label: string; speech: () => [number, number, string][]} | null = null;
export function vhClip(meta: {lane?: string; label?: string; speech: () => [number, number, string][]}) {
  clip = {lane: meta.lane ?? 'Voice + face', label: meta.label ?? 'Voice + face', speech: meta.speech};
}

/** marks an element on the picture: VideoHub finds it there (click → select, drag → nudge, size) */
export const Vh: React.FC<{of?: {vh?: VhItem} | VhItem | null; children?: React.ReactNode}> = ({of, children}) => {
  const v: VhItem | undefined = !of ? undefined : (of as VhItem).vid ? (of as VhItem) : (of as {vh?: VhItem}).vh;
  if (!v) return <>{children}</>;
  const moved = v.dx || v.dy || v.k !== 1;
  return (
    <div data-vh={v.vid} style={{position: 'absolute', inset: 0, ...(moved ? {transform: `translate(${v.dx}px, ${v.dy}px) scale(${v.k})`,
      transformOrigin: v.ox !== undefined && v.oy !== undefined ? `${v.ox}px ${v.oy}px` : '50% 50%'} : {})}}>
      {children}
    </div>
  );
};

// ---------------------------------------------------------------- cuts (removed pieces of the clip)
type Seg = {src: number; out: number; len: number};
function mergedCuts(total: number, fps: number) {
  const cs = E.cuts.map((c) => ({a: Math.max(0, Math.round(c.a * fps)), b: Math.min(total, Math.round(c.b * fps))})).filter((c) => c.b > c.a).sort((p, q) => p.a - q.a);
  const out: {a: number; b: number}[] = [];
  for (const c of cs) { const l = out[out.length - 1]; if (l && c.a <= l.b) l.b = Math.max(l.b, c.b); else out.push({...c}); }
  return out;
}
/** the kept pieces: uncut frames [src, src+len) play at output frames [out, out+len) */
export function vhSegments(total: number, fps: number): Seg[] {
  const segs: Seg[] = []; let src = 0, out = 0;
  for (const c of mergedCuts(total, fps)) { if (c.a > src) { segs.push({src, out, len: c.a - src}); out += c.a - src; } src = c.b; }
  if (total > src) segs.push({src, out, len: total - src});
  return segs.length ? segs : [{src: 0, out: 0, len: 1}];
}
/** the film's length in frames after the removed pieces */
export const vhDuration = (total: number, fps = 30) => Math.max(1, vhSegments(total, fps).reduce((n, s) => n + s.len, 0));
/** output frame → frame of the uncut film (for `keep` layers, e.g. music ducking under the voice) */
export function vhSrc(frame: number, fps = 30, total = 1e9) {
  const segs = vhSegments(total, fps);
  for (const s of segs) if (frame < s.out + s.len) return s.src + Math.max(0, frame - s.out);
  const l = segs[segs.length - 1]; return l.src + (frame - l.out);
}
const InCut = createContext(false);
/** the composition root: the uncut film minus the removed pieces (hard cuts); `keep` runs on through them.
 *  Nested uses (a composition shown inside another one) pass their children through. */
export const VhCut: React.FC<{total: number; keep?: React.ReactNode; children?: React.ReactNode}> = ({total, keep, children}) => {
  const nested = useContext(InCut);
  const {fps} = useVideoConfig();
  if (nested) return <>{children}</>;
  const segs = vhSegments(total, fps);
  const whole = segs.length === 1 && segs[0].src === 0 && segs[0].len >= total;
  return (
    <InCut.Provider value>
      {whole ? children : segs.map((s) => (
        <Sequence key={s.src} from={s.out} durationInFrames={s.len} premountFor={Math.round(fps)} name={`piece ${(s.src / fps).toFixed(2)} s`}>
          <Sequence from={-s.src} layout="none">{children}</Sequence>
        </Sequence>
      ))}
      {keep}
    </InCut.Provider>
  );
};

// ---------------------------------------------------------------- caption helpers
type Word = {text: string; s: number; e: number};
/** word times moved/stretched from the span [s0, e0] to [s1, e1] */
export function vhRetime<T extends Word>(words: T[], s0: number, e0: number, s1: number, e1: number): T[] {
  if (Math.abs(s1 - s0) < 1e-4 && Math.abs(e1 - e0) < 1e-4) return words;
  const k = (e1 - s1) / Math.max(1e-3, e0 - s0), m = (t: number) => s1 + (t - s0) * k;
  return words.map((w) => ({...w, s: m(w.s), e: m(w.e)}));
}
/** a retyped line: the same number of words keeps their times, else the new words share [s, e] by length */
export function vhRetext<T extends Word>(words: T[], text: string, s: number, e: number): T[] {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  if (parts.length === words.length) return words.map((w, i) => ({...w, text: parts[i]}));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  let t = s;
  return parts.map((p) => { const d = ((p.length + 1) / total) * (e - s), w = {...(words[0] || {}), text: p, s: t, e: t + d} as T; t += d; return w; });
}

// ---------------------------------------------------------------- the page side (VideoHub live preview)
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
if (typeof window !== 'undefined') {
  W.__VH_EDIT = {
    v: 1,
    get: () => E,
    ver: () => ver,
    subscribe,
    /** new edits from the hub: redraw; tells whether the cuts changed (the length changes: the page reloads) */
    set(next: unknown) {
      const before = JSON.stringify(E.cuts);
      E = norm(next); ver++;
      for (const f of [...subs]) try { f(); } catch { /* a listener of an old page */ }
      return {cutsChanged: JSON.stringify(E.cuts) !== before};
    },
    /** every element with its coded and edited values, the lanes in order, the cuts and the clip's speech */
    manifest() {
      const items = tracks.filter((t) => t.used()).flatMap((t) => { try { return t.all(); } catch (e) { return []; } });
      const lanes: {name: string; kind: VhKind}[] = [];
      for (const it of items) if (!lanes.some((l) => l.name === it.lane)) lanes.push({name: it.lane, kind: it.kind});
      let speech: [number, number, string][] = [];
      try { speech = clip ? clip.speech() : []; } catch { speech = []; }
      return {v: 1, lanes, items, cuts: E.cuts, splits: E.splits, clip: clip ? {lane: clip.lane, label: clip.label, speech} : null};
    },
  };
}
