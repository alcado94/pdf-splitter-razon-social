'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PDFLib,
  JSZip,
  readPdf,
  extractCompanies,
  prepareForSplitting,
  generatePdf,
  uniqueFilename,
  createZip,
} = require('./load-services');
const { createFixture, createGroupingFixture } = require('./fixtures');
const { isAppError, assertPageProgress, assertFlattened, assertDrawnAppearances, assertOriginalPageOrder } = require('./assertions');

function assertZipProgress(events, filenames) {
  assert.ok(events.length > 0, 'ZIP progress callback must run');
  let previous = 0;
  for (const [percent, currentFile] of events) {
    assert.ok(Number.isFinite(percent));
    assert.ok(percent >= previous && percent <= 100, 'ZIP progress must be monotonic and bounded');
    if (currentFile != null) assert.ok(filenames.includes(currentFile));
    previous = percent;
  }
  assert.equal(events.at(-1)[0], 100);
}

async function splitFixture(fixture) {
  const { pdfDoc } = await readPdf(fixture.bytes);
  const result = await extractCompanies(pdfDoc);
  await prepareForSplitting(pdfDoc);
  assertFlattened(pdfDoc);
  const usedNames = new Set();
  const entries = [];
  for (const [company, indexes] of result.companies) {
    const events = [];
    const bytes = await generatePdf(pdfDoc, indexes, { onProgress: (done, total) => events.push([done, total]) });
    assert.ok(bytes instanceof Uint8Array);
    assertPageProgress(events, indexes.length);
    const reopened = await PDFLib.PDFDocument.load(bytes);
    assertOriginalPageOrder(reopened, indexes, fixture.pageSizes);
    assertFlattened(reopened);
    assertDrawnAppearances(reopened);
    entries.push({ filename: uniqueFilename(company, usedNames), bytes, company, indexes });
  }
  return { entries, result };
}

async function assertZipRoundTrip(entries, pageSizes) {
  const events = [];
  const blob = await createZip(entries, { onProgress: (percent, currentFile) => events.push([percent, currentFile]) });
  assert.ok(blob instanceof Blob, 'createZip returns a downloadable Blob');
  assert.equal(blob.type, 'application/zip');
  assert.ok(blob.size > 0);
  // Node JSZip cannot necessarily read a Blob without browser FileReader;
  // using ArrayBuffer also verifies the exact bytes exposed for download.
  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
  const filenames = entries.map((entry) => entry.filename);
  assert.deepEqual(Object.keys(zip.files).sort(), [...filenames].sort(), 'No extra folders, overwritten companies, or missing files');
  assertZipProgress(events, filenames);
  for (const entry of entries) {
    assert.equal(zip.files[entry.filename].dir, false);
    const bytes = await zip.file(entry.filename).async('uint8array');
    assert.deepEqual(bytes, entry.bytes, `ZIP changed the PDF bytes for ${entry.company || entry.filename}`);
    if (entry.indexes) {
      const reopened = await PDFLib.PDFDocument.load(bytes);
      assertOriginalPageOrder(reopened, entry.indexes, pageSizes);
      assertFlattened(reopened);
    }
  }
}

test('nine-page PDF splits into exact company groups and downloadable ZIP PDFs in original page order', async () => {
  const fixture = await createGroupingFixture();
  const { entries, result } = await splitFixture(fixture);
  assert.deepEqual(result.companies, fixture.expectedCompanies);
  assert.deepEqual(result.unidentifiedPages, fixture.unidentifiedPages);
  assert.deepEqual(result.conflictingPages, fixture.conflictingPages);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.indexes), [[0, 2, 7, 8], [1, 5]]);
  await assertZipRoundTrip(entries, fixture.pageSizes);
});

test('distinct company groups with colliding sanitized and case-folded names never overwrite ZIP entries', async () => {
  const fixture = await createFixture({
    pageCount: 5,
    fields: [
      { name: 'solicitud0.razonSocial', value: 'Acme/Servicios', pages: [0, 3] },
      { name: 'solicitud1.razonSocial', value: 'Acme\\Servicios', pages: [1, 4] },
      { name: 'solicitud2.razonSocial', value: 'ACME:Servicios', pages: [2] },
    ],
  });
  const { entries, result } = await splitFixture(fixture);
  assert.deepEqual(result.companies, new Map([
    ['ACME/SERVICIOS', [0, 3]], ['ACME\\SERVICIOS', [1, 4]], ['ACME:SERVICIOS', [2]],
  ]));
  assert.equal(new Set(entries.map((entry) => entry.filename.toLowerCase())).size, 3);
  await assertZipRoundTrip(entries, fixture.pageSizes);
});

test('ZIP preserves binary payloads, Unicode names, and entry boundaries exactly', async () => {
  const entries = [
    { filename: 'Árbol.pdf', bytes: Uint8Array.of(0, 255, 13, 10, 128, 37, 80, 68, 70) },
    { filename: '東京.pdf', bytes: Uint8Array.of(255, 0, 255, 42) },
    { filename: 'empty.pdf', bytes: new Uint8Array() },
  ];
  await assertZipRoundTrip(entries);
});

test('ZIP rejects duplicate names, including case and canonical Unicode collisions, rather than overwriting', async () => {
  for (const [first, second] of [
    ['company.pdf', 'company.pdf'],
    ['Company.PDF', 'company.pdf'],
    ['Árbol.pdf', 'A\u0301rbol.pdf'],
  ]) {
    await assert.rejects(() => createZip([
      { filename: first, bytes: Uint8Array.of(1) },
      { filename: second, bytes: Uint8Array.of(2) },
    ]), isAppError);
  }
});

test('ZIP rejects path-like entry names instead of creating nested or escaping entries', async () => {
  for (const filename of ['../company.pdf', 'nested/company.pdf', 'nested\\company.pdf', '.', '..', 'bad\u0000.pdf']) {
    await assert.rejects(() => createZip([{ filename, bytes: Uint8Array.of(1) }]), isAppError);
  }
});
