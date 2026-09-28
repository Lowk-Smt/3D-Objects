import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import vaultImportMap from '../src/lib/vault-import-map.json' with { type: 'json' };
import { buildCrateGlb } from '../scripts/lib/crate-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const chromiumInstalled = existsSync(chromium.executablePath());

function htmlPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><script type="importmap">${JSON.stringify(vaultImportMap)}</script></head>
<body>
  <input id="model" type="file" accept=".glb">
  <select id="preset"><option>high</option><option>balanced</option><option>small</option></select>
  <button id="upload">Optimize and upload</button><pre id="result"></pre>
  <script type="module">
    import { optimizeGLBBlob, shouldUseOptimized } from '/vault/optimizer-upload.mjs';
    const input = document.querySelector('#model');
    const preset = document.querySelector('#preset');
    const result = document.querySelector('#result');
    document.querySelector('#upload').addEventListener('click', async () => {
      try {
        const source = input.files[0];
        const optimized = await optimizeGLBBlob(source, () => {}, preset.value);
        const useOptimized = shouldUseOptimized(source.size, optimized.size);
        const uploadFile = useOptimized ? new File([optimized], source.name, { type: 'model/gltf-binary' }) : source;
        const response = await fetch('/__upload?preset=' + preset.value + '&optimized=' + useOptimized, {
          method: 'POST', body: uploadFile,
        });
        result.textContent = JSON.stringify({
          ok: response.ok, preset: preset.value, optimized: useOptimized,
          sourceBytes: source.size, optimizedBytes: optimized.size,
          uploadedBytes: Number(response.headers.get('x-uploaded-bytes')),
        });
      } catch (error) {
        result.textContent = JSON.stringify({ error: error?.stack || String(error) });
      }
    });
  </script>
</body></html>`;
}

async function startTestServer(glb, uploads) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(htmlPage());
      return;
    }
    if (url.pathname === '/__fixture.glb') {
      response.writeHead(200, { 'content-type': 'model/gltf-binary' });
      response.end(glb);
      return;
    }
    if (url.pathname === '/__upload' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const preset = url.searchParams.get('preset');
      uploads.set(preset, { bytes, optimized: url.searchParams.get('optimized') === 'true' });
      response.writeHead(201, { 'x-uploaded-bytes': String(bytes.byteLength) });
      response.end('stored');
      return;
    }
    if (url.pathname.startsWith('/vault/')) {
      const assetPath = path.resolve(PUBLIC, `.${url.pathname}`);
      if (!assetPath.startsWith(`${PUBLIC}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      try {
        const content = await readFile(assetPath);
        response.writeHead(200, {
          'content-type': assetPath.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream',
          'access-control-allow-origin': '*',
        });
        response.end(content);
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('browser production dependency graph optimizes and uploads a real GLB at every preset', {
  skip: chromiumInstalled ? false : 'Playwright Chromium is not installed; run `npx playwright install chromium` to enable the browser regression test.',
}, async () => {
  assert.match(vaultImportMap.imports['@gltf-transform/core'], /@gltf-transform\/core@4\.5\.0\?target=es2022$/);
  assert.match(vaultImportMap.imports['@gltf-transform/functions'], /\?external=@gltf-transform\/core$/);

  const { glb } = buildCrateGlb();
  const uploads = new Map();
  const { server, origin } = await startTestServer(glb, uploads);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const esmResponses = [];
    const pageErrors = [];
    page.on('response', response => {
      if (response.url().includes('esm.sh/@gltf-transform/functions@4.5.0')) esmResponses.push(response);
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin);
    const input = page.locator('#model');
    await input.setInputFiles({
      name: 'production-crate.glb',
      mimeType: 'model/gltf-binary',
      buffer: Buffer.from(glb),
    });

    for (const preset of ['high', 'balanced', 'small']) {
      await page.locator('#preset').selectOption(preset);
      await page.locator('#upload').click();
      await page.waitForFunction(() => {
        const value = document.querySelector('#result').textContent;
        return value && JSON.parse(value).preset === document.querySelector('#preset').value;
      }, null, { timeout: 120_000 });
      const result = JSON.parse(await page.locator('#result').textContent());
      assert.equal(result.ok, true, `${preset} upload did not complete: ${JSON.stringify(result)}`);
      assert.equal(result.optimized, true, `${preset} used the original fallback instead of optimized output`);
      assert.ok(result.optimizedBytes < result.sourceBytes, `${preset} should produce a smaller GLB`);
      assert.equal(result.uploadedBytes, result.optimizedBytes);
      assert.ok(uploads.has(preset), `${preset} output was not sent through the upload request`);

      // Reset result to prevent the next click observing the prior preset result.
      await page.locator('#result').evaluate(node => { node.textContent = ''; });
    }

    assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join('\n')}`);
    const functionModules = await Promise.all(esmResponses.map(response => response.text()));
    assert.ok(functionModules.some(source => /from["']@gltf-transform\/core["']/.test(source)),
      'functions CDN module must import the core through the browser import map');
    assert.ok(!functionModules.some(source => /from["']\/@gltf-transform\/core@\^4\.5\.0/.test(source)),
      'functions CDN module must not load a second version-range core instance');

    for (const preset of ['high', 'balanced', 'small']) {
      const uploaded = uploads.get(preset);
      assert.ok(uploaded.bytes.byteLength > 20, `${preset}: upload body is empty`);
      assert.equal(uploaded.bytes.readUInt32LE(0), 0x46546c67, `${preset}: uploaded body is not GLB`);
      assert.equal(uploaded.optimized, true);
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
