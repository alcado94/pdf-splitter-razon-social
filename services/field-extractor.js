(function (root) {
  'use strict';

  const api = root.PDFSplitter = root.PDFSplitter || {};
  const PAGE_BATCH_SIZE = 25;
  const WIDGET_BATCH_SIZE = 100;

  function normalizeCompanyName(name) {
    return (name == null ? '' : String(name)).normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
  }

  function comparisonKey(name) {
    return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function fieldNameKey(name) {
    return comparisonKey(name).replace(/[\s_]+/g, '');
  }

  function matchesField(name, configured) {
    const target = fieldNameKey(configured);
    if (configured.includes('.')) return fieldNameKey(name) === target;
    return fieldNameKey(name) === target || fieldNameKey(name.slice(name.lastIndexOf('.') + 1)) === target;
  }

  function addLocation(index, key, pageIndex) {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(pageIndex);
  }

  async function extractCompanies(pdfDoc, { companyField = 'razonSocial', onProgress } = {}) {
    const lib = root.PDFLib;
    if (!lib || !lib.PDFTextField) {
      throw new api.AppError('PDF_LIBRARY_MISSING', 'No se ha cargado la biblioteca PDF local.');
    }
    if (typeof companyField !== 'string' || !fieldNameKey(companyField)) {
      throw new api.AppError('INVALID_COMPANY_FIELD', 'Indica el nombre del campo que contiene la razón social.');
    }

    try {
      const pages = pdfDoc.getPages();
      const totalPages = pages.length;
      const pageRefs = new Map();
      const annotationRefs = new Map();
      const annotationDicts = new Map();
      const candidates = Array.from({ length: totalPages }, function () { return new Map(); });
      if (typeof onProgress === 'function') onProgress(0, totalPages);

      // Index once; widget lookup does not repeatedly scan the entire document.
      for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
        const page = pages[pageIndex];
        pageRefs.set(page.ref.toString(), pageIndex);
        const annotations = page.node.Annots();
        for (let index = 0; annotations && index < annotations.size(); index++) {
          const annotation = annotations.get(index);
          if (annotation instanceof lib.PDFRef) {
            addLocation(annotationRefs, annotation.toString(), pageIndex);
          }
          const dict = pdfDoc.context.lookup(annotation);
          if (dict instanceof lib.PDFDict) addLocation(annotationDicts, dict, pageIndex);
        }
        if ((pageIndex + 1) % PAGE_BATCH_SIZE === 0) await api.yieldToBrowser();
      }

      const acroForm = pdfDoc.catalog.getAcroForm();
      if (acroForm && acroForm.dict.has(lib.PDFName.of('XFA'))) {
        throw new api.AppError('XFA_UNSUPPORTED', 'Este PDF utiliza un formulario XFA, que no se puede analizar.');
      }
      const fields = acroForm && acroForm.Fields() ? pdfDoc.getForm().getFields() : [];
      let processedWidgets = 0;
      for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
        const field = fields[fieldIndex];
        if (field instanceof lib.PDFTextField && matchesField(field.getName(), companyField)) {
          const name = normalizeCompanyName(field.getText());
          // Company values group equivalent case/whitespace forms, but retain
          // accents and punctuation. Diacritic folding is only for field names.
          const key = name;
          const widgets = field.acroField.getWidgets();
          // All widgets of one field share its value. Distinct field dictionaries
          // (e.g. solicitud1.razonSocial and solicitud2.razonSocial) do not.
          for (const widget of widgets) {
            const pageRef = widget.P();
            const pageIndex = pageRef && pageRefs.get(pageRef.toString());
            let locations;
            if (pageIndex !== undefined) {
              locations = [pageIndex];
            } else {
              const ref = pdfDoc.context.getObjectRef(widget.dict);
              locations = (ref && annotationRefs.get(ref.toString())) || annotationDicts.get(widget.dict) || [];
            }
            for (const location of locations) {
              candidates[location].set(field.acroField.dict, { name, key });
            }
            if (++processedWidgets % WIDGET_BATCH_SIZE === 0) await api.yieldToBrowser();
          }
        }
        if ((fieldIndex + 1) % WIDGET_BATCH_SIZE === 0) await api.yieldToBrowser();
      }

      const companies = new Map();
      const displayNames = new Map();
      const unidentifiedPages = [];
      const conflictingPages = [];
      for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
        const values = candidates[pageIndex];
        const names = new Map();
        let hasEmptyCandidate = false;
        values.forEach(function (candidate) {
          if (!candidate.key) hasEmptyCandidate = true;
          else if (!names.has(candidate.key)) names.set(candidate.key, candidate.name);
        });

        // A populated field alongside an empty matching field is ambiguous too:
        // classify the page as unidentified, but not as a nonempty-value conflict.
        if (names.size !== 1 || hasEmptyCandidate) {
          unidentifiedPages.push(pageIndex);
          if (names.size > 1) conflictingPages.push(pageIndex);
        } else {
          const entry = names.entries().next().value;
          const key = entry[0];
          if (!displayNames.has(key)) {
            displayNames.set(key, entry[1]);
            companies.set(entry[1], []);
          }
          companies.get(displayNames.get(key)).push(pageIndex);
        }
        if (typeof onProgress === 'function') onProgress(pageIndex + 1, totalPages);
        if ((pageIndex + 1) % PAGE_BATCH_SIZE === 0) await api.yieldToBrowser();
      }
      await api.yieldToBrowser();
      return { companies, unidentifiedPages, conflictingPages, totalPages };
    } catch (error) {
      if (error instanceof api.AppError) throw error;
      throw new api.AppError('FIELD_EXTRACTION_FAILED', 'No se han podido analizar los campos del formulario. Comprueba que el PDF contiene campos de texto AcroForm válidos.');
    }
  }

  Object.assign(api, { normalizeCompanyName, extractCompanies });
})(globalThis);
