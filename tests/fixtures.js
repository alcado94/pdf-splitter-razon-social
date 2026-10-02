'use strict';

// These fixtures are also usable by a browser check: load PDFLib first, then
// this file, and use globalThis.PDFSplitterTestFixtures.
(function exposeFixtures(root) {
  function library() {
    if (!root.PDFLib && typeof require === 'function') {
      root.PDFLib = require('../lib/pdf-lib.min.js');
    }
    if (!root.PDFLib) throw new Error('Load the vendored PDFLib before generating fixtures.');
    return root.PDFLib;
  }

  function pageSize(index) {
    return { width: 600 + index * 7, height: 800 + index * 11 };
  }

  async function createFixture({ pageCount = 1, fields = [], xfa = false } = {}) {
    const { PDFDocument, StandardFonts, PDFName, PDFHexString } = library();
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = Array.from({ length: pageCount }, (_, index) => {
      const { width, height } = pageSize(index);
      const page = pdfDoc.addPage([width, height]);
      page.drawText(`Original page ${index + 1}`, { x: 35, y: height - 35, font, size: 12 });
      return page;
    });
    const form = pdfDoc.getForm();
    const created = fields.map((spec, index) => {
      const field = form.createTextField(spec.name);
      const visibleValue = spec.appearanceText === undefined ? spec.value : spec.appearanceText;
      if (visibleValue !== undefined) field.setText(visibleValue);
      for (const pageIndex of spec.pages || [0]) {
        field.addToPage(pages[pageIndex], {
          x: 40,
          y: 80 + index * 35,
          width: 350,
          height: 25,
          font,
        });
      }
      return { field, spec };
    });
    form.updateFieldAppearances(font);

    for (const { field, spec } of created) {
      const widgets = field.acroField.getWidgets();
      for (const [widgetIndex, widget] of widgets.entries()) {
        if (spec.omitPageReference) widget.dict.delete(PDFName.of('P'));
        const pageIndex = (spec.pages || [0])[widgetIndex];
        if (spec.missingAppearance || spec.missingAppearancePages?.includes(pageIndex)) {
          widget.dict.delete(PDFName.of('AP'));
        }
      }
      // Write /V directly so saving never attempts to encode Unicode with
      // Helvetica. Its already-built ASCII appearance must remain untouched.
      if (spec.rawValue !== undefined) {
        field.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(spec.rawValue));
      }
      if (spec.merged) {
        if (widgets.length !== 1) throw new Error('A merged fixture needs exactly one widget.');
        const widget = widgets[0];
        const widgetRef = pdfDoc.context.getObjectRef(widget.dict);
        for (const [key, value] of widget.dict.entries()) {
          // Keep the terminal field's existing hierarchy parent, rather than
          // the widget's parent (which would point back to this same field).
          if (key.toString() !== '/Parent') field.acroField.dict.set(key, value);
        }
        field.acroField.dict.delete(PDFName.of('Kids'));
        for (const page of pages) {
          const annotations = page.node.Annots();
          if (!annotations) continue;
          const position = annotations.indexOf(widgetRef);
          if (position !== undefined) annotations.set(position, field.ref);
        }
      }
    }

    if (xfa) {
      const xml = pdfDoc.context.stream('<xfa>fixture: do not remove on validation</xfa>');
      form.acroForm.dict.set(PDFName.of('XFA'), pdfDoc.context.register(xml));
    }

    const bytes = await pdfDoc.save({ updateFieldAppearances: false });
    return { bytes, pageSizes: pages.map((_, index) => pageSize(index)) };
  }

  async function createGroupingFixture() {
    const fixture = await createFixture({
      pageCount: 9,
      fields: [
        {
          name: 'solicitud0.razonSocial',
          value: 'Árbol Norte, S.L.',
          pages: [0, 7, 8],
          omitPageReference: true,
        },
        { name: 'solicitud1.razonSocial', value: 'Beta Sur, S.A.', pages: [1] },
        { name: 'solicitud2.razonSocial', value: '  Árbol   Norte, S.L.  ', pages: [2] },
        // Two agreeing widgets on page 2 must not duplicate the page or
        // classify it as a conflict.
        { name: 'solicitud2bis.razonSocial', value: 'Árbol Norte, S.L.', pages: [2] },
        { name: 'solicitud4a.razonSocial', value: 'Árbol Norte, S.L.', pages: [4] },
        { name: 'solicitud4b.razonSocial', value: 'Beta Sur, S.A.', pages: [4] },
        { name: 'solicitud5.razonSocial', value: 'Beta Sur, S.A.', pages: [5] },
        { name: 'solicitud6.razonSocial', value: '   ', pages: [6] },
        // A near match is not the configured company field.
        { name: 'solicitud3.razonSocialExtra', value: 'False positive', pages: [3] },
      ],
    });
    return {
      ...fixture,
      expectedCompanies: new Map([
        ['ÁRBOL NORTE, S.L.', [0, 2, 7, 8]],
        ['BETA SUR, S.A.', [1, 5]],
      ]),
      // Conflicts are a diagnostic subset of all unassignable pages.
      unidentifiedPages: [3, 4, 6],
      conflictingPages: [4],
    };
  }

  const api = { createFixture, createGroupingFixture, pageSize };
  root.PDFSplitterTestFixtures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
