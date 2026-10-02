'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PDFLib,
  readPdf,
  extractCompanies,
  prepareForSplitting,
  generatePdf,
} = require('./load-services');
const { createFixture, createGroupingFixture } = require('./fixtures');
const {
  isAppError,
  assertPageProgress,
  assertFlattened,
  assertDrawnAppearances,
  normalAppearances,
  pageXObjectStreams,
  pageXObjectContents,
  assertOriginalPageOrder,
} = require('./assertions');

test('hierarchical fields group nonconsecutive pages, exclude conflicts, and report missing pages', async () => {
  const fixture = await createGroupingFixture();
  const { pdfDoc, totalPages, fields } = await readPdf(fixture.bytes, { debug: false });
  assert.equal(totalPages, 9);
  assert.equal(pdfDoc.getPageCount(), 9);
  assert.ok(Array.isArray(fields));
  assert.ok(fields.length > 0);
  const events = [];
  const result = await extractCompanies(pdfDoc, { onProgress: (done, total) => events.push([done, total]) });
  assert.ok(result.companies instanceof Map);
  assert.deepEqual(result.companies, fixture.expectedCompanies);
  assert.deepEqual(result.unidentifiedPages, fixture.unidentifiedPages);
  assert.deepEqual(result.conflictingPages, fixture.conflictingPages);
  assert.equal(result.totalPages, 9);
  assertPageProgress(events, 9);
  assert.ok(!Array.from(result.companies.values()).flat().includes(4), 'A conflict must never be silently assigned to a company');
});

