'use strict';

// Standalone browser regression; no web server, runtime npm dependencies, or
// stored binary fixtures. See browser-README.md for temporary-tooling setup.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const { createFixture, createGroupingFixture, pageSize } = require('./fixtures');
const { assertFlattened, assertDrawnAppearances, assertOriginalPageOrder } = require('./assertions');
const PDFLib = globalThis.PDFLib;
const JSZip = require('../lib/jszip.min.js');

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (error) {
  console.error('Playwright is required only for this check. Set PLAYWRIGHT_MODULE to its temporary installation; see tests/browser-README.md.');
  throw error;
}

const appURL = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
const timeout = 120_000; // A liveness timeout, not a performance benchmark.
const profiles = {
  desktop: { viewport: { width: 1365, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};
const report = {
  node: process.version,
  playwright: require(`${process.env.PLAYWRIGHT_MODULE || 'playwright'}/package.json`).version,
  appURL,
  scenarios: [],
  requests: [],
  networkAttempts: [],
  pageErrors: [],
  consoleErrors: [],
  warnings: [],
  cspViolations: [],
  failedRequests: [],
  responsiveness: [],
  layouts: [],
};
let browser;
let screenshotDir;

function payload(bytes, name = 'agrupacion.pdf') {
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) };
}

async function focusRemains(page, id) {
  await page.evaluate(() => { globalThis.__browserSmokeFocusSamples = []; });
  // Use Playwright's bounded RAF polling: an unresolved RAF promise passed to
  // evaluate() has no operation timeout if a native picker suspends rendering.
  const poll = await page.waitForFunction(() => {
    globalThis.__browserSmokeFocusSamples.push(document.activeElement.id);
    return globalThis.__browserSmokeFocusSamples.length >= 2;
  }, null, { polling: 'raf', timeout: 10_000 });
  await poll.dispose();
  const focused = await page.evaluate(() => globalThis.__browserSmokeFocusSamples);
  assert.deepEqual(focused, [id, id], `Focus must remain on #${id}`);
}

async function layout(page, label) {
  const measurement = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const controls = [...document.querySelectorAll('button, #drop-zone')]
      .filter((element) => element.getClientRects().length)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { name: element.id || element.getAttribute('aria-label'), left: rect.left, right: rect.right };
      });
    const cells = [...document.querySelectorAll('td')]
      .filter((element) => element.getClientRects().length)
      .map((element) => ({ text: element.textContent, width: element.clientWidth, scrollWidth: element.scrollWidth }));
    return { width, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), controls, cells };
  });
  report.layouts.push({ label, width: measurement.width, scrollWidth: measurement.scrollWidth });
  assert.ok(measurement.scrollWidth <= measurement.width + 1, `${label}: horizontal document overflow: ${JSON.stringify(measurement)}`);
  for (const control of measurement.controls) {
    assert.ok(control.left >= -1 && control.right <= measurement.width + 1,
      `${label}: control extends outside viewport: ${JSON.stringify(control)}`);
  }
  for (const cell of measurement.cells) {
    assert.ok(cell.scrollWidth <= cell.width + 1, `${label}: clipped/overflowing table cell: ${JSON.stringify(cell)}`);
  }
}

async function screenshot(page, filename) {
  if (screenshotDir) {
    // Capture from the top: otherwise full-page Chromium captures can include
    // fixed, off-viewport content (such as the unfocused skip link) above the
    // current scroll position even though it is not visible to the user.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(screenshotDir, filename), fullPage: true });
  }
}

async function terminal(page, expected) {
  await page.waitForFunction(() => ['processed', 'completed', 'error'].includes(document.querySelector('#app').dataset.status), null, { timeout });
  assert.equal(await page.locator('#app').getAttribute('data-status'), expected,
    `Unexpected terminal state; visible error: ${await page.locator('#error-panel').innerText()}`);
}

async function outputsDisabled(page) {
  assert.equal(await page.locator('#download-zip').isDisabled(), true);
  for (const button of await page.getByRole('button', { name: /^Descargar PDF de / }).all()) {
    assert.equal(await button.isDisabled(), true, 'Every individual output must also require consent');
  }
}

