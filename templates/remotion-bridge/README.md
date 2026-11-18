# Remotion → VideoHub bridge

Plays a Remotion composition in VideoHub's **live preview** (no render): seek, frame-step, play with the
composition's own sound, leave notes. Made for Remotion 4.0.5xx (tested with 4.0.535). Windows, Node 22+.

## Make a film from a Remotion project

```
node "%USERPROFILE%\Documents\VideoHub\templates\remotion-bridge\build.mjs" --project "<Remotion project folder>" --composition <CompositionId> --name <film-folder-name>
```

Example (the test film made with this bridge):

```
node "%USERPROFILE%\Documents\VideoHub\templates\remotion-bridge\build.mjs" --project "C:\path\to\my-film\remotion" --composition MyComposition --name my-film
```

Then open the film in VideoHub: its card on the Projects page, or `hub_live({project: "<film-folder-name>"})`
(shell: `node <VideoHub>\server\cli.js hub_live "{\"project\":\"<film-folder-name>\"}"`).

Options:

| Option | Meaning |
|---|---|
| `--props '{"hq":false}'` | input props (merged over the composition's defaultProps, calculateMetadata runs with them) |
| `--title "…"` | title on the VideoHub card (first build only; later change it in VideoHub) |
| `--entry src/index.ts` | entry point, when it is not the Remotion default (`src/index.ts`, …, or `Config.setEntryPoint`) |
| `--watch` | stay running: rebuild when `src/` changes (≈5–30 s), re-link when `public/` changes; the open preview reloads by itself |
| `--films <folder>` | another films folder (default: `..\..\films` next to this folder) |
| `--copy-public` | copy `public/` instead of hard-linking it (only when the film and the project are on different drives) |

**Rebuild** after the project changed (settings are saved in the film's `remotion-bridge.json`):

```
node "%USERPROFILE%\Documents\VideoHub\templates\remotion-bridge\build.mjs" --name <film-folder-name> [--watch]
```

## What it makes (`<workspace>\films\<name>\`)

- `bundle\` — `remotion bundle` output of the project (its own `@remotion/bundler`, `remotion.config.ts` with Rspack and
  overrides), plus `pre.js` / `bridge.js` around Remotion's `renderEntry`. Built in `node_modules\.bundle-next`, then
  swapped in, so an open preview never sees a half-built bundle.
- `node_modules\remotion-public\` — the project's `public\` as **hard links** (no extra disk space). Served through
  VideoHub's `/media` route, which answers the Range requests that video seeking needs. It sits in `node_modules`
  so VideoHub does not list the footage as videos of the film.
- `remotion-bridge.json` — project, composition, props (used by rebuilds). Optional `"scenes": [{name, t0, t1}]` adds a
  scene lane to VideoHub's timeline.
- `.videohub\project.json` — `live.page = bundle/index.html`; the page itself writes `live.fps` / `live.dur` the first
  time it plays.

The Remotion project is only read (no cache, no `build\` folder, no `.gitignore` change), except the edit layer: `src/vh-edit.tsx` (`--init-edit`), `src/vh-edits.json` (VideoHub's film editor) and `public/vh-sfx/` (SFX the user picked from the library).

## How the bridge works

1. `pre.js` (before `renderEntry`) briefly sets `window.remotion_puppeteerTimeout`, so Remotion's `renderEntry` skips
   mounting the read-only Studio; `bridge.js` removes it right after.
2. `bridge.js` calls Remotion's own hooks the way the renderer does: `remotion_setBundleMode({type:'evaluation'})`,
   finds the composition in `Internals.compositionsRef`, resolves it with `remotion_calculateComposition()`
   (calculateMetadata included).
3. The composition is mounted in `@remotion/player` at its exact size (scale 1). This is Remotion's browser-preview
   environment: `<Audio>` (also `@remotion/media`), volume curves and `<OffthreadVideo>` behave as in Remotion Studio.
4. `window.renderOut(t)` → frame `floor(t × fps)` (VideoHub's frame numbering), `seekTo` inside `flushSync`, so the
   React tree shows that frame when the call returns (`<video>` pixels follow a few ms later).
   When VideoHub plays in real time (1×), the bridge lets the Player play natively (smooth video, the composition's
   own sound) and only corrects drift above 0.5 s; when the calls stop (pause) it pauses and lands on VideoHub's frame.
5. `window.READY` after frame 0, fonts and every `delayRender()` handle are settled; `window.VH_CONFIG` gives VideoHub
   the composition's fps, length and size.

## Edit layer: the user edits the film in VideoHub (🎬 Edit film)

`node build.mjs --name <film> --init-edit` installs `src/vh-edit.tsx` (this folder's copy; run it again to update) and
an empty `src/vh-edits.json` in the Remotion project, and remembers `edit: true`. The film then builds its editable
elements through the helper (`vhList`, `vhOne`, `vhClip`, `<Vh of>`, `<VhCut>`, `vhDuration` in Root's
`calculateMetadata`); the full recipe is in the VideoHub repo's `docs/PROJECT-CONTRACT.md` §5.6 and at the top of
`vh-edit.tsx`.

- VideoHub writes the user's changes into `src/vh-edits.json` (overrides keyed by element id; timings are deltas).
  Remotion Studio and every render read it as bundled; the open preview gets each change from VideoHub at once
  (`window.__VH_EDIT.set`, no rebuild; a cut reloads the page since the film's length changes). `--watch` ignores it.
- The bridge page fetches the newest edits from the hub before it resolves the composition (`/api/project/<id>/film-edits`),
  so a reload shows them even when the bundle is older.
- Replaced SFX are copied into the project's `public/vh-sfx/` and hard-linked into the film's public mirror.
- Claude: read `src/vh-edits.json` before changing such a film, keep element ids stable, never drop the user's entries.

## Limits

- Sound comes from the page, not from an audio file: VideoHub shows "sound: none" and its sound-layer tools (channels,
  added sounds) do not act on it; its master volume / mute do (they go to the Player). With the edit layer the film's
  sound is edited in 🎬 Edit film. At other speeds than 1× the preview shows frames without sound.
- During playback the picture can run ~0.1–0.3 s behind VideoHub's cursor (picture and sound stay together);
  paused frames and frame steps are exact.
- Note pictures and live covers: VideoHub copies only `<canvas>` pixels, and a Remotion composition is mostly HTML,
  so those pictures come out black. The note's time, frame, text and drawing are kept.
- No render from VideoHub for these films (no `render.js`); render with Remotion when you decide to.
- A background (hidden) VideoHub tab gets ~1 animation frame per second, so it plays in jumps; that is the browser.

## Remove a film

Delete its folder in `<workspace>\films` (the hard links in `node_modules\remotion-public` do not touch the
project's files).
