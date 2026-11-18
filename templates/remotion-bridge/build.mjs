#!/usr/bin/env node
// VideoHub <-> Remotion bridge: turns one composition of a Remotion project into a VideoHub film that plays in
// VideoHub's live preview (no render). See README.md next to this file.
//
//   node build.mjs --project <Remotion project folder> --composition <id> [--name <film folder>] [--props '<json>']
//                  [--title "<title>"] [--entry src/index.ts] [--films <films folder>] [--copy-public] [--watch]
//   node build.mjs --name <film folder> [--watch]          rebuild with the settings saved in remotion-bridge.json
//   node build.mjs --name <film folder> --init-edit        also install the edit layer (src/vh-edit.tsx + src/vh-edits.json)
//
// What it does (the Remotion project itself is only read; the only files ever written into it are the edit layer's
// src/vh-edit.tsx (--init-edit) and src/vh-edits.json, which VideoHub's film editor writes when the user edits):
//   1. bundles the project with its own @remotion/bundler and remotion.config (Rspack / overrides kept), plus pre.js
//      and bridge.js around Remotion's renderEntry, into <film>/bundle (built next to it, then swapped in);
//   2. mirrors the project's public/ folder into <film>/node_modules/remotion-public as hard links (no extra disk
//      space; served through VideoHub's /media route, which supports the Range requests video seeking needs;
//      inside node_modules so VideoHub does not list the footage as versions of the film);
//   3. writes <film>/remotion-bridge.json (these settings) and <film>/.videohub/project.json (live page, timing).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// bundling is short but uses every core: below-normal priority keeps renders and editors running beside it smooth
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { }
const PRE = path.join(HERE, 'pre.js'), BRIDGE = path.join(HERE, 'bridge.js');

// ---- arguments
const argv = process.argv.slice(2), args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]; if (!a.startsWith('--')) continue;
  const k = a.slice(2), v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; }
}
const die = (msg) => { console.error('\n' + msg); process.exit(1); };
const slug = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'remotion-film';

const filmsDir = path.resolve(args.films || path.join(HERE, '..', '..', 'films'));
if (!fs.existsSync(filmsDir)) die(`Films folder not found: ${filmsDir}\nPass --films "<VideoHub workspace>\\films".`);
const name = args.name ? slug(args.name) : args.composition ? slug(args.composition) : die('Pass --project and --composition (first build) or --name (rebuild).');
const filmDir = path.join(filmsDir, name);
const savedFile = path.join(filmDir, 'remotion-bridge.json');
const saved = fs.existsSync(savedFile) ? JSON.parse(fs.readFileSync(savedFile, 'utf8')) : {};
const settings = {
  project: args.project ? path.resolve(args.project) : saved.project,
  composition: args.composition || saved.composition,
  props: args.props ? JSON.parse(args.props) : saved.props || {},
  entry: args.entry || saved.entry || null,
  title: args.title || saved.title || null,
  scenes: saved.scenes || null,
  premountSeconds: saved.premountSeconds ?? null,
  edit: !!(args['init-edit'] || saved.edit),   // the film uses the edit layer (vh-edit.tsx): VideoHub's film editor works on it
};
if (!settings.project || !settings.composition) die('Missing --project or --composition (and no saved remotion-bridge.json in ' + filmDir + ').');
const projectDir = settings.project;
if (!fs.existsSync(path.join(projectDir, 'package.json'))) die('Not a Remotion project (no package.json): ' + projectDir);
const inside = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
if (inside(filmDir, projectDir) || inside(projectDir, filmDir) || path.resolve(filmDir) === path.resolve(projectDir)) die('The film folder and the Remotion project must be separate folders.');

// ---- the project's own Remotion packages (same versions it renders with)
const req = createRequire(path.join(projectDir, 'package.json'));
let bundlerMain, cliMain;
try { bundlerMain = req.resolve('@remotion/bundler'); cliMain = req.resolve('@remotion/cli'); req.resolve('@remotion/player'); }
catch { die(`The project's node_modules lacks @remotion/bundler, @remotion/cli or @remotion/player.\nRun "npm install" in ${projectDir} (add @remotion/player at the project's Remotion version if it is missing).`); }
const breq = createRequire(bundlerMain), creq = createRequire(cliMain);
const { bundle } = breq(bundlerMain);
const projectModules = fs.realpathSync(path.join(projectDir, 'node_modules'));
const remotionVersion = req('remotion/package.json').version;

