// VideoHub <-> Remotion bridge, part 2 of 2 (build.mjs puts it in the bundle right AFTER Remotion's renderEntry).
//
// Turns a Remotion bundle into a VideoHub film page (docs/PROJECT-CONTRACT.md §2 in the VideoHub folder):
//   window.renderOut(t)  shows frame floor(t * fps) of the composition. The React tree is committed synchronously
//                        (flushSync), so the page shows that frame when the call returns; <video> pixels follow a few
//                        milliseconds later, exactly like scrubbing in Remotion Studio.
//   window.READY         true once the composition is mounted, its fonts are loaded and frame 0 is settled.
//   window.VH_CONFIG     {fps, duration, width, height}: VideoHub adopts the composition's timing and size.
//   window.VH_SCENES     optional scene lane (remotion-bridge.json "scenes": [{name, t0, t1}]).
// The composition runs inside @remotion/player (the browser-preview environment Remotion is built for), so it plays
// with its own sound: every <Audio> with its volume curves, like Remotion Studio. When VideoHub plays in real time
// the bridge lets the Player play natively; any other call (seek, frame step, note picture) pauses and seeks.
// Settings come from window.VH_REMOTION, written into bundle/index.html by build.mjs.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Internals } from 'remotion';
import { NoReactInternals } from 'remotion/no-react';
import { Player } from '@remotion/player';

// renderEntry has run (and skipped the Studio): from now on this is an ordinary browser page again
if (window.__vhHeadlessShim) { delete window.remotion_puppeteerTimeout; delete window.__vhHeadlessShim; }

const cfg = window.VH_REMOTION || {};
const box = document.createElement('div');
box.id = 'vh-remotion';
box.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;overflow:hidden;background:#000;z-index:10';
const note = document.createElement('div');
note.style.cssText = 'position:fixed;left:24px;top:24px;right:24px;z-index:20;font:28px/1.35 system-ui,sans-serif;color:#ddd;white-space:pre-wrap';
document.body.append(box, note);
const say = (text) => { note.textContent = text || ''; };
function fail(e) {
  const msg = 'Remotion bridge: ' + (e && e.message ? e.message : String(e));
  window.__vhError = msg; say(msg); note.style.color = '#ff8a80';
  console.error(msg, e);
}
const waitFor = (test, ms, what) => new Promise((ok, no) => {
  const t0 = performance.now();
  const tick = () => {
    let v; try { v = test(); } catch (e) { no(e); return; }
    if (v) { ok(v); return; }
    if (performance.now() - t0 > ms) { no(new Error('timed out waiting for ' + what)); return; }
    setTimeout(tick, 50);
  };
  tick();
});
const frames = (n) => new Promise((ok) => { const step = () => (n-- <= 0 ? ok() : requestAnimationFrame(step)); step(); });

