'use strict';

const assert = require('node:assert/strict');
const { AppError, PDFLib } = require('./load-services');

function isAppError(error) {
  assert.ok(error instanceof AppError, `Expected AppError; received ${error?.constructor?.name}: ${error?.message}`);
  assert.equal(typeof error.code, 'string');
  assert.ok(error.code.length > 0);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  return true;
}

function assertPageProgress(events, total) {
  assert.ok(events.length > 0, 'The progress callback must be called');
  let previous = 0;
  for (const [done, reportedTotal] of events) {
    assert.equal(reportedTotal, total);
    assert.ok(Number.isInteger(done));
    assert.ok(done >= previous && done <= total, 'Page progress must be monotonic and bounded');
    previous = done;
  }
  assert.equal(events.at(-1)[0], total);
}

function assertFlattened(pdfDoc) {
  const { PDFName, PDFDict, PDFArray } = PDFLib;
  const acroForm = pdfDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  assert.ok(!fields || fields.size() === 0, 'Flattened PDFs must contain no interactive AcroForm fields');
  for (const [pageIndex, page] of pdfDoc.getPages().entries()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = pdfDoc.context.lookup(annotations.get(index));
      assert.ok(annotation instanceof PDFDict, `Page ${pageIndex} has a dangling or invalid annotation reference`);
      assert.notEqual(annotation.get(PDFName.of('Subtype'))?.toString(), '/Widget',
        `Page ${pageIndex} still references an original interactive widget`);
    }
  }
}

function normalAppearances(pdfDoc) {
  return pdfDoc.getForm().getFields().flatMap((field) => field.acroField.getWidgets().map((widget) => {
    const appearance = pdfDoc.context.lookup(widget.getNormalAppearance());
    assert.ok(appearance instanceof PDFLib.PDFRawStream, 'Fixture must have an existing normal appearance stream');
    return Buffer.from(appearance.getContents());
  }));
}

function pageXObjectStreams(pdfDoc, pageIndexes) {
  const { PDFName, PDFDict, PDFRawStream } = PDFLib;
  const contents = [];
  const seen = new Set();
  function visit(resources) {
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xObjects) return;
    for (const [, reference] of xObjects.entries()) {
      const stream = pdfDoc.context.lookup(reference);
      if (!(stream instanceof PDFRawStream) || seen.has(stream)) continue;
      seen.add(stream);
      contents.push(stream);
      visit(stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict));
    }
  }
  const pages = pageIndexes ? pageIndexes.map((index) => pdfDoc.getPage(index)) : pdfDoc.getPages();
  for (const page of pages) visit(page.node.Resources());
  return contents;
}

function pageXObjectContents(pdfDoc, pageIndexes) {
  return pageXObjectStreams(pdfDoc, pageIndexes).map((stream) => Buffer.from(stream.getContents()));
}

function assertDrawnAppearances(pdfDoc) {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
  for (const [pageIndex, page] of pdfDoc.getPages().entries()) {
    assert.ok(pageXObjectStreams(pdfDoc, [pageIndex]).length > 0, `Page ${pageIndex} needs a flattened appearance`);
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => pdfDoc.context.lookup(contents.get(index)))
      : [contents];
    const operations = streams.filter((stream) => stream instanceof PDFRawStream)
      .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
    assert.match(operations, /\/[^\s]+\s+Do\b/, `Page ${pageIndex} must actually draw its appearance, not merely retain an unused resource`);
  }
}

function assertOriginalPageOrder(pdfDoc, indexes, originalSizes) {
  assert.equal(pdfDoc.getPageCount(), indexes.length);
  assert.deepEqual(pdfDoc.getPages().map((page) => page.getSize()), indexes.map((index) => originalSizes[index]));
}

module.exports = {
  isAppError,
  assertPageProgress,
  assertFlattened,
  assertDrawnAppearances,
  normalAppearances,
  pageXObjectStreams,
  pageXObjectContents,
  assertOriginalPageOrder,
};
