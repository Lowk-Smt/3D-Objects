#!/usr/bin/env node
/* ============================================================
   REAL-CRATE BENCHMARK — runs the shipping optimizer core
   (public/vault/optimizer-core.mjs, the exact module the browser loads)
   over the deterministic crate fixture and reports what every preset
   actually achieves: bytes in/out, triangle counts, texture counts
   and per-stage timings.

   The fixture is a build artifact (fixtures/, gitignored); it is rebuilt
   automatically when missing, or with --rebuild.

   Usage:
     node scripts/benchmark-optimizer.mjs                 # all presets
     node scripts/benchmark-optimizer.mjs --preset=small  # one preset
     node scripts/benchmark-optimizer.mjs --rebuild       # regenerate first
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebIO } from '@gltf-transform/core';

import { optimizeGlbBytes, inspectDocument } from '../public/vault/optimizer-core.mjs';
import { buildCrateGlb } from './lib/crate-fixture.mjs';
import { createHeadlessTextureStrategy } from './lib/headless-textures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturesDir = path.join(root, 'fixtures');
const fixtureFile = path.join(fixturesDir, 'crate.glb');
const resultsFile = path.join(fixturesDir, 'benchmark-results.json');

const args = process.argv.slice(2);
const requested = (args.find(a => a.startsWith('--preset=')) || '').split('=')[1];
const presets = requested ? requested.split(',').filter(Boolean) : ['high', 'balanced', 'small'];
const rebuild = args.includes('--rebuild');

const mb = bytes => (bytes / 1024 / 1024).toFixed(2);
const shrink = (from, to) => `${(100 - (to / from) * 100).toFixed(1)}% smaller`;

if (rebuild || !fs.existsSync(fixtureFile)) {
  const { glb, stats } = buildCrateGlb();
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(fixtureFile, glb);
  console.log(`fixture ${path.relative(root, fixtureFile)} — ${mb(stats.byteLength)} MB `
    + `(${stats.shellTriangles.toLocaleString('en-US')} triangles)\n`);
}

const original = new Uint8Array(fs.readFileSync(fixtureFile));
const headless = createHeadlessTextureStrategy();
const io = new WebIO();

const rows = [];
for (const presetKey of presets) {
  const timings = {};
  const started = performance.now();
  const result = await optimizeGlbBytes(original, {
    preset: presetKey,
    resizeTexture: (texture, limits) => headless.resize(texture, limits),
    timeStage: async (label, run) => {
      const stageStart = performance.now();
      const value = await run();
      timings[label] = Math.round((performance.now() - stageStart) * 10) / 10;
      return value;
    },
  });
  const wall = Math.round((performance.now() - started) * 10) / 10;

  const outFile = path.join(fixturesDir, `crate.${presetKey}.glb`);
  fs.writeFileSync(outFile, result.glb);

  const after = inspectDocument(await io.readBinary(result.glb));

  rows.push({
    preset: presetKey,
    inputBytes: original.byteLength,
    outputBytes: result.byteLength,
    shrink: shrink(original.byteLength, result.byteLength),
    wallMs: wall,
    stages: timings,
    trianglesBefore: result.work.triangleCount,
    trianglesAfter: after.triangleCount,
    texturesBefore: result.work.textureCount,
    texturesAfter: after.textureCount,
    output: path.relative(root, outFile),
  });
}

console.log('real crate benchmark — optimizer core (dual-path textures, headless PNG path)\n');
console.log('preset     input     output    shrink         wall     triangles           textures');
for (const row of rows) {
  console.log(
    `${row.preset.padEnd(10)}`
    + `${mb(row.inputBytes).padStart(6)} MB  ${mb(row.outputBytes).padStart(6)} MB  `
    + `${row.shrink.padEnd(13)} ${String(row.wallMs + 'ms').padStart(8)}  `
    + `${String(row.trianglesBefore.toLocaleString('en-US')).padStart(8)} → ${String(row.trianglesAfter.toLocaleString('en-US')).padEnd(9)} `
    + `${row.texturesBefore} → ${row.texturesAfter}`,
  );
}

console.log('\nper-stage timings (ms)');
for (const row of rows) {
  const stages = Object.entries(row.stages).map(([label, ms]) => `${label}=${ms}`).join('  ');
  console.log(`  ${row.preset.padEnd(10)} ${stages}`);
}

fs.writeFileSync(resultsFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
console.log(`\nwrote ${path.relative(root, resultsFile)}`);

const grew = rows.filter(row => row.outputBytes >= row.inputBytes);
if (grew.length) {
  console.error(`\nFAIL: ${grew.map(r => r.preset).join(', ')} did not shrink the fixture`);
  process.exitCode = 1;
}
