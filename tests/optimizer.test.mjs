import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";

import { Document, WebIO } from "@gltf-transform/core";
import { dedup, prune } from "@gltf-transform/functions";

/**
 * These tests pin down what the client-side optimizer in public/vault/app.js
 * is allowed to do to a model, using the same @gltf-transform version the
 * browser loads from the import map (4.5.0). They exist because the README
 * and the Optimize dialog make specific promises about names and metadata —
 * promises that must be verified, not assumed.
 *
 * The cleanup sequence below is a mirror of `optimizeGLBBlob()` in app.js.
 */

const GENERATOR_TAG = "Model Vault 1.0 (glTF-Transform)";

function readGlbJson(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  assert.equal(chunkType, 0x4e4f534a, "first GLB chunk should be JSON");
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
}

async function buildSourceDocument() {
  const doc = new Document();
  doc.getRoot().getAsset().generator = "Sketchfab-Exporter 3.1";
  doc.getRoot().getAsset().extras = { author: "someone", aiTool: "made-up" };
  doc.getRoot().setExtras({ vault: "original" });

  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);

  const barrelMaterial = doc
    .createMaterial("BarrelMaterial")
    .setBaseColorFactor([1, 0.5, 0.2, 1])
    .setExtras({ tool: "substance-painter" });
  // Same values, different name: must NOT be merged away by dedup().
  const lidMaterial = doc.createMaterial("LidMaterial").setBaseColorFactor([1, 0.5, 0.2, 1]);

  const texture = doc.createTexture("albedo").setImage(new Uint8Array([1, 2, 3])).setMimeType("image/png");
  barrelMaterial.setBaseColorTexture(texture);

  const barrelMesh = doc
    .createMesh("BarrelMesh")
    .addPrimitive(doc.createPrimitive().setAttribute("POSITION", position).setMaterial(barrelMaterial));
  const lidMesh = doc
    .createMesh("LidMesh")
    .addPrimitive(doc.createPrimitive().setAttribute("POSITION", position).setMaterial(lidMaterial));

  const named = doc.createNode("BarrelNode").setMesh(barrelMesh);
  const unnamed = doc.createNode().setMesh(lidMesh).setExtras({ from: "blender" });

  doc.createScene("Scene").addChild(named).addChild(unnamed);
  return doc;
}

/** The cleanup + tagging step from public/vault/app.js, verbatim. */
function cleanMetadata(document) {
  const asset = document.getRoot().getAsset();
  if (asset) {
    asset.generator = GENERATOR_TAG;
    delete asset.extras;
  }
  document.getRoot().setExtras({});

  const fallbackName = (prefix, i, existing) => (existing && existing.trim() ? existing : `${prefix}_${i}`);
  document.getRoot().listNodes().forEach((n, i) => { n.setName(fallbackName("node", i, n.getName())); n.setExtras({}); });
  document.getRoot().listMeshes().forEach((n, i) => { n.setName(fallbackName("mesh", i, n.getName())); n.setExtras({}); });
  document.getRoot().listMaterials().forEach((n, i) => { n.setName(fallbackName("material", i, n.getName())); n.setExtras({}); });
  document.getRoot().listTextures().forEach((n, i) => { n.setName(fallbackName("texture", i, n.getName())); n.setExtras({}); });
  document.getRoot().listScenes().forEach((n, i) => { n.setName(fallbackName("scene", i, n.getName())); n.setExtras({}); });
}

async function optimizeLikeTheApp() {
  const io = new WebIO();
  const document = await io.readBinary(await io.writeBinary(await buildSourceDocument()));
  await document.transform(dedup());
  await document.transform(prune());
  cleanMetadata(document);
  return readGlbJson(await io.writeBinary(document));
}

test("the installed glTF-Transform matches the version the browser loads", () => {
  // The import map in src/app/page.tsx pins the exact version the browser
  // uses; the devDependency must match, or these assertions could pass
  // while the real optimizer behaves differently.
  const installed = JSON.parse(
    fs.readFileSync(new URL("../node_modules/@gltf-transform/core/package.json", import.meta.url), "utf8"),
  ).version;
  const page = fs.readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.ok(
    page.includes(`@gltf-transform/core@${installed}`),
    `src/app/page.tsx does not pin @gltf-transform/core@${installed}`,
  );
  assert.ok(page.includes(`@gltf-transform/functions@${installed}`), "functions version drifted");
});

test("optimizing preserves every existing name", async () => {
  const json = await optimizeLikeTheApp();

  assert.deepEqual(json.nodes.map((n) => n.name), ["BarrelNode", "node_1"]);
  assert.deepEqual(json.meshes.map((m) => m.name), ["BarrelMesh", "LidMesh"]);
  assert.deepEqual(json.materials.map((m) => m.name), ["BarrelMaterial", "LidMaterial"]);
  assert.deepEqual(json.images.map((i) => i.name), ["albedo"]);
  assert.deepEqual(json.scenes.map((s) => s.name), ["Scene"]);
});

test("only properties that had no name get a placeholder", async () => {
  const json = await optimizeLikeTheApp();
  // The second node was created without a name; everything else was named.
  assert.equal(json.nodes[1].name, "node_1");
  for (const name of json.meshes.map((m) => m.name)) {
    assert.ok(!/^mesh_\d+$/.test(name), `${name} was renamed by the optimizer`);
  }
  for (const name of json.materials.map((m) => m.name)) {
    assert.ok(!/^material_\d+$/.test(name), `${name} was renamed by the optimizer`);
  }
});

test("tool metadata (extras) is really removed from the written file", async () => {
  const json = await optimizeLikeTheApp();

  assert.equal(json.extras, undefined);
  assert.equal(json.asset.extras, undefined);
  for (const collection of [json.nodes, json.meshes, json.materials, json.images ?? [], json.scenes]) {
    for (const entry of collection ?? []) {
      assert.equal(entry.extras, undefined, `${entry.name} still carries extras`);
    }
  }
});

test("the original exporter's generator string does not survive", async () => {
  const json = await optimizeLikeTheApp();
  assert.equal(json.asset.generator, GENERATOR_TAG);
  assert.ok(!JSON.stringify(json).includes("Sketchfab"), "the uploader's exporter string leaked into the result");
  assert.ok(!JSON.stringify(json).includes("substance-painter"), "material extras leaked into the result");
});

test("dedup does not merge properties that have different names", async () => {
  const json = await optimizeLikeTheApp();
  // BarrelMaterial and LidMaterial have identical values in the fixture.
  assert.equal(json.materials.length, 2);
  assert.deepEqual(json.materials.map((m) => m.name).sort(), ["BarrelMaterial", "LidMaterial"]);
});