async function main() {
  if (!cfg.composition) throw new Error('no composition id (window.VH_REMOTION.composition); rebuild with build.mjs');
  if (typeof window.remotion_setBundleMode !== 'function') throw new Error('this page is not a Remotion bundle (remotion_setBundleMode is missing)');
  say('Loading the Remotion composition ' + cfg.composition + '…');

  // 1. Evaluate the root exactly like the renderer does (bundle mode "evaluation"), then resolve the composition
  //    (calculateMetadata included) with Remotion's own remotion_calculateComposition().
  window.remotion_setBundleMode({ type: 'evaluation' });
  // 0. The edit layer (src/vh-edit.tsx, window.__VH_EDIT): the newest edits from the hub (the bundle carries the ones of
  //    its build) before the composition is resolved, since the removed pieces change its length.
  const pid = (location.pathname.match(/^\/live\/([0-9a-f]{12})\//) || [])[1];
  const edit = window.__VH_EDIT || null;
  if (edit && pid) {
    try { const r = await fetch(`/api/project/${pid}/film-edits`); const j = r.ok ? await r.json() : null; if (j && j.doc) edit.set(j.doc); }
    catch (e) { console.warn('Remotion bridge: could not load the film edits (' + e.message + '); showing the ones of the build'); }
  }
  const all = () => (Internals.compositionsRef && Internals.compositionsRef.current ? Internals.compositionsRef.current.getCompositions() : []);
  const comp = await waitFor(() => all().find((c) => c.id === cfg.composition), 30000, 'composition "' + cfg.composition + '"')
    .catch(() => { throw new Error('composition "' + cfg.composition + '" not found; this project has: ' + (all().map((c) => c.id).join(', ') || 'none')); });
  const meta = await window.remotion_calculateComposition(cfg.composition);
  const props = NoReactInternals.deserializeJSONWithSpecialTypes(meta.serializedResolvedPropsWithCustomSchema);
  const fps = meta.fps, W = meta.width, H = meta.height, N = meta.durationInFrames;
  window.VH_CONFIG = { fps, duration: N / fps, width: W, height: H, composition: cfg.composition };
  if (Array.isArray(cfg.scenes) && cfg.scenes.length) window.VH_SCENES = cfg.scenes;
  const fit = `margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden;background:#000`;
  document.documentElement.style.cssText = fit; document.body.style.cssText = fit;
  box.style.width = W + 'px'; box.style.height = H + 'px';

  // 2. Mount the composition in a Player of exactly the composition's size (scale 1, no controls of its own).
  const ref = React.createRef();
  const Comp = comp.component;   // the composition's lazy component
  // with the edit layer the film redraws when VideoHub sends new edits (window.__VH_EDIT.set), no reload
  const noSub = () => () => { }, zero = () => 0;
  const Film = (p) => { React.useSyncExternalStore(edit ? edit.subscribe : noSub, edit ? edit.ver : zero); return React.createElement(Comp, p); };
  const extra = cfg.premountSeconds != null ? { defaultPremountInSeconds: cfg.premountSeconds } : {};
  createRoot(box).render(React.createElement(Player, {
    ref, component: Film, inputProps: props, durationInFrames: N, fps, compositionWidth: W, compositionHeight: H,
    style: { width: W, height: H }, controls: false, clickToPlay: false, doubleClickToFullscreen: false,
    spaceKeyToPlayOrPause: false, moveToBeginningWhenEnded: false, allowFullscreen: false, showVolumeControls: false,
    loop: false, initialFrame: 0, errorFallback: () => null, ...extra,
  }));
  const p = await waitFor(() => ref.current, 30000, 'the Remotion player');
  p.addEventListener('error', (e) => fail(e.detail && e.detail.error ? e.detail.error : 'the composition threw an error'));

  // 3. renderOut(t): seek mode by default; real-time calls (VideoHub playing at 1x) hand the clock to the Player.
  const frameOf = (t) => Math.max(0, Math.min(N - 1, Math.floor((+t || 0) * fps + 1e-6)));
  const seek = (f) => { if (p.getCurrentFrame() !== f) flushSync(() => p.seekTo(f)); };
  // VideoHub calls renderOut once per animation frame while it plays; with a busy page that can drop to ~10 per second,
  // so "VideoHub paused" means: no call for 2.5x the longest recent gap (between 0.3 and 1 s).
  let lastT = null, lastAt = 0, streak = 0, idle = 0, lastFix = 0, want = 0, gaps = [];
  const settle = () => { idle = 0; streak = 0; gaps = []; if (p.isPlaying()) p.pause(); seek(want); };
  window.renderOut = function renderOut(t) {
    window.remotion_isPlayer = true;
    const now = performance.now(), f = frameOf(t);
    const dt = lastT === null ? NaN : (+t || 0) - lastT, dw = (now - lastAt) / 1000;
    lastT = +t || 0; lastAt = now; want = f;
    const realTime = dt > 0 && dw > 0 && dw < 1 && Math.abs(dt - dw) < Math.max(0.05, dw * 0.25);
    streak = realTime ? streak + 1 : 0;
    clearTimeout(idle);
    if (streak >= 3 && f < N - 1) {
      gaps.push(dw); if (gaps.length > 12) gaps.shift();
      if (!p.isPlaying()) { seek(f); p.play(); lastFix = now; }
      // the Player keeps its own clock (picture and sound together, ~0.1-0.3 s behind VideoHub's cursor after a start);
      // only a real drift (> 0.5 s, e.g. after buffering) is corrected, since every seek re-buffers the media
      else if (Math.abs(p.getCurrentFrame() - f) > Math.max(6, fps / 2) && now - lastFix > 1000) { p.seekTo(f); lastFix = now; }
      idle = setTimeout(settle, Math.min(1000, Math.max(300, 2500 * Math.max(...gaps))));   // VideoHub paused: land exactly on its frame
      return;
    }
    if (p.isPlaying()) p.pause();
    seek(f);
  };
  window.VH_BRIDGE = { player: p, frameOf, edit, fps, get frame() { return p.getCurrentFrame(); }, get playing() { return p.isPlaying(); },
    // VideoHub's master volume / mute act on the composition's own sound (the film has no separate audio file)
    setVolume(v) { try { p.setVolume(Math.max(0, Math.min(1, +v))); } catch { } }, setMuted(m) { try { m ? p.mute() : p.unmute(); } catch { } },
    // new edits: redraw this frame at once (flushSync); a change of the removed pieces needs a reload (new length)
    setEdits(doc) { if (!edit) return { ok: false }; let r; flushSync(() => { r = edit.set(doc); }); return { ok: true, ...r }; } };

  // 4. READY once frame 0 is settled, fonts are in and Remotion has no open delayRender() handle (max 20 s).
  seek(0);
  await document.fonts.ready;
  await waitFor(() => (window.remotion_delayRenderHandles || []).length === 0, 20000, 'delayRender handles')
    .catch((e) => console.warn('Remotion bridge: ' + e.message + ' — showing the film anyway'));
  await frames(2);
  say('');
  window.READY = true;

  // 5. Keep VideoHub's stored timing equal to the composition's (project.json → live.fps / live.dur).
  if (pid && cfg.live) {
    fetch(`/api/project/${pid}/live`).then((r) => (r.ok ? r.json() : null)).then((li) => {
      const dur = +(N / fps).toFixed(3);
      if (!li || !li.ok || (li.fps === fps && Math.abs(li.dur - dur) < 0.002)) return;
      return fetch(`/api/project/${pid}/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: { ...cfg.live, fps, dur } }) });
    }).catch(() => { });
  }
}

main().catch(fail);
