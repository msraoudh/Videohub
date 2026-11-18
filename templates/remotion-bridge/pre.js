// VideoHub <-> Remotion bridge, part 1 of 2 (build.mjs puts it in the bundle right BEFORE Remotion's renderEntry).
//
// A Remotion bundle opened in a normal browser mounts the read-only Remotion Studio. renderEntry skips that when it
// believes it runs in the headless render browser, which it detects through window.remotion_puppeteerTimeout.
// Set the flag for that one moment; bridge.js (right AFTER renderEntry) removes it again before anything renders,
// so the composition later runs as an ordinary browser preview (Player environment), not as a render.
if (typeof window !== 'undefined' && typeof window.remotion_puppeteerTimeout === 'undefined') {
  window.remotion_puppeteerTimeout = 30000;
  window.__vhHeadlessShim = true;
}