// ---- the project's remotion.config (Rspack, bundler overrides, entry point, public dir, premount)
const cliDist = path.dirname(cliMain);
const { ConfigInternals } = creq(path.join(cliDist, 'config', 'index.js'));
const { BrowserSafeApis } = creq('@remotion/renderer/client');
const configFile = ['remotion.config.ts', 'remotion.config.js'].find((f) => fs.existsSync(path.join(projectDir, f)));
if (configFile) {
  try { await creq(path.join(cliDist, 'load-config.js')).loadConfigFile(projectDir, configFile, configFile.endsWith('.js')); }
  catch (e) { console.warn(`Warning: could not load ${configFile} (${e.message}); bundling with Remotion's defaults.`); }
}
const opt = (o, fallback) => { try { const v = o.getValue({ commandLine: {} }).value; return v ?? fallback; } catch { return fallback; } };
const rspack = !!opt(BrowserSafeApis.options.rspackOption, false);
const publicDir = path.resolve(projectDir, opt(BrowserSafeApis.options.publicDirOption, null) || 'public');
if (settings.premountSeconds == null) { const pm = opt(BrowserSafeApis.options.defaultPremountInSecondsOption, null); if (pm != null) settings.premountSeconds = pm; }
const candidates = ['src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.mjs', 'remotion/index.tsx', 'remotion/index.ts', 'remotion/index.js', 'src/remotion/index.tsx', 'src/remotion/index.ts', 'src/remotion/index.js'];
const entry = path.resolve(projectDir, settings.entry || ConfigInternals.getEntryPoint?.() || candidates.find((c) => fs.existsSync(path.join(projectDir, c))) || die('No entry point found; pass --entry src/index.ts'));
if (!fs.existsSync(entry)) die('Entry point not found: ' + entry);
const id = (fn, d) => (typeof fn === 'function' ? fn : d);
const projWebpack = id(ConfigInternals.getWebpackOverrideFn?.(), (c) => c);
const projRspack = id(ConfigInternals.getRspackOverrideFn?.(), (c) => c);
const projBundler = id(ConfigInternals.getBundlerOverrideFn?.(), (c) => c);

// ---- the edit layer: src/vh-edit.tsx (VideoHub's, refreshed from this template with --init-edit) + src/vh-edits.json
// (the user's edits; created empty, never overwritten). The film imports both; see vh-edit.tsx and README.md.
const EDIT_SRC = path.join(HERE, 'vh-edit.tsx'), EDIT_FILE = 'src/vh-edits.json';
if (settings.edit) {
  const helper = path.join(projectDir, 'src', 'vh-edit.tsx'), data = path.join(projectDir, EDIT_FILE);
  const want = fs.readFileSync(EDIT_SRC, 'utf8');
  let have = ''; try { have = fs.readFileSync(helper, 'utf8'); } catch { }
  if (have !== want) {
    if (have && !args['init-edit']) console.log('Note: src/vh-edit.tsx differs from the bridge\'s copy; run with --init-edit to update it.');
    else { fs.writeFileSync(helper, want); console.log((have ? 'Updated ' : 'Installed ') + helper); }
  }
  if (!fs.existsSync(data)) { fs.writeFileSync(data, JSON.stringify({ v: 1, items: {}, cuts: [], splits: [] }, null, 1) + '\n'); console.log('Created ' + data); }
}
settings.editsFile = settings.edit ? EDIT_FILE : null;
settings.publicDir = publicDir;

// pre.js right before Remotion's renderEntry, bridge.js right after it; packages of bridge.js from the project
function addBridge(config) {
  const list = Array.isArray(config.entry) ? config.entry : null;
  const at = list ? list.findIndex((e) => /renderEntry/.test(String(e))) : -1;
  if (at < 0) throw new Error('Unexpected Remotion bundler config (no renderEntry in config.entry); this bridge was made for Remotion 4.0.5xx.');
  list.splice(at, 0, PRE); list.splice(at + 2, 0, BRIDGE);
  config.resolve = config.resolve || {};
  config.resolve.modules = [...(config.resolve.modules || ['node_modules']), projectModules];
  return config;
}

