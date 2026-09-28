import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Integration guards for the worker-backed wireframe overlay.
//
// app.js is browser-only (DOM + three.js), so this file pins the contract by
// inspecting the shipped source: the render/thumbnail accounting the project
// already relies on, plus the worker lifecycle rules (cache reuse, teardown,
// stale-result protection, blob URL tracking, synchronous fallback limits).

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const appPath = path.join(root, 'public', 'vault', 'app.js');
const workerPath = path.join(root, 'public', 'vault', 'wireframe-worker.js');
const source = readFileSync(appPath, 'utf8');
const workerSource = readFileSync(workerPath, 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const importMap = JSON.parse(readFileSync(path.join(root, 'src', 'lib', 'vault-import-map.json'), 'utf8'));

/** Body of a top-level function: from its declaration to the next `\n}\n`. */
function fnBody(text, signature) {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = text.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `unterminated ${signature}`);
  return text.slice(start, end);
}

// ---------------------------------------------------------------------------
// Pinned three version — the reference used by the A/B tests must be the exact
// version the browser loads.
// ---------------------------------------------------------------------------

test('three and @types/three are pinned to exactly 0.169.0', () => {
  const all = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(all.three, '0.169.0');
  assert.equal(all['@types/three'], '0.169.0');
  assert.match(importMap.imports.three, /three@0\.169\.0\/build\/three\.module\.js/);
  assert.match(importMap.imports['three/addons/'], /three@0\.169\.0\/examples\/jsm\//);
});

// ---------------------------------------------------------------------------
// Render / thumbnail accounting (must not regress)
// ---------------------------------------------------------------------------

test('animate() has exactly one mixer.update(dt) and exactly one renderer.render(scene, camera)', () => {
  const animateStart = source.indexOf('function animate()');
  assert.notEqual(animateStart, -1);
  const animateEnd = source.indexOf('animate();', animateStart);
  assert.notEqual(animateEnd, -1);
  const body = source.slice(animateStart, animateEnd);

  assert.equal((body.match(/mixer\.update\(/g) || []).length, 1, 'exactly one mixer.update()');
  assert.equal((body.match(/renderer\.render\(scene, camera\)/g) || []).length, 1, 'exactly one renderer.render(scene, camera)');
});

test('captureThumb() has exactly one render and one toDataURL, and encode timing ends before return', () => {
  const body = fnBody(source, 'function captureThumb(');

  assert.equal((body.match(/renderer\.render\(/g) || []).length, 1, 'exactly one renderer.render()');
  assert.equal((body.match(/toDataURL\(/g) || []).length, 1, 'exactly one toDataURL()');

  const encodeStart = body.indexOf("perf.time('thumbnail:encode')");
  const encodeEnd = body.indexOf('encodeTimer.end()', encodeStart);
  const returnAt = body.indexOf('return dataUrl', encodeStart);
  assert.notEqual(encodeStart, -1, 'encode timing must exist');
  assert.notEqual(encodeEnd, -1, 'encode timing must be ended');
  assert.notEqual(returnAt, -1, 'captureThumb must return the data url');
  assert.ok(encodeEnd < returnAt, 'encode timing must end before captureThumb returns');

  // Nothing may be measured after the return in this function.
  assert.ok(
    body.indexOf('perf.time(', returnAt) === -1,
    'no timing may start after captureThumb returns'
  );
});

// ---------------------------------------------------------------------------
// Shared materials / cache ownership
// ---------------------------------------------------------------------------

test('wireframe materials are module-level shared singletons', () => {
  assert.match(source, /^const wireframeInvisibleMaterial = new THREE\.MeshBasicMaterial\(\{ colorWrite: false \}\);$/m);
  assert.match(source, /^const wireframeLineMaterial = new THREE\.LineBasicMaterial\(\{ color: 0x8fb4ff \}\);$/m);
  assert.match(source, /const WIREFRAME_SHARED_MATERIALS = new Set\(\[wireframeInvisibleMaterial, wireframeLineMaterial\]\);/);
});

test('model teardown never disposes a shared wireframe material', () => {
  const body = fnBody(source, 'function disposeTree(');
  assert.match(
    body,
    /!WIREFRAME_SHARED_MATERIALS\.has\(material\)/,
    'disposeTree must skip the shared wireframe materials'
  );
});

test('setWireframeLine caches the LineSegments on the mesh', () => {
  const body = fnBody(source, 'function setWireframeLine(');
  assert.match(body, /mesh\.userData\._wireLine = line;/);
  assert.match(body, /new THREE\.LineSegments\(geometry, wireframeLineMaterial\)/);
});

test('toggle-off keeps the cached geometry (no dispose) so ON/OFF/ON reuses it', () => {
  const body = fnBody(source, 'function detachWireframe(');
  assert.ok(!body.includes('dispose'), 'detachWireframe must not dispose the cached wireframe');
  assert.match(body, /obj\.remove\(obj\.userData\._wireLine\)/);
  assert.match(body, /obj\.material = obj\.userData\._origMaterial/);
});

test('cached edge geometries are released on teardown (but not on toggle-off)', () => {
  const body = fnBody(source, 'function disposeWireframeCache(');
  assert.match(body, /obj\.userData\._wireLine\.geometry\.dispose\(\)/);
  assert.match(body, /delete obj\.userData\._wireLine;/);
  const clear = fnBody(source, 'function clearModel()');
  assert.match(clear, /disposeWireframeCache\(current\);/);
});

test('the worker-capable setWireframeMode path never builds EdgesGeometry synchronously', () => {
  const body = fnBody(source, 'function setWireframeMode(');
  assert.ok(!body.includes('EdgesGeometry'), 'setWireframeMode must not call EdgesGeometry');
  assert.match(body, /if \(obj\.userData\._wireLine\) applyWireframe\(obj\);/, 'cached line is reused');
  assert.match(body, /detachWireframe\(obj\)/);
});

test('EdgesGeometry survives only in the synchronous fallback', () => {
  const occurrences = source.match(/new THREE\.EdgesGeometry\(/g) || [];
  assert.equal(occurrences.length, 1, 'exactly one EdgesGeometry construction site');
  const body = fnBody(source, 'function prepareWireframeEdgesSync(');
  assert.match(body, /new THREE\.EdgesGeometry\(mesh\.geometry, DEFAULT_THRESHOLD_ANGLE\)/);
  assert.match(source, /DEFAULT_THRESHOLD_ANGLE, WORKER_FILE_URL, buildWorkerPayload/);
});

test('the shaded model stays visible while edge preparation is pending', () => {
  const body = fnBody(source, 'function setWireframeMode(');
  // The material is only hidden once a cached line exists (applyWireframe);
  // there is no "pending" branch that swaps in the invisible material.
  assert.ok(
    !/mesh\(\)|wireframeInvisibleMaterial/.test(body),
    'setWireframeMode must not hide the shaded material itself'
  );
  const apply = fnBody(source, 'function applyWireframe(');
  assert.match(apply, /obj\.material = wireframeInvisibleMaterial;/);
  assert.match(apply, /obj\.userData\._wireLine/);
});

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

test('preparation starts as soon as a model loads', () => {
  const at = source.indexOf('prepareWireframe(object)');
  assert.notEqual(at, -1, 'openModel must start wireframe preparation');
  const currentAssignedAt = source.indexOf('current = object;');
  assert.ok(at > currentAssignedAt, 'preparation must start after the model becomes current');
  assert.match(source, /prepareWireframe\(object\)\.catch\(/, 'preparation failures must not break the preview');
});

test('the worker is constructed from a tracked, revocable Blob URL', () => {
  assert.match(source, /new Blob\(\[rewritten\], \{ type: 'text\/javascript' \}\)/);
  assert.match(source, /wireframeWorkerBlobUrl = URL\.createObjectURL\(/);
  assert.match(source, /new Worker\(url, \{ type: 'module' \}\)/);

  const revoke = fnBody(source, 'function revokeWireframeWorkerBlobUrl(');
  assert.match(revoke, /URL\.revokeObjectURL\(wireframeWorkerBlobUrl\)/);
  assert.match(revoke, /wireframeWorkerBlobUrl = null;/);

  // The blob module cannot resolve a relative specifier, so the worker's own
  // import is rewritten to the absolute URL it is served from.
  assert.match(source, /fetch\(WORKER_FILE_URL\)/);
  assert.ok(
    source.includes(String.raw`(from\s*['"])\.\/wireframe\.js(['"])/g`),
    "app.js must rewrite the worker's relative import to an absolute URL"
  );
  assert.match(source, /wireframeWorkerUrlPromise/);
});

test("app.js's worker import rewrite still matches wireframe-worker.js", () => {
  // Mirror the rewrite in app.js against the real worker file.
  const rewritten = workerSource.replace(
    /(from\s*['"])\.\/wireframe\.js(['"])/g,
    (_m, before, after) => `${before}https://example.test/vault/wireframe.js${after}`
  );
  assert.ok(
    !/from\s*['"]\.\/wireframe\.js/.test(rewritten),
    "the app's rewrite regex must match the worker's import"
  );
  assert.match(rewritten, /from\s*["']https:\/\/example\.test\/vault\/wireframe\.js["']/);
  assert.match(workerSource, /from '\.\/wireframe\.js'/);
});

test('worker messages use transferable ArrayBuffers', () => {
  assert.match(source, /const \{ message, transfer \} = buildWorkerPayload\(obj\.geometry, id\);/);
  assert.match(source, /worker\.postMessage\(message, transfer\)/);
  // The payload builder lives in the shared module so browser + tests agree.
  const shared = readFileSync(path.join(root, 'public', 'vault', 'wireframe.js'), 'utf8');
  assert.match(shared, /transfer\.push\(copy\.buffer\)/);
  assert.match(workerSource, /self\.postMessage\(\{ type: 'result', id, positions: edges \}, \[edges\.buffer\]\)/);
});

test('interleaved positions are packed to XYZ before the worker sees them', () => {
  const shared = readFileSync(path.join(root, 'public', 'vault', 'wireframe.js'), 'utf8');
  assert.match(shared, /export function packVertexPositions\(/);
  assert.match(shared, /const v = readVertex\(attr, i\);/, 'interleaved XYZ gathered via three.js read semantics');
  assert.ok(
    shared.includes('const copy = packVertexPositions(position).array.slice();'),
    'buildWorkerPayload must send packed XYZ'
  );
  // The worker must never have to deal with strides, offsets or normalization
  // (comments aside — it may explain why it does not).
  const workerCode = workerSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/stride/.test(workerCode), 'worker receives packed data only (no stride)');
  assert.ok(!/isInterleaved/.test(workerCode), 'worker receives packed data only (no interleaving)');
  assert.ok(!/denormalize/.test(workerCode), 'worker receives packed data only (no normalization)');
});

test('worker termination clears pending tasks and invalidates stale results', () => {
  const terminate = fnBody(source, 'function terminateWireframeWorker(');
  assert.match(terminate, /wireframeWorker\.terminate\(\)/);
  assert.match(terminate, /wireframeWorker = null;/);
  assert.match(terminate, /wireframePending\.clear\(\)/);

  const onMessage = fnBody(source, 'function onWireframeWorkerMessage(');
  assert.match(onMessage, /const task = wireframePending\.get\(message\.id\);/);
  assert.match(onMessage, /if \(!task\) return;/, 'a stale result must be ignored');
  assert.match(onMessage, /if \(task\.token !== previewToken\)\{/, 'a result for a replaced model must be ignored');
  assert.match(onMessage, /settleWireframeTask\(task\); \/\/ the model switched while in flight/);

  const clear = fnBody(source, 'function clearModel()');
  assert.match(clear, /terminateWireframeWorker\(\);/, 'model switch/clear must terminate the worker');
});

test('worker-level errors clean every pending task and allow a fresh worker later', () => {
  const onError = fnBody(source, 'function onWireframeWorkerError(');
  assert.match(onError, /Array\.from\(wireframePending\.values\(\)\)/);
  assert.match(onError, /terminateWireframeWorker\(\)/);
  assert.match(onError, /prepareWireframeEdgesSync\(task\.mesh\)/);

  // terminate() nulls the worker, so the next preparation constructs a new
  // one; only a construction-level failure disables workers permanently.
  assert.match(source, /if \(wireframeWorkerUnavailable\) return null;/);
  assert.match(source, /if \(!wireframeWorker\)\{/);
});

test('worker communication failures fall back to synchronous edges', () => {
  const prepare = fnBody(source, 'async function prepareWireframe(');
  assert.match(prepare, /if \(!url\)\{/, 'no worker support -> synchronous path');
  assert.match(prepare, /prepareWireframeEdgesSync\(obj\)/);
  assert.match(prepare, /Wireframe worker postMessage failed/);
  assert.match(prepare, /const token = previewToken;/);
  assert.match(prepare, /if \(token !== previewToken \|\| current !== root\)\{/);
  assert.match(prepare, /totalTimer\.end\('superseded'\)/);
});

// ---------------------------------------------------------------------------
// Performance instrumentation
// ---------------------------------------------------------------------------

test('preparation timing measures real completion, not queue time', () => {
  const body = fnBody(source, 'async function prepareWireframe(');

  // The reported preparation duration starts before anything is queued...
  const prepareTimerAt = body.indexOf('const totalTimer = perf.time(`wireframe:prepare:${currentModelName');
  assert.notEqual(prepareTimerAt, -1, 'preparation timer must exist');
  assert.ok(prepareTimerAt < body.indexOf('await wireframeWorkerUrlPromise'), 'timer starts at preparation start');

  // ...and ends only after every queued task has resolved.
  const awaitAt = body.indexOf('await Promise.all(completions)');
  const endAt = body.lastIndexOf('totalTimer.end(');
  assert.notEqual(awaitAt, -1, 'preparation must await all task completions');
  assert.notEqual(endAt, -1, 'preparation timer must be ended');
  assert.ok(endAt > awaitAt, 'the preparation timer must end only after all tasks have actually completed');
  assert.match(body.slice(endAt), /totalTimer\.end\(`?\$\{completions\.length\} resolved`?\)/);

  // Queue/setup time is reported separately and must not be labelled as total.
  assert.match(body, /perf\.time\(`wireframe:queue:\$\{currentModelName/);
  assert.ok(
    body.indexOf('queueTimer.end(') < awaitAt,
    'the queue timer is the one that ends at queue time'
  );

  // Every terminal path settles its completion signal, so the await cannot hang.
  const completion = fnBody(source, 'function wireframeCompletion(');
  assert.match(completion, /settle\(\)\{/);
  assert.match(completion, /if \(done\) return;/);
  const terminate = fnBody(source, 'function terminateWireframeWorker(');
  assert.match(terminate, /for \(const task of wireframePending\.values\(\)\) settleWireframeTask\(task\);/);
  const onMessage = fnBody(source, 'function onWireframeWorkerMessage(');
  assert.equal((onMessage.match(/settleWireframeTask\(task\)/g) || []).length, 3, 'all three outcomes settle');
});

test('no dangling wireframe capability identifier in the viewer', () => {
  // Guard for a real regression: setWireframeMode used to reference a
  // capability flag that had been removed, which threw at toggle time.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(
    !/wireframeWorkerSupported/.test(code),
    'setWireframeMode must not gate on a worker-capability flag; reachability is decided in getWireframeWorker()'
  );
});

test('wireframe instrumentation reports preparation, both clicks, and both render modes', () => {
  assert.match(source, /perf\.time\(`wireframe:prepare:\$\{currentModelName/);
  assert.match(source, /perf\.time\(`wireframe:queue:\$\{currentModelName/);
  assert.match(source, /perf\.time\(`wireframe:prepare-sync:\$\{currentModelName/);
  assert.match(source, /perf\.time\(wireframeOn \? 'wireframe:click-on' : 'wireframe:click-off'\)/);
  assert.match(source, /const renderMode = wireframeOn \? 'wireframe' : 'normal';/);
  assert.match(source, /console\.debug\(`\[perf\] render:\$\{renderMode\}/);
  // The pre-existing render instrumentation is untouched.
  assert.match(source, /\[perf\] render:first/);
  assert.match(source, /\[perf\] render:slow-frame/);
  assert.match(source, /renderDuration >= 50/);
});

test('no guaranteed-FPS / sub-millisecond performance claims in the viewer', () => {
  assert.ok(!/<0\.1\s*ms/i.test(source), 'no unproven sub-millisecond claim');
  assert.ok(!/\bguaranteed\s+fps\b/i.test(source), 'no guaranteed FPS claim');
});