async function reset(page) {
  await page.locator('#reset-button').click();
  assert.equal(await page.locator('#app').getAttribute('data-status'), 'idle');
  assert.equal(await page.locator('#error-panel').isVisible(), false);
  assert.equal(await page.getByRole('heading', { name: 'Documentos por empresa' }).isVisible(), false);
  assert.equal(await page.locator('#select-file').isEnabled(), true);
  assert.equal(await page.locator('#file-input').inputValue(), '');
  await outputsDisabled(page);
  await focusRemains(page, 'select-file');
}

async function drop(page, files) {
  // Exercise the app's native DOM drag/drop handlers with actual File objects.
  // Never call application services or assign the input's files from this path.
  const prevented = await page.evaluate((specs) => {
    const dataTransfer = new DataTransfer();
    for (const spec of specs) {
      dataTransfer.items.add(new File([Uint8Array.from(spec.bytes)], spec.name, { type: 'application/pdf' }));
    }
    const zone = document.querySelector('#drop-zone');
    const cancelled = [];
    for (const type of ['dragenter', 'dragover', 'drop']) {
      cancelled.push(!zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })));
    }
    return cancelled;
  }, files.map((file) => ({ name: file.name, bytes: Array.from(file.buffer) })));
  assert.deepEqual(prevented, [true, true, true], 'Native file drags must be consumed instead of navigating away');
  assert.equal(page.url(), appURL);
}

async function actualDownload(page, button, filename) {
  const pending = page.waitForEvent('download', { timeout });
  await button.click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), filename);
  assert.equal(await download.failure(), null);
  const downloadedPath = await download.path();
  assert.ok(downloadedPath, 'The browser must produce a real downloaded file');
  const bytes = await fs.readFile(downloadedPath);
  assert.ok(bytes.length > 0);
  await terminal(page, 'completed');
  return bytes;
}

async function checkPdf(bytes, indexes, fixture, appearances = true) {
  const reopened = await PDFLib.PDFDocument.load(bytes);
  assertOriginalPageOrder(reopened, indexes, fixture.pageSizes);
  assertFlattened(reopened);
  if (appearances) assertDrawnAppearances(reopened);
  return reopened;
}

function groupingEntries(fixture) {
  // Explicit externally expected filenames, not results computed by app helpers.
  return [
    { name: 'ÁRBOL NORTE, S.L.', filename: 'ÁRBOL_NORTE,_SL.pdf', indexes: fixture.expectedCompanies.get('ÁRBOL NORTE, S.L.') },
    { name: 'BETA SUR, S.A.', filename: 'BETA_SUR,_SA.pdf', indexes: fixture.expectedCompanies.get('BETA SUR, S.A.') },
    { name: 'Sin razón social', filename: 'SIN_RAZON_SOCIAL.pdf', indexes: fixture.unidentifiedPages },
  ];
}

async function checkZip(bytes, entries, fixture, appearances = true) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), entries.map((entry) => entry.filename).sort(), 'ZIP must contain exactly the intended PDF entries, without folders or missing groups');
  const actualOriginalIndexes = [];
  for (const entry of entries) {
    assert.equal(zip.files[entry.filename].dir, false);
    const pdfBytes = await zip.file(entry.filename).async('uint8array');
    const pdf = await checkPdf(pdfBytes, entry.indexes, fixture, appearances);
    for (const page of pdf.getPages()) {
      const size = page.getSize();
      const originalIndex = fixture.pageSizes.findIndex((original) => original.width === size.width && original.height === size.height);
      assert.notEqual(originalIndex, -1);
      actualOriginalIndexes.push(originalIndex);
    }
    if (entry.downloaded) assert.deepEqual(Buffer.from(pdfBytes), entry.downloaded, 'ZIP must preserve the individually downloaded bytes');
  }
  assert.deepEqual(actualOriginalIndexes.sort((a, b) => a - b), fixture.pageSizes.map((_, index) => index), 'Every original page must occur exactly once across the actual downloaded ZIP');
}

