#!/usr/bin/env node
/* Build the deterministic "real crate" benchmark asset (gitignored). */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCrateGlb } from './lib/crate-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'fixtures');
const outFile = path.join(outDir, 'crate.glb');

const { glb, stats } = buildCrateGlb();
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, glb);

const mb = bytes => (bytes / 1024 / 1024).toFixed(2);
console.log(`wrote ${path.relative(root, outFile)} — ${mb(stats.byteLength)} MB`);
console.log(`  geometry : ${stats.shellTriangles.toLocaleString('en-US')} shell triangles, plank grid ${stats.plankGrid}, ${stats.planksPerFace} planks/face`);
console.log(`  scene    : ${stats.nodes} nodes, ${stats.meshes} meshes (${stats.meshes - 2} redundant/unused), ${stats.materials} materials, ${stats.textures} textures`);
for (const image of stats.images) {
  console.log(`  texture  : ${image.name} ${image.width}x${image.height} — ${mb(image.bytes)} MB`);
}
