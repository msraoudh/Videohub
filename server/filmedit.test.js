import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, cleanOv, cleanCuts, normDoc, readDoc, bridgeOf } from './filmedit.js';

test('cleanOv keeps real changes and drops no-ops', () => {
  assert.equal(cleanOv({ ds: 0, k: 1, gain: 1 }), null);
  assert.deepEqual(cleanOv({ ds: 0.5, de: -0.00001, dx: 12.34, k: 1.5, ox: 540.4, oy: 960, gain: 0.5, off: true, text: 'Hi' }), { ds: 0.5, text: 'Hi', dx: 12.3, k: 1.5, ox: 540, oy: 960, gain: 0.5, off: true });
  // ox/oy only with a size; a base alone is no change
  assert.equal(cleanOv({ ox: 10, oy: 10, base: { s: 1 } }), null);
  // replacement sounds: a public path only
  assert.equal(cleanOv({ file: '../secret.wav' }), null);
  assert.equal(cleanOv({ file: '/abs.wav' }), null);
  assert.deepEqual(cleanOv({ file: 'vh-sfx/pop.wav', fdur: 0.4679, fname: 'Long pop' }), { file: 'vh-sfx/pop.wav', fdur: 0.4679, fname: 'Long pop' });
  assert.deepEqual(cleanOv({ duck: -80 }), { duck: -60 });
});

test('cuts are sorted, merged and cleaned', () => {
  assert.deepEqual(cleanCuts([{ a: 5, b: 6 }, { a: 1, b: 2 }, { a: 5.5, b: 7 }, { a: 3, b: 3.001 }, { a: 'x', b: 2 }]), [{ a: 1, b: 2 }, { a: 5, b: 7 }]);
});

test('applyPatch replaces one override whole, removes with null, keeps the rest', () => {
  const d0 = normDoc({ items: { a: { ds: 1 }, b: { text: 'x' } }, cuts: [{ a: 1, b: 2 }] });
  const d1 = applyPatch(d0, { items: { a: { gain: 2 }, b: null, c: { off: true } } });
  assert.deepEqual(d1.items, { a: { gain: 2 }, c: { off: true } });
  assert.deepEqual(d1.cuts, [{ a: 1, b: 2 }]);
  const d2 = applyPatch(d1, { cuts: [], splits: [3, 3, 1] });
  assert.deepEqual(d2.cuts, []);
  assert.deepEqual(d2.splits, [1, 3]);
});

test('readDoc: missing file is empty, broken JSON is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-fe-'));
  try {
    const f = path.join(dir, 'vh-edits.json');
    assert.deepEqual(readDoc(f).doc.items, {});
    fs.writeFileSync(f, '{"items": {');
    assert.throws(() => readDoc(f), /broken JSON/);
    fs.writeFileSync(f, JSON.stringify({ items: { 'chrome:OUTLOOK': { ds: 0.2 } } }));
    assert.deepEqual(readDoc(f).doc.items, { 'chrome:OUTLOOK': { ds: 0.2 } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bridgeOf finds the Remotion project and keeps the edits file inside it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-fe-'));
  try {
    const film = path.join(dir, 'film'), proj = path.join(dir, 'proj');
    fs.mkdirSync(film); fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    assert.equal(bridgeOf({ path: film }), null);
    fs.writeFileSync(path.join(film, 'remotion-bridge.json'), JSON.stringify({ project: proj, composition: 'X', edit: true, editsFile: 'src/vh-edits.json' }));
    const b = bridgeOf({ path: film });
    assert.equal(b.editsFile, path.join(proj, 'src', 'vh-edits.json'));
    assert.equal(b.publicDir, path.join(proj, 'public'));
    fs.writeFileSync(path.join(film, 'remotion-bridge.json'), JSON.stringify({ project: proj, editsFile: '../../x.json' }));
    assert.equal(bridgeOf({ path: film }).editsFile, path.join(proj, 'src', 'vh-edits.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