// ---- 1. public/ → hard links (served by VideoHub's /media route)
const mirror = path.join(filmDir, 'node_modules', 'remotion-public');
function syncTree(src, dest, st) {
  fs.mkdirSync(dest, { recursive: true });
  const want = new Set();
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.DS_Store') continue;
    want.add(e.name);
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    let real = s; if (e.isSymbolicLink()) { try { real = fs.realpathSync(s); } catch { continue; } }
    const ss = fs.statSync(real, { bigint: true });
    if (ss.isDirectory()) { syncTree(real, d, st); continue; }
    if (!ss.isFile()) continue;
    let ds = null; try { ds = fs.lstatSync(d, { bigint: true }); } catch { }
    if (ds && ds.isFile() && ds.ino === ss.ino && ds.dev === ss.dev) { st.same++; continue; }
    if (ds) fs.rmSync(d, { recursive: true, force: true });   // an entry of our own mirror, never a project file
    try { fs.linkSync(real, d); st.linked++; }
    catch (err) {
      if (!args['copy-public']) die(`Could not hard-link ${real} into the film (${err.code}). The film and the project must be on the same drive; or pass --copy-public to copy public/ instead (uses disk space).`);
      fs.copyFileSync(real, d); st.copied++;
    }
  }
  for (const n of fs.readdirSync(dest)) if (!want.has(n)) { fs.rmSync(path.join(dest, n), { recursive: true, force: true }); st.removed++; }
}
function syncPublic() {
  const st = { linked: 0, same: 0, copied: 0, removed: 0 };
  if (fs.existsSync(publicDir)) syncTree(publicDir, mirror, st); else fs.mkdirSync(mirror, { recursive: true });
  console.log(`public/ mirror: ${st.linked} linked, ${st.same} unchanged${st.copied ? `, ${st.copied} copied` : ''}${st.removed ? `, ${st.removed} removed` : ''}`);
}

// ---- 2. bundle → <film>/node_modules/.bundle-next → swapped in as <film>/bundle
const bundleDir = path.join(filmDir, 'bundle'), next = path.join(filmDir, 'node_modules', '.bundle-next'), old = path.join(filmDir, 'node_modules', '.bundle-old');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rename(a, b) { for (let i = 0; ; i++) { try { fs.renameSync(a, b); return; } catch (e) { if (i >= 20) throw e; await sleep(250); } } }
const live = { page: 'bundle/index.html' };
function pageHtml(html) {
  const media = '/media?p=' + encodeURIComponent(mirror);
  const vh = { composition: settings.composition, props: settings.props, scenes: settings.scenes, premountSeconds: settings.premountSeconds, live, remotion: remotionVersion, project: projectDir, edit: settings.edit };
  const inject = [
    '<!-- VideoHub film page: window.renderOut(t) and window.READY are defined by the VideoHub Remotion bridge (bridge.js inside bundle.js). Made by build.mjs; do not edit, rebuild instead. -->',
    '<style>html,body{margin:0;padding:0;overflow:hidden;background:#000}</style>',
    `<script>window.VH_REMOTION = ${JSON.stringify(vh).replace(/</g, '\\u003c')};</script>`,
    `<script>window.remotion_inputProps = ${JSON.stringify(JSON.stringify(settings.props)).replace(/</g, '\\u003c')};</script>`,
    `<script>window.remotion_staticBase = ${JSON.stringify(media)}; window.remotion_staticFiles = [];</script>`,
  ].join('\n\t\t');
  if (!html.includes('<div id="video-container">')) throw new Error('Unexpected Remotion index.html (no #video-container)');
  return html.replace('<div id="video-container">', inject + '\n\t\t<div id="video-container">');
}
let lastPct = -1;
async function build() {
  const t0 = Date.now();
  fs.mkdirSync(path.join(filmDir, 'node_modules'), { recursive: true });
  syncPublic();
  fs.rmSync(next, { recursive: true, force: true });
  console.log(`Bundling ${path.relative(projectDir, entry)} of ${projectDir} (Remotion ${remotionVersion}, ${rspack ? 'Rspack' : 'Webpack'}) …`);
  await bundle({
    entryPoint: entry, rootDir: projectDir, outDir: next,
    publicDir: path.join(filmDir, 'node_modules', '.no-public'),   // nothing copied: public/ is the hard-link mirror
    publicPath: './', enableCaching: false, rspack,
    webpackOverride: async (c) => addBridge(await projWebpack(c)),
    rspackOverride: async (c) => addBridge(await projRspack(c)),
    bundlerOverride: projBundler,
    onProgress: (p) => { const q = Math.floor(p / 10) * 10; if (q !== lastPct) { lastPct = q; process.stdout.write(`  ${q}%`); } },
    askAIEnabled: false, keyboardShortcutsEnabled: false, interactivityEnabled: false, gitSource: null,
  });
  process.stdout.write('\n');
  const index = path.join(next, 'index.html');
  fs.writeFileSync(index, pageHtml(fs.readFileSync(index, 'utf8')));
  fs.rmSync(path.join(next, 'public'), { recursive: true, force: true });   // the empty public/ the bundler made
  fs.writeFileSync(path.join(next, '.vh-remotion-bridge'), new Date().toISOString() + '\n');
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(bundleDir)) {
    if (!fs.existsSync(path.join(bundleDir, '.vh-remotion-bridge'))) die(bundleDir + ' exists but was not made by this bridge; move it away first.');
    await rename(bundleDir, old);
  }
  await rename(next, bundleDir);
  // a renamed folder reports no file change to VideoHub's watcher: rewrite the page so an open preview reloads
  const page = path.join(bundleDir, 'index.html'); fs.writeFileSync(page, fs.readFileSync(page));
  fs.rmSync(old, { recursive: true, force: true });
  console.log(`Bundle ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${bundleDir}`);
}