async function checkGrouping(page, fixture) {
  await terminal(page, 'processed');
  const entries = groupingEntries(fixture);
  const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: /^Descargar PDF de / }) });
  assert.equal(await rows.count(), 3);
  for (const entry of entries) {
    const row = rows.filter({ has: page.getByRole('button', { name: `Descargar PDF de ${entry.name}`, exact: true }) });
    assert.equal(await row.count(), 1);
    const cells = row.getByRole('cell');
    assert.match(await cells.nth(0).innerText(), new RegExp(entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal((await cells.nth(1).innerText()).trim(), String(entry.indexes.length));
  }
  assert.match(await page.locator('#results-summary').innerText(), /3 documentos.*9 páginas/);
  assert.equal(await page.locator('#unidentified-pages').innerText(), 'Páginas: 4–5, 7.');
  assert.match(await page.locator('#unidentified-description').innerText(), /3 páginas.*SIN_RAZON_SOCIAL\.pdf.*Ninguna página se perderá/);
  assert.equal(await page.getByRole('heading', { name: 'Algunas páginas necesitan una revisión' }).isVisible(), true);
  assert.match(await page.locator('#conflicting-description').innerText(), /estas páginas: 5\..*Sin razón social/);
  await outputsDisabled(page);
  await focusRemains(page, 'results-title');
}

async function consent(page) {
  await page.locator('#continue-unidentified').click();
  assert.equal(await page.locator('#continue-unidentified').isVisible(), false);
  assert.equal(await page.locator('#download-zip').isEnabled(), true);
  for (const button of await page.getByRole('button', { name: /^Descargar PDF de / }).all()) {
    assert.equal(await button.isEnabled(), true);
  }
  await focusRemains(page, 'download-zip');
}

async function startPaintProbe(page) {
  await page.bringToFront();
  await page.evaluate(() => {
    const samples = [];
    const beats = {};
    const phases = {};
    let previousFrame = performance.now();
    const observePhase = () => {
      const status = document.querySelector('#app').dataset.status;
      const now = performance.now();
      if (!phases[status]) phases[status] = { first: now, last: now };
      phases[status].last = now;
      return status;
    };
    const observer = new MutationObserver(observePhase);
    observer.observe(document.querySelector('#app'), { attributes: true, attributeFilter: ['data-status'] });
    const beat = setInterval(() => {
      const status = observePhase();
      beats[status] = (beats[status] || 0) + 1;
    }, 10);
    let frame;
    const paint = (now) => {
      const status = observePhase();
      if (['loading', 'analyzing', 'generating'].includes(status)) {
        const progress = document.querySelector('progress');
        const rect = progress.getBoundingClientRect();
        samples.push({ status, gapMs: now - previousFrame, visible: rect.width > 0 && rect.height > 0 && !document.querySelector('#progress-panel').hidden,
          progress: progress.hasAttribute('value') ? progress.value : null,
          text: document.querySelector('#progress-description').textContent });
      }
      previousFrame = now;
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    globalThis.__browserSmokeStopPaint = () => {
      clearInterval(beat);
      cancelAnimationFrame(frame);
      observer.disconnect();
      return { samples, beats, phases };
    };
  });
}

async function finishPaintProbe(page, label) {
  const probe = await page.evaluate(() => globalThis.__browserSmokeStopPaint());
  const observation = { label, phases: {} };
  for (const status of ['loading', 'analyzing', 'generating']) {
    const samples = probe.samples.filter((sample) => sample.status === status);
    observation.phases[status] = {
      frames: samples.length,
      heartbeats: probe.beats[status] || 0,
      maxFrameGapMs: Math.round(Math.max(0, ...samples.map((sample) => sample.gapMs))),
      progressValues: [...new Set(samples.map((sample) => sample.progress))],
    };
  }
  report.responsiveness.push(observation);
  for (const status of ['analyzing', 'generating']) {
    const samples = probe.samples.filter((sample) => sample.status === status);
    assert.ok(samples.length > 0, `${label}: the browser must render a frame during ${status}`);
    assert.ok(samples.every((sample) => sample.visible), `${label}: busy UI must have a visibly laid-out progress bar`);
    assert.ok(probe.beats[status] > 0, `${label}: event-loop heartbeat must run during ${status}`);
    assert.ok(new Set(samples.map((sample) => sample.text)).size > 1, `${label}: rendered progress must advance during ${status}`);
  }
}

async function makeStressFixture(shared) {
  const { PDFDocument, StandardFonts, PDFName } = PDFLib;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sizes = Array.from({ length: 300 }, (_, index) => pageSize(index));
  const pages = sizes.map((size, index) => {
    const page = pdf.addPage([size.width, size.height]);
    page.drawText(`Original page ${index + 1}`, { x: 35, y: size.height - 35, font, size: 12 });
    return page;
  });
  const form = pdf.getForm();
  const companies = ['Árbol Norte, S.L.', 'Beta Sur, S.A.', 'Gamma Este, S.L.'];
  const entries = shared
    ? [{ name: 'COMPARTIDA GLOBAL, S.L.', filename: 'COMPARTIDA_GLOBAL,_SL.pdf', indexes: pages.map((_, index) => index) }]
    : ['ÁRBOL NORTE, S.L.', 'BETA SUR, S.A.', 'GAMMA ESTE, S.L.'].map((name, group) => ({
      name, filename: ['ÁRBOL_NORTE,_SL.pdf', 'BETA_SUR,_SA.pdf', 'GAMMA_ESTE,_SL.pdf'][group],
      indexes: pages.map((_, index) => index).filter((index) => index % 3 === group),
    }));
  let sharedField;
  if (shared) {
    sharedField = form.createTextField('expediente.comun.razonSocial');
    sharedField.setText('Compartida Global, S.L.');
  }
  for (const [index, page] of pages.entries()) {
    const field = sharedField || form.createTextField(`expedientes.lote${Math.floor(index / 25)}.pagina${index}.razonSocial`);
    if (!shared) field.setText(companies[index % companies.length]);
    field.addToPage(page, { x: 40, y: 80, width: 350, height: 25, font });
  }
  form.updateFieldAppearances(font);
  // Also exercise widget-to-page annotation lookup when /P is absent.
  if (shared) {
    for (const [index, widget] of sharedField.acroField.getWidgets().entries()) {
      if (index % 11 === 0) widget.dict.delete(PDFName.of('P'));
    }
  }
  return { bytes: await pdf.save({ updateFieldAppearances: false }), pageSizes: sizes, entries };
}

async function withPage(label, profile, action, expectedWarning = null) {
  const context = await browser.newContext({ ...profiles[profile], offline: true, acceptDownloads: true, bypassCSP: false });
  const warningTasks = [];
  const contextWarnings = [];
  // Offline is already set before creating/navigating any page. Record and reject
  // all network attempts rather than silently letting offline emulation mask them.
  context.on('request', (request) => {
    report.requests.push({ label, url: request.url(), type: request.resourceType() });
    if (/^(https?|wss?):/i.test(request.url())) report.networkAttempts.push({ label, url: request.url() });
  });
  context.on('requestfailed', (request) => report.failedRequests.push({ label, url: request.url(), error: request.failure() }));
  await context.route(/^(https?|wss?):/i, (route) => route.abort('blockedbyclient'));
  await context.routeWebSocket(/.*/, (socket) => {
    report.networkAttempts.push({ label, url: socket.url(), type: 'websocket' });
    socket.close();
  });
  await context.addInitScript(() => {
    globalThis.__browserSmokeCsp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__browserSmokeCsp.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (error) => report.pageErrors.push({ label, error: error.stack || error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push({ label, text: message.text() });
    if (message.type() === 'warning') {
      warningTasks.push((async () => {
        const args = await Promise.all(message.args().map((arg) => arg.jsonValue()));
        const warning = { label, text: message.text(), args };
        contextWarnings.push(warning);
        report.warnings.push(warning);
      })().catch((error) => { contextWarnings.push({ label, captureError: error.message }); }));
    }
  });
  page.on('websocket', (socket) => report.networkAttempts.push({ label, url: socket.url(), type: 'websocket' }));
  let actionError;
  try {
    await page.goto(appURL, { waitUntil: 'load' });
    assert.equal(page.url(), appURL);
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.equal(await page.locator('#select-file').isEnabled(), true, 'Classic local scripts must load with CSP intact');
    assert.equal(await page.locator('#error-panel').isVisible(), false);
    const scripts = await page.locator('script[src]').evaluateAll((elements) => elements.map((element) => ({ src: element.src, type: element.type })));
    assert.ok(scripts.length > 0);
    assert.ok(scripts.every((script) => script.src.startsWith('file:') && script.type !== 'module'));
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'none'/);
    for (const script of scripts) assert.ok(report.requests.some((request) => request.label === label && request.url === script.src), `Browser must request ${script.src}`);
    await action(page);
  } catch (error) {
    actionError = error;
    await screenshot(page, `${label.replace(/[^a-z0-9]+/gi, '-')}-failure.png`).catch(() => {});
  } finally {
    try {
      await Promise.all(warningTasks);
      const violations = await page.evaluate(() => globalThis.__browserSmokeCsp || []);
      report.cspViolations.push(...violations.map((violation) => ({ label, ...violation })));
      if (!actionError) {
        assert.equal(contextWarnings.length, expectedWarning ? 1 : 0, `Unexpected console warning(s): ${JSON.stringify(contextWarnings)}`);
        if (expectedWarning) assert.deepEqual(contextWarnings[0].args, ['[PDFSplitter]', { stage: expectedWarning.stage, type: 'AppError', code: expectedWarning.code }], 'Expected input errors must be reported by semantic stage/code without document data');
      }
    } catch (error) {
      // Preserve the primary failure if the page/browser also closed while
      // collecting diagnostics, rather than replacing it with a cleanup error.
      if (!actionError) actionError = error;
    } finally {
      await context.close();
    }
  }
  if (actionError) throw actionError;
}

async function run(label, profile, action, expectedWarning) {
  const started = performance.now();
  try {
    await withPage(label, profile, action, expectedWarning);
    report.scenarios.push({ label, status: 'passed', durationMs: Math.round(performance.now() - started) });
    console.log(`PASS ${label} (${Math.round(performance.now() - started)} ms)`);
  } catch (error) {
    report.scenarios.push({ label, status: 'failed', durationMs: Math.round(performance.now() - started), error: error.stack || error.message });
    console.error(`FAIL ${label}\n${error.stack || error}`);
  }
}

async function main() {
  if (process.env.BROWSER_SCREENSHOT_DIR) {
    screenshotDir = path.resolve(process.env.BROWSER_SCREENSHOT_DIR);
    const actualDir = await fs.realpath(screenshotDir);
    assert.ok(actualDir === '/tmp/opencode' || actualDir.startsWith('/tmp/opencode/'), 'Screenshots may only be written under /tmp/opencode');
    assert.equal((await fs.stat(actualDir)).isDirectory(), true, 'Verify/create the screenshot directory before running');
    screenshotDir = actualDir;
  }
  const fixture = await createGroupingFixture();
  browser = await playwright.chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    headless: true,
  });
  report.browser = `Chromium ${browser.version()} (full Chromium, new headless mode)`;
  console.log(`${report.browser}; Playwright ${report.playwright}; Node ${report.node}`);
  try {
    for (const profile of Object.keys(profiles)) {
      await run(`${profile}: offline grouping, consent, actual individual PDFs and ZIP`, profile, async (page) => {
        await layout(page, `${profile}: idle`);
        const name = profile === 'mobile' ? `${'nombre-largo-del-original-'.repeat(10)}.pdf` : 'agrupacion.pdf';
        await page.locator('#file-input').setInputFiles(payload(fixture.bytes, name));
        await checkGrouping(page, fixture);
        await layout(page, `${profile}: unconfirmed results`);
        await screenshot(page, `${profile}-grouping-unconfirmed.png`);
        await consent(page);
        const entries = groupingEntries(fixture);
        for (const entry of entries) {
          entry.downloaded = await actualDownload(page, page.getByRole('button', { name: `Descargar PDF de ${entry.name}`, exact: true }), entry.filename);
          await checkPdf(entry.downloaded, entry.indexes, fixture);
        }
        const zip = await actualDownload(page, page.locator('#download-zip'), 'documentos_fragmentados.zip');
        await checkZip(zip, entries, fixture);
        await layout(page, `${profile}: completed`);
        await screenshot(page, `${profile}-grouping-completed.png`);
        if (profile === 'mobile') {
          await page.setViewportSize({ width: 320, height: 720 });
          await layout(page, 'mobile: narrow 320px results');
        }
        await reset(page);
        await layout(page, `${profile}: reset`);
      });
    }

    await run('reset and reselect the exact same PDF', 'desktop', async (page) => {
      const file = payload(fixture.bytes);
      await page.locator('#file-input').setInputFiles(file);
      await checkGrouping(page, fixture);
      await consent(page);
      await reset(page);
      await page.locator('#file-input').setInputFiles(file);
      await checkGrouping(page, fixture); // Consent must be requested anew.
      await consent(page);
      await checkZip(await actualDownload(page, page.locator('#download-zip'), 'documentos_fragmentados.zip'), groupingEntries(fixture), fixture);
    });

    await run('native DataTransfer/File drop and actual output', 'desktop', async (page) => {
      await drop(page, [payload(fixture.bytes, 'arrastrado.pdf')]);
      await checkGrouping(page, fixture);
      await consent(page);
      await checkZip(await actualDownload(page, page.locator('#download-zip'), 'documentos_fragmentados.zip'), groupingEntries(fixture), fixture);
      await reset(page);
    });

    // Fresh contexts avoid Chromium's rapid repeated/cancelled native-picker
    // suppression. Each test still triggers the real trusted keyboard handler.
    for (const [id, key] of [['select-file', 'Enter'], ['drop-zone', 'Enter'], ['drop-zone', 'Space']]) {
      await run(`keyboard picker #${id} ${key}: filechooser and stable focus`, 'desktop', async (page) => {
        await page.locator(`#${id}`).focus();
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
        await page.keyboard.press(key);
        const chooser = await chooserPromise;
        assert.equal(chooser.isMultiple(), false);
        await chooser.setFiles(payload(fixture.bytes));
        await checkGrouping(page, fixture);
        await consent(page);
        await reset(page);
      });
    }
    await run('keyboard picker cancellation preserves focus and idle controls', 'desktop', async (page) => {
      await page.locator('#select-file').focus();
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
      await page.keyboard.press('Enter');
      await (await chooserPromise).setFiles([]);
      await focusRemains(page, 'select-file');
      assert.equal(await page.locator('#app').getAttribute('data-status'), 'idle');
      assert.equal(await page.locator('#select-file').isEnabled(), true);
      assert.equal(await page.locator('#error-panel').isVisible(), false);
    });

    for (const profile of Object.keys(profiles)) {
      await run(`${profile}: invalid PDF message and reset recovery`, profile, async (page) => {
        await page.locator('#file-input').setInputFiles(payload(Buffer.from('This is not PDF data.'), 'invalido.pdf'));
        await terminal(page, 'error');
        assert.equal(await page.locator('#error-panel').isVisible(), true);
        assert.equal(await page.locator('#error-message').innerText(), 'El archivo no contiene un PDF válido, aunque tenga extensión .pdf.');
        await outputsDisabled(page);
        await focusRemains(page, 'error-title');
        await layout(page, `${profile}: invalid PDF error`);
        await reset(page);
        await page.locator('#file-input').setInputFiles(payload(fixture.bytes));
        await checkGrouping(page, fixture);
      }, { stage: 'reading', code: 'INVALID_PDF' });
    }

    await run('multiple-file native drop rejected and reset recovery', 'desktop', async (page) => {
      await drop(page, [payload(fixture.bytes, 'primero.pdf'), payload(fixture.bytes, 'segundo.pdf')]);
      await terminal(page, 'error');
      assert.equal(await page.locator('#error-panel').isVisible(), true);
      assert.equal(await page.locator('#error-message').innerText(), 'Selecciona un solo archivo PDF cada vez.');
      assert.equal(await page.getByRole('heading', { name: 'Documentos por empresa' }).isVisible(), false);
      await outputsDisabled(page);
      await focusRemains(page, 'error-title');
      await reset(page);
      await drop(page, [payload(fixture.bytes)]);
      await checkGrouping(page, fixture);
    }, { stage: 'validation', code: 'MULTIPLE_FILES' });

    const xfa = await createFixture({ xfa: true });
    await run('XFA precise user-facing rejection and reset recovery', 'desktop', async (page) => {
      await page.locator('#file-input').setInputFiles(payload(xfa.bytes, 'xfa.pdf'));
      await terminal(page, 'error');
      assert.equal(await page.locator('#error-panel').isVisible(), true);
      assert.equal(await page.locator('#error-message').innerText(), 'Este PDF utiliza un formulario XFA, que no se puede procesar. Guarda una copia con un formulario AcroForm estándar.');
      await outputsDisabled(page);
      await focusRemains(page, 'error-title');
      await reset(page);
      await page.locator('#file-input').setInputFiles(payload(fixture.bytes));
      await checkGrouping(page, fixture);
    }, { stage: 'reading', code: 'XFA_UNSUPPORTED' });

    const plain = await createFixture({ pageCount: 3 });
    const plainDoc = await PDFLib.PDFDocument.load(plain.bytes);
    plainDoc.catalog.delete(PDFLib.PDFName.of('AcroForm'));
    plain.bytes = await plainDoc.save({ updateFieldAppearances: false });
    await run('no-form PDF: all unknown, explicit consent and complete outputs', 'mobile', async (page) => {
      await page.locator('#file-input').setInputFiles(payload(plain.bytes, 'sin-formulario.pdf'));
      await terminal(page, 'processed');
      assert.equal(await page.getByRole('button', { name: /^Descargar PDF de / }).count(), 1);
      assert.equal(await page.locator('#unidentified-pages').innerText(), 'Páginas: 1–3.');
      assert.equal(await page.getByRole('heading', { name: 'Algunas páginas necesitan una revisión' }).isVisible(), false);
      await outputsDisabled(page);
      await consent(page);
      const entry = { name: 'Sin razón social', filename: 'SIN_RAZON_SOCIAL.pdf', indexes: [0, 1, 2] };
      entry.downloaded = await actualDownload(page, page.getByRole('button', { name: 'Descargar PDF de Sin razón social', exact: true }), entry.filename);
      await checkPdf(entry.downloaded, entry.indexes, plain, false);
      await checkZip(await actualDownload(page, page.locator('#download-zip'), 'documentos_fragmentados.zip'), [entry], plain, false);
      await layout(page, 'mobile: no-form completed');
      await reset(page);
    });

    for (const shared of [false, true]) {
      const label = shared ? '300 pages: one field with 300 widgets' : '300 pages: hierarchical fields, nonconsecutive companies';
      const fixtureStarted = performance.now();
      const stress = await makeStressFixture(shared);
      console.log(`Fixture ${label}: ${stress.bytes.length} bytes, ${Math.round(performance.now() - fixtureStarted)} ms to synthesize`);
      await run(label, 'desktop', async (page) => {
        await startPaintProbe(page);
        const analysisStarted = performance.now();
        await page.locator('#file-input').setInputFiles(payload(stress.bytes, shared ? '300-widgets.pdf' : '300-jerarquia.pdf'));
        await terminal(page, 'processed');
        const analysisMs = Math.round(performance.now() - analysisStarted);
        assert.equal(await page.locator('#continue-unidentified').isVisible(), false);
        assert.equal(await page.locator('#download-zip').isEnabled(), true);
        assert.equal(await page.getByRole('button', { name: /^Descargar PDF de / }).count(), stress.entries.length);
        for (const entry of stress.entries) {
          assert.equal(await page.getByRole('button', { name: `Descargar PDF de ${entry.name}`, exact: true }).isEnabled(), true);
        }
        const generationStarted = performance.now();
        if (shared) {
          const entry = stress.entries[0];
          const bytes = await actualDownload(page, page.getByRole('button', { name: `Descargar PDF de ${entry.name}`, exact: true }), entry.filename);
          await checkPdf(bytes, entry.indexes, stress);
        } else {
          await checkZip(await actualDownload(page, page.locator('#download-zip'), 'documentos_fragmentados.zip'), stress.entries, stress);
        }
        const generationAndReopenMs = Math.round(performance.now() - generationStarted);
        await finishPaintProbe(page, label);
        Object.assign(report.responsiveness.at(-1), { analysisMs, generationAndReopenMs });
        await layout(page, label);
        await screenshot(page, shared ? 'stress-300-widgets.png' : 'stress-300-hierarchy.png');
        await reset(page);
      });
    }

    await run('global browser diagnostics: no errors, CSP violations or network attempts', 'desktop', async () => {
      assert.deepEqual(report.networkAttempts, [], 'No HTTP(S)/WS(S) request may be attempted');
      assert.deepEqual(report.pageErrors, [], 'No uncaught browser exceptions');
      assert.deepEqual(report.consoleErrors, [], 'No console errors, including CSP failures');
      assert.deepEqual(report.cspViolations, [], 'No CSP violations');
      assert.deepEqual(report.failedRequests, [], 'All local resource requests must succeed');
    });
  } finally {
    await browser.close();
  }
  const failures = report.scenarios.filter((scenario) => scenario.status === 'failed');
  console.log(`\n${report.scenarios.length - failures.length}/${report.scenarios.length} browser scenarios passed.`);
  console.log(JSON.stringify({ ...report, requests: { count: report.requests.length, protocols: [...new Set(report.requests.map((request) => new URL(request.url).protocol))] } }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
