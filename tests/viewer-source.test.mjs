import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for: ReferenceError: wireframeOn is not defined
//   at clearModel (app.js) via openModel().
// The viewer keeps its model state as module-level `let` bindings. If the
// `wireframeOn` declaration is dropped during a refactor, every preview open
// throws before rendering. This pins the declarations in place without
// executing the browser-only viewer script.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(__dirname, "..", "public", "vault", "app.js");
const source = readFileSync(appJsPath, "utf8");

test("viewer declares module-level model state (current, previewToken, wireframeOn)", () => {
  for (const declaration of [
    /^let current = null;$/m,
    /^let previewToken = 0;$/m,
    /^let wireframeOn = false;$/m,
  ]) {
    assert.match(
      source,
      declaration,
      `public/vault/app.js must contain module-level declaration: ${declaration}`
    );
  }
});

test("wireframeOn is declared before its first use (no TDZ ReferenceError)", () => {
  const declaration = source.indexOf("let wireframeOn = false;");
  assert.notEqual(declaration, -1, "missing module-level `let wireframeOn = false;`");
  const firstUse = source.indexOf("wireframeOn", declaration + 1);
  // The first occurrence after the declaration text itself must not precede it.
  const earliestUse = Math.min(
    ...["if (wireframeOn)", "wireframeOn = false;", "wireframeOn = !wireframeOn"]
      .map((snippet) => source.indexOf(snippet))
      .filter((index) => index !== -1)
  );
  assert.ok(
    earliestUse > declaration,
    "wireframeOn must be declared before clearModel / wireBtn use it"
  );
  assert.ok(firstUse > declaration);
});

test("clearModel resets wireframe state (behavior preserved)", () => {
  const clearModel = source.slice(source.indexOf("function clearModel()"));
  assert.ok(clearModel.length > 0, "clearModel() must exist");
  const body = clearModel.slice(0, clearModel.indexOf("\n}\n") + 3);
  assert.match(body, /if \(wireframeOn\) setWireframeMode\(false\);/);
  assert.match(body, /wireframeOn = false;/);
  assert.match(body, /\$\('wireBtn'\)\.classList\.remove\('on'\);/);
});

test("wireframe toggle behavior is preserved", () => {
  assert.match(source, /\$\('wireBtn'\)\.addEventListener\('click'/);
  assert.match(source, /wireframeOn = !wireframeOn;/);
  assert.match(source, /setWireframeMode\(wireframeOn\);/);
});