// ---- 3. film settings + VideoHub project file
// files are written only when they change: VideoHub reloads an open preview when a .json file of the film changes
const writeIfChanged = (f, text) => { if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== text) fs.writeFileSync(f, text); };
function writeFilm() {
  writeIfChanged(savedFile, JSON.stringify({ ...settings, remotion: remotionVersion, builtWith: 'build.mjs (VideoHub Remotion bridge)' }, null, 1) + '\n');
  const metaFile = path.join(filmDir, '.videohub', 'project.json');
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, '')); } catch { }
  meta.title = meta.title || settings.title || `${settings.composition} (Remotion)`;
  meta.status = meta.status || 'in-progress';
  meta.live = { ...(meta.live || {}), ...live };   // fps/dur: filled in by the page itself the first time it plays
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  writeIfChanged(metaFile, JSON.stringify(meta, null, 1) + '\n');
}
async function tellHub() {
  try { await fetch('http://127.0.0.1:' + (process.env.VIDEOHUB_PORT || 7788) + '/api/scan?soft=1', { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch { }
}

fs.mkdirSync(filmDir, { recursive: true });
writeFilm();
await build();
await tellHub();
console.log(`\nFilm: ${filmDir}\nOpen it in VideoHub (its card on the Projects page, or hub_live({project: "${filmDir.replace(/\\/g, '\\\\')}"})).`);

// ---- --watch: rebuild when the project's code changes, re-link public/ when its files change
if (args.watch) {
  const roots = [path.join(projectDir, 'src'), publicDir].filter((d) => fs.existsSync(d));
  const mtimes = new Map(), since = Date.now();
  const changed = (f) => { let m; try { m = fs.statSync(f).mtimeMs; } catch { return true; } const prev = mtimes.has(f) ? mtimes.get(f) : since; mtimes.set(f, m); return m > prev; };   // Windows reports reads too
  let timer = 0, busy = false, again = { code: false, pub: false };
  const run = async () => {
    if (busy) { timer = setTimeout(run, 1000); return; }
    busy = true; const w = again; again = { code: false, pub: false };
    try { if (w.code) await build(); else if (w.pub) syncPublic(); } catch (e) { console.error('Rebuild failed:', e.message); }
    busy = false;
  };
  for (const root of roots) {
    fs.watch(root, { recursive: true }, (ev, file) => {
      if (!file || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(file)) return;
      if (/(^|[\\/])vh-edits\.json$/i.test(file)) return;   // the film editor's saves: the open preview applies them itself
      if (!changed(path.join(root, file))) return;
      if (root === publicDir) again.pub = true; else again.code = true;
      clearTimeout(timer); timer = setTimeout(run, 1200);
    });
  }
  for (const f of [configFile, 'package.json'].filter(Boolean)) fs.watchFile(path.join(projectDir, f), { interval: 2000 }, () => { console.log(f + ' changed: restart build.mjs to pick it up.'); });
  console.log('Watching ' + roots.join(' and ') + ' (Ctrl+C to stop). VideoHub reloads the preview after each rebuild.');
}