test('mixed capitalization, NFC/NFD accents, and whitespace agree on one page and merge nonconsecutive company pages', async () => {
  const fixture = await createFixture({
    pageCount: 6,
    fields: [
      {
        name: 'solicitud0a.razonSocial',
        appearanceText: 'ORIGINAL FIRST AP',
        rawValue: '  Árbol\t Norte,\n S.L.  ',
        pages: [0],
      },
      {
        name: 'solicitud0b.razonSocial',
        appearanceText: 'ORIGINAL SECOND AP',
        rawValue: ' a\u0301RBOL   NORTE, s.l. ',
        pages: [0],
      },
      { name: 'solicitud1.razonSocial', value: 'Beta Sur, S.A.', pages: [1] },
      {
        name: 'solicitud2.razonSocial',
        appearanceText: 'ORIGINAL DECOMPOSED AP',
        rawValue: '\tA\u0301rBoL  nOrTe, s.l.\n',
        pages: [2],
        omitPageReference: true,
      },
      { name: 'solicitud4.razonSocial', value: 'árbol norte, s.l.', pages: [4] },
      // An absent accent is a distinct company value, not a canonical variant.
      { name: 'solicitud5.razonSocial', value: 'Arbol Norte, S.L.', pages: [5] },
    ],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const originalValues = pdfDoc.getForm().getFields().map((field) => field.getText());
  const originalAppearances = normalAppearances(pdfDoc);
  const result = await extractCompanies(pdfDoc);
  assert.deepEqual(result.companies, new Map([
    ['ÁRBOL NORTE, S.L.', [0, 2, 4]],
    ['BETA SUR, S.A.', [1]],
    ['ARBOL NORTE, S.L.', [5]],
  ]));
  assert.deepEqual(result.conflictingPages, [], 'Equivalent populated fields on page 0 are not a conflict');
  assert.deepEqual(result.unidentifiedPages, [3]);
  assert.equal(result.totalPages, 6);
  assert.deepEqual(pdfDoc.getForm().getFields().map((field) => field.getText()), originalValues,
    'Grouping normalization must not rewrite original PDF field values');
  assert.deepEqual(normalAppearances(pdfDoc), originalAppearances,
    'Grouping normalization must not rewrite original visible appearances');
});

test('a single field with multiple widgets maps each widget through page Annots when /P is absent', async () => {
  const fixture = await createFixture({
    pageCount: 3,
    fields: [{ name: 'solicitudCompartida.razonSocial', value: 'Shared company', pages: [0, 2], omitPageReference: true }],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const fields = pdfDoc.getForm().getFields();
  assert.equal(fields.length, 1);
  const widgets = fields[0].acroField.getWidgets();
  assert.equal(widgets.length, 2);
  assert.ok(widgets.every((widget) => widget.P() === undefined), 'Fixture must exercise the Annots-only mapping path');
  const result = await extractCompanies(pdfDoc);
  assert.deepEqual(result.companies, new Map([['SHARED COMPANY', [0, 2]]]));
  assert.deepEqual(result.unidentifiedPages, [1]);
  assert.deepEqual(result.conflictingPages, []);

  await prepareForSplitting(pdfDoc);
  assertFlattened(pdfDoc);
  const generated = await generatePdf(pdfDoc, [0, 2]);
  const reopened = await PDFLib.PDFDocument.load(generated);
  assertFlattened(reopened);
  assertOriginalPageOrder(reopened, [0, 2], fixture.pageSizes);
  assertDrawnAppearances(reopened);
});

test('configured field names match exact terminal names and exact fully qualified names', async () => {
  const fixture = await createFixture({
    pageCount: 4,
    fields: [
      { name: 'request0.companyName', value: 'Configured A', pages: [0] },
      { name: 'request0.razonSocial', value: 'Default only', pages: [0] },
      { name: 'request1.companyNameExtra', value: 'Wrong suffix', pages: [1] },
      { name: 'request1.notcompanyName', value: 'Wrong prefix', pages: [1] },
      { name: 'request2.companyName', value: 'Configured B', pages: [2] },
      { name: 'companyName', value: 'Configured C', pages: [3] },
    ],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const configured = await extractCompanies(pdfDoc, { companyField: 'companyName' });
  assert.deepEqual(configured.companies, new Map([
    ['CONFIGURED A', [0]], ['CONFIGURED B', [2]], ['CONFIGURED C', [3]],
  ]));
  assert.deepEqual(configured.unidentifiedPages, [1]);
  const qualified = await extractCompanies(pdfDoc, { companyField: 'request0.companyName' });
  assert.deepEqual(qualified.companies, new Map([['CONFIGURED A', [0]]]));
  assert.deepEqual(qualified.unidentifiedPages, [1, 2, 3]);
  const defaults = await extractCompanies(pdfDoc);
  assert.deepEqual(defaults.companies, new Map([['DEFAULT ONLY', [0]]]));
});

test('missing /V, empty /V, whitespace /V, and a page with no field are unidentified', async () => {
  const fixture = await createFixture({
    pageCount: 5,
    fields: [
      { name: 'solicitud0.razonSocial', pages: [0] },
      { name: 'solicitud1.razonSocial', value: '', pages: [1] },
      { name: 'solicitud2.razonSocial', value: '   ', pages: [2] },
      { name: 'solicitud4.razonSocial', value: 'Real company', pages: [4] },
    ],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const result = await extractCompanies(pdfDoc);
  assert.deepEqual(result.companies, new Map([['REAL COMPANY', [4]]]));
  assert.deepEqual(result.unidentifiedPages, [0, 1, 2, 3]);
  assert.deepEqual(result.conflictingPages, []);
});

test('merged terminal field/widget dictionaries are mapped and removed during flattening', async () => {
  const fixture = await createFixture({
    pageCount: 2,
    fields: [
      { name: 'solicitud0.razonSocial', value: 'Merged company', pages: [0], merged: true, omitPageReference: true },
      { name: 'razonSocial', value: 'Merged company', pages: [1], merged: true },
    ],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const result = await extractCompanies(pdfDoc);
  assert.deepEqual(result.companies, new Map([['MERGED COMPANY', [0, 1]]]));
  await prepareForSplitting(pdfDoc);
  assertFlattened(pdfDoc);
  const reopened = await PDFLib.PDFDocument.load(await generatePdf(pdfDoc, [0, 1]));
  assertFlattened(reopened);
  assertOriginalPageOrder(reopened, [0, 1], fixture.pageSizes);
  assertDrawnAppearances(reopened);
});

test('Unicode values with valid existing appearances survive grouping and flattening without appearance regeneration', async () => {
  const fixture = await createFixture({
    pageCount: 2,
    fields: [{
      name: 'solicitudUnicode.razonSocial',
      appearanceText: 'EXISTING AP MUST SURVIVE',
      rawValue: '東京株式会社',
      pages: [0, 1],
      omitPageReference: true,
    }],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const originals = normalAppearances(pdfDoc);
  assert.equal(originals.length, 2);
  const result = await extractCompanies(pdfDoc);
  assert.deepEqual(result.companies, new Map([['東京株式会社', [0, 1]]]));
  await prepareForSplitting(pdfDoc);
  assertFlattened(pdfDoc);
  const reopened = await PDFLib.PDFDocument.load(await generatePdf(pdfDoc, [0, 1]));
  assertFlattened(reopened);
  assertDrawnAppearances(reopened);
  for (const [pageIndex, appearance] of originals.entries()) {
    const copiedAppearances = pageXObjectContents(reopened, [pageIndex]);
    assert.ok(copiedAppearances.some((contents) => contents.equals(appearance)),
      `Existing visible appearance content must remain reachable from output page ${pageIndex} unchanged`);
  }
});

test('a missing standard-Latin appearance is rendered rather than silently dropped', async () => {
  const fixture = await createFixture({
    fields: [{ name: 'solicitud0.razonSocial', value: 'Latin fallback', missingAppearance: true }],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  assert.equal(pdfDoc.getForm().getFields()[0].acroField.getWidgets()[0].dict.has(PDFLib.PDFName.of('AP')), false);
  await prepareForSplitting(pdfDoc);
  const reopened = await PDFLib.PDFDocument.load(await generatePdf(pdfDoc, [0]));
  assertFlattened(reopened);
  assertDrawnAppearances(reopened);
  const appearances = pageXObjectStreams(reopened);
  assert.ok(appearances.length > 0, 'Fallback appearance must be drawn into the page');
  const valueHex = Buffer.from('Latin fallback', 'ascii').toString('hex').toUpperCase();
  const textStreams = appearances.map((stream) =>
    Buffer.from(PDFLib.decodePDFRawStream(stream).decode()).toString('latin1'));
  assert.ok(textStreams.some((text) => text.includes('Latin fallback') || text.toUpperCase().includes(valueHex)),
    'Latin value must be present in an appearance text operation, not omitted');
});

test('an unrenderable Unicode value without an appearance rejects instead of losing the value', async () => {
  const fixture = await createFixture({
    fields: [{ name: 'solicitud0.razonSocial', appearanceText: 'Temporary ASCII', rawValue: '東京株式会社', missingAppearance: true }],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  await assert.rejects(() => prepareForSplitting(pdfDoc), isAppError);
});

test('rendering one missing widget appearance does not regenerate an existing appearance of the same field', async () => {
  const fixture = await createFixture({
    pageCount: 2,
    fields: [{
      name: 'solicitud.razonSocial',
      appearanceText: 'CUSTOM EXISTING AP',
      rawValue: 'Latin fallback',
      pages: [0, 1],
      missingAppearancePages: [1],
    }],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const widgets = pdfDoc.getForm().getFields()[0].acroField.getWidgets();
  const original = Buffer.from(pdfDoc.context.lookup(widgets[0].getNormalAppearance()).getContents());
  assert.equal(widgets[1].dict.has(PDFLib.PDFName.of('AP')), false);
  await prepareForSplitting(pdfDoc);
  const reopened = await PDFLib.PDFDocument.load(await generatePdf(pdfDoc, [0, 1]));
  assertFlattened(reopened);
  assertDrawnAppearances(reopened);
  assert.ok(pageXObjectContents(reopened, [0]).some((contents) => contents.equals(original)),
    'Regenerating a sibling widget must not replace the existing custom appearance');
  const valueHex = Buffer.from('Latin fallback', 'ascii').toString('hex').toUpperCase();
  const fallback = pageXObjectStreams(reopened, [1]).map((stream) =>
    Buffer.from(PDFLib.decodePDFRawStream(stream).decode()).toString('latin1'));
  assert.ok(fallback.some((text) => text.includes('Latin fallback') || text.toUpperCase().includes(valueHex)));
});

test('readPdf rejects corrupt and empty bytes with user-facing errors', async () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode('not a PDF'), new TextEncoder().encode('%PDF-1.7\ntruncated')]) {
    await assert.rejects(() => readPdf(bytes), isAppError);
  }
});

test('generatePdf handles an unsorted selection in original page order without mutating the caller selection', async () => {
  const fixture = await createFixture({
    pageCount: 4,
    fields: [{ name: 'solicitud.razonSocial', value: 'Order company', pages: [0, 1, 2, 3] }],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const indexes = [3, 0, 2];
  const reopened = await PDFLib.PDFDocument.load(await generatePdf(pdfDoc, indexes));
  assert.deepEqual(indexes, [3, 0, 2]);
  assertOriginalPageOrder(reopened, [0, 2, 3], fixture.pageSizes);
  assertFlattened(reopened);
  assertDrawnAppearances(reopened);
});

test('a 25-page split preserves inherited page properties and copies shared image and font resources exactly once', async () => {
  const { PDFDocument, PDFName, PDFDict, PDFRef, PDFArray, PDFRawStream, StandardFonts } = PDFLib;
  const name = PDFName.of;
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const pixels = Uint8Array.from({ length: 128 * 128 * 3 }, (_, index) =>
    (index * 17 + (index >>> 5) * 31) & 255);
  const imageRef = source.context.register(source.context.stream(pixels, {
    Type: 'XObject', Subtype: 'Image', Width: 128, Height: 128,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  }));
  const resourcesRef = source.context.register(source.context.obj({
    Font: { SharedFont: font.ref },
    XObject: { SharedImage: imageRef },
  }));
  const parent = source.context.lookup(source.catalog.get(name('Pages')), PDFDict);
  parent.set(name('MediaBox'), source.context.obj([0, 0, 612, 792]));
  parent.set(name('Rotate'), source.context.obj(90));
  parent.set(name('Resources'), resourcesRef);
  const indexes = Array.from({ length: 25 }, (_, index) => index);
  for (const index of indexes) {
    const page = source.addPage([620 + index, 810 + index]);
    page.node.set(name('Resources'), resourcesRef);
    page.node.set(name('Rotate'), source.context.obj(0));
    const marker = `PAGE_${String(index).padStart(2, '0')}`;
    const operations = `q\n128 0 0 128 40 40 cm\n/SharedImage Do\nQ\nBT\n/SharedFont 12 Tf\n35 750 Td\n(${marker}) Tj\nET\n`;
    page.node.set(name('Contents'), source.context.register(
      source.context.stream(new TextEncoder().encode(operations))));
    if (index % 2 === 0) {
      for (const key of ['MediaBox', 'Rotate', 'Resources']) page.node.delete(name(key));
    }
  }

  const { pdfDoc } = await readPdf(await source.save({ updateFieldAppearances: false }));
  for (const index of indexes.filter((index) => index % 2 === 0)) {
    for (const key of ['MediaBox', 'Rotate', 'Resources']) {
      assert.equal(pdfDoc.getPage(index).node.has(name(key)), false,
        `Fixture page ${index} must genuinely inherit ${key}, not have a direct leaf entry`);
    }
  }
  const progress = [];
  const bytes = await generatePdf(pdfDoc, [...indexes].reverse(), {
    onProgress: (done, total) => progress.push([done, total]),
  });
  assertPageProgress(progress, 25);
  const reopened = await PDFDocument.load(bytes);
  assert.equal(reopened.getPageCount(), 25);
  assert.equal(new Set(reopened.getPages().map((page) => page.ref.toString())).size, 25,
    'Every copied page must have a distinct page reference');
  const imageRefs = new Set();
  const fontRefs = new Set();
  for (const [index, page] of reopened.getPages().entries()) {
    const inherited = index % 2 === 0;
    assert.deepEqual(page.getMediaBox(), {
      x: 0, y: 0, width: inherited ? 612 : 620 + index, height: inherited ? 792 : 810 + index,
    });
    assert.equal(page.getRotation().angle, inherited ? 90 : 0);
    const resources = page.node.Resources();
    const image = resources.lookup(name('XObject'), PDFDict).get(name('SharedImage'));
    const pageFont = resources.lookup(name('Font'), PDFDict).get(name('SharedFont'));
    assert.ok(image instanceof PDFRef);
    assert.ok(pageFont instanceof PDFRef);
    imageRefs.add(image.toString());
    fontRefs.add(pageFont.toString());
    assert.deepEqual(reopened.context.lookup(image, PDFRawStream).getContents(), pixels);
    assert.equal(reopened.context.lookup(pageFont, PDFDict).get(name('BaseFont')).toString(), '/Helvetica');
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, offset) => contents.lookup(offset, PDFRawStream))
      : [contents];
    const operations = streams.map((stream) =>
      Buffer.from(PDFLib.decodePDFRawStream(stream).decode()).toString('ascii')).join('\n');
    assert.ok(operations.includes(`(PAGE_${String(index).padStart(2, '0')}) Tj`),
      `Output page ${index} must contain the matching original content marker`);
    assert.match(operations, /\/SharedImage\s+Do\b/);
    assert.match(operations, /\/SharedFont\s+12\s+Tf\b/);
  }
  assert.equal(imageRefs.size, 1, 'All 25 pages must resolve to one shared image reference');
  assert.equal(fontRefs.size, 1, 'All 25 pages must resolve to one shared font reference');
  const objects = reopened.context.enumerateIndirectObjects().map(([, object]) => object);
  assert.equal(objects.filter((object) => object instanceof PDFRawStream &&
    object.dict.get(name('Subtype'))?.toString() === '/Image').length, 1);
  assert.equal(objects.filter((object) => object instanceof PDFDict &&
    object.get(name('Type'))?.toString() === '/Font').length, 1);
  const serialized = Buffer.from(bytes);
  const firstImage = serialized.indexOf(pixels);
  assert.ok(firstImage >= 0, 'The exact uncompressed source image bytes must survive serialization');
  assert.equal(serialized.indexOf(pixels, firstImage + 1), -1,
    'The image payload must occur once in the output, not once per copying batch');
});

test('flattening removes shared-field widgets while preserving unrelated link and text annotations', async () => {
  const fixture = await createFixture({
    pageCount: 2,
    fields: [{ name: 'solicitud.razonSocial', value: 'Annotated company', pages: [0, 1], omitPageReference: true }],
  });
  const { pdfDoc } = await readPdf(fixture.bytes);
  const { PDFName, PDFDict, PDFString, PDFHexString } = PDFLib;
  const uri = 'https://example.invalid/original-document';
  const note = 'Revisión: conservar esta nota';
  const annotations = [
    { Type: 'Annot', Subtype: 'Link', Rect: [20, 30, 180, 50], Border: [0, 0, 0],
      A: { S: 'URI', URI: PDFString.of(uri) } },
    { Type: 'Annot', Subtype: 'Text', Rect: [200, 30, 220, 50], Name: 'Comment',
      Contents: PDFHexString.fromText(note) },
  ];
  for (const annotation of annotations) {
    pdfDoc.getPage(0).node.addAnnot(pdfDoc.context.register(pdfDoc.context.obj(annotation)));
  }
  function assertAnnotationsRetained(document) {
    assertFlattened(document);
    const annotations = document.getPage(0).node.Annots();
    assert.equal(annotations.size(), 2, 'Only the two unrelated annotations should remain');
    const link = annotations.lookup(0, PDFDict);
    assert.equal(link.get(PDFName.of('Subtype')).toString(), '/Link');
    const action = link.lookup(PDFName.of('A'), PDFDict);
    assert.equal(action.get(PDFName.of('S')).toString(), '/URI');
    assert.equal(action.get(PDFName.of('URI')).decodeText(), uri);
    const text = annotations.lookup(1, PDFDict);
    assert.equal(text.get(PDFName.of('Subtype')).toString(), '/Text');
    assert.equal(text.get(PDFName.of('Contents')).decodeText(), note);
  }
  await prepareForSplitting(pdfDoc);
  assertAnnotationsRetained(pdfDoc);
  const reopened = await PDFLib.PDFDocument.load(await generatePdf(pdfDoc, [0, 1]));
  assertAnnotationsRetained(reopened);
  assertOriginalPageOrder(reopened, [0, 1], fixture.pageSizes);
  assertDrawnAppearances(reopened);
});

test('generatePdf rejects duplicate and invalid page selections before producing misleading output', async () => {
  const { bytes } = await createFixture({ pageCount: 2 });
  const { pdfDoc } = await readPdf(bytes);
  for (const indexes of [[], [-1], [2], [0.5], [0, 0]]) {
    await assert.rejects(() => generatePdf(pdfDoc, indexes), isAppError);
  }
});

test('XFA is rejected before getForm can delete the raw XFA entry', async () => {
  const { bytes } = await createFixture({ xfa: true });
  const originalBytes = Buffer.from(bytes);
  const originalGetForm = PDFLib.PDFDocument.prototype.getForm;
  let formCalls = 0;
  PDFLib.PDFDocument.prototype.getForm = function trackedGetForm() {
    formCalls += 1;
    return originalGetForm.call(this);
  };
  try {
    await assert.rejects(() => readPdf(bytes), isAppError);
    assert.equal(formCalls, 0, 'Raw /XFA must be checked before PDFLib.getForm() removes it');
  } finally {
    PDFLib.PDFDocument.prototype.getForm = originalGetForm;
  }
  assert.deepEqual(Buffer.from(bytes), originalBytes);

  const pdfDoc = await PDFLib.PDFDocument.load(bytes);
  const { PDFName, PDFDict } = PDFLib;
  const rawForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const xfaBefore = rawForm.get(PDFName.of('XFA'));
  assert.ok(xfaBefore, 'Fixture must contain a raw XFA entry before getForm');
  const xfaContents = Buffer.from(pdfDoc.context.lookup(xfaBefore).getContents());
  await assert.rejects(() => prepareForSplitting(pdfDoc), isAppError);
  assert.equal(rawForm.get(PDFName.of('XFA')), xfaBefore, 'Rejecting XFA must not mutate away the unsupported form');
  assert.deepEqual(Buffer.from(pdfDoc.context.lookup(xfaBefore).getContents()), xfaContents);
});
