'use strict';

// Real-browser regression for the installable, offline app at a project subpath.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createFixture } = require('./fixtures');
const { assertFlattened } = require('./assertions');
const PDFLib = globalThis.PDFLib;
const JSZip = require('../lib/jszip.min.js');

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (error) {
  console.error('Playwright is required only for this check. See tests/browser-README.md.');
  throw error;
}

const root = path.resolve(__dirname, '..');
const prefix = '/pdf-splitter-razon-social/';
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function createServer() {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const relative = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await fs.readFile(filename);
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream' }).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function main() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-splitter-pwa-'));
  let context;
  try {
    const url = `http://127.0.0.1:${server.address().port}${prefix}`;
    context = await playwright.chromium.launchPersistentContext(profile, {
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
      headless: true,
      acceptDownloads: true
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) errors.push(message.text());
    });
    await page.addInitScript(() => {
      globalThis.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        globalThis.__cspViolations.push(event.violatedDirective);
      });
    });

    await page.goto(url, { waitUntil: 'load' });
    assert.equal(await page.locator('#select-file').isEnabled(), true);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
    const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href');
    assert.equal(manifestLink, 'manifest.webmanifest');
    const manifestResponse = await page.request.get(`${url}manifest.webmanifest`);
    assert.equal(manifestResponse.status(), 200);
    assert.match(manifestResponse.headers()['content-type'], /application\/manifest\+json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(new URL(manifest.start_url, url).href, url);
    assert.equal(new URL(manifest.scope, url).href, url);
    for (const icon of manifest.icons) {
      const response = await page.request.get(new URL(icon.src, url).href);
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-type'], /image\/png/);
      assert.deepEqual((await response.body()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    const cached = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const names = await caches.keys();
      const entries = await Promise.all(names.map(async (name) => {
        const cache = await caches.open(name);
        return (await cache.keys()).map((request) => request.url);
      }));
      return { scriptURL: registration.active.scriptURL, names, entries: entries.flat() };
    });
    assert.equal(cached.scriptURL, `${url}sw.js`);
    assert.equal(cached.names.length, 1);
    assert.match(cached.names[0], /^pdf-splitter-shell-/);
    assert.ok(cached.entries.length >= 16);
    assert.ok(cached.entries.includes(url));
    assert.ok(cached.entries.every((entry) => entry.startsWith(url) && !/\.(pdf|zip)(?:$|\?)/i.test(entry)));
    assert.equal(new Set(cached.entries).size, cached.entries.length);
    const devtools = await context.newCDPSession(page);
    const { installabilityErrors } = await devtools.send('Page.getInstallabilityErrors');
    assert.deepEqual(installabilityErrors, [], 'Chromium must consider the app installable');
    await devtools.detach();

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.locator('#select-file').isEnabled(), true, 'All app dependencies must work offline');
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller !== null), true);

    const fixture = await createFixture({ fields: [{ name: 'solicitud.razonSocial', value: 'Empresa A', pages: [0] }] });
    await page.locator('#file-input').setInputFiles({ name: 'privado.pdf', mimeType: 'application/pdf', buffer: Buffer.from(fixture.bytes) });
    await page.waitForFunction(() => document.querySelector('#app').dataset.status === 'processed');
    const pending = page.waitForEvent('download');
    await page.locator('#download-zip').click();
    const download = await pending;
    assert.equal(download.suggestedFilename(), 'documentos_fragmentados.zip');
    const zip = await JSZip.loadAsync(await fs.readFile(await download.path()), { checkCRC32: true });
    assert.deepEqual(Object.keys(zip.files), ['EMPRESA_A.pdf']);
    const pdf = await PDFLib.PDFDocument.load(await zip.file('EMPRESA_A.pdf').async('uint8array'));
    assert.equal(pdf.getPageCount(), 1);
    assertFlattened(pdf);
    const entriesAfterProcessing = await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((request) => request.url);
    }, cached.names[0]);
    assert.deepEqual(entriesAfterProcessing.sort(), cached.entries.sort(), 'Processing must not persist the selected PDF or ZIP');
    assert.deepEqual(await page.evaluate(() => globalThis.__cspViolations), []);
    assert.deepEqual(errors, []);
    console.log('PASS: PWA shell and PDF/ZIP processing work offline at a GitHub Pages-style subpath.');
  } finally {
    if (context) await context.close();
    await fs.rm(profile, { recursive: true, force: true });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
