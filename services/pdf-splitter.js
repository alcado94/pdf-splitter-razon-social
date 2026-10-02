(function (root) {
  'use strict';

  const api = root.PDFSplitter = root.PDFSplitter || {};
  const preparedDocuments = new WeakSet();
  const preparations = new WeakMap();
  const preparationFailures = new WeakMap();
  const FIELD_BATCH_SIZE = 25;
  const PAGE_BATCH_SIZE = 10;

  function appError(code, message, details) {
    return new api.AppError(code, message, details);
  }

  function addLocation(index, key, pageIndex) {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(pageIndex);
  }

  function isToggle(field, lib) {
    return field instanceof lib.PDFCheckBox || field instanceof lib.PDFRadioGroup;
  }

  // Read AP directly: getNormalAppearance() creates an AP dictionary if absent.
  // In state dictionaries AS describes the visible widget; V is the fallback.
  function inspectAppearance(pdfDoc, field, widget, lib) {
    const ap = widget.dict.lookup(lib.PDFName.of('AP'));
    if (ap !== undefined && !(ap instanceof lib.PDFDict)) {
      throw appError('UNSUPPORTED_APPEARANCE', 'El PDF contiene una apariencia de formulario que no se puede conservar. Abre el original en un lector PDF y vuelve a guardarlo.');
    }
    const rawNormal = ap && ap.get(lib.PDFName.of('N'));
    if (rawNormal === undefined) return { ap, normal: undefined, ref: undefined };
    const normal = pdfDoc.context.lookup(rawNormal);
    if (normal instanceof lib.PDFStream) {
      const ref = rawNormal instanceof lib.PDFRef ? rawNormal : pdfDoc.context.getObjectRef(normal);
      return { ap, normal, stream: normal, ref };
    }
    if (!(normal instanceof lib.PDFDict) || !isToggle(field, lib)) {
      throw appError('UNSUPPORTED_APPEARANCE', 'El PDF contiene una apariencia de formulario no compatible. No se ha generado una copia para evitar perder información.');
    }

    // Do not replace corrupt state streams with an invented blank appearance.
    for (const key of normal.keys()) {
      if (!(pdfDoc.context.lookup(normal.get(key)) instanceof lib.PDFStream)) {
        throw appError('UNSUPPORTED_APPEARANCE', 'Una de las apariencias del formulario está dañada y no se puede conservar. Vuelve a guardar el PDF original con sus campos visibles.');
      }
    }
    const state = widget.getAppearanceState();
    const value = field.acroField.getValue();
    const selected = state || value || lib.PDFName.of('Off');
    let rawSelected = normal.get(selected);
    // An unselected radio widget usually has no stream for the other option's V.
    if (rawSelected === undefined && !state) rawSelected = normal.get(lib.PDFName.of('Off'));
    if (rawSelected === undefined) return { ap, normal, ref: undefined };
    const stream = pdfDoc.context.lookup(rawSelected);
    const ref = rawSelected instanceof lib.PDFRef ? rawSelected : pdfDoc.context.getObjectRef(stream);
    return { ap, normal, stream, ref };
  }

  function regenerationKind(field, lib) {
    if (field instanceof lib.PDFTextField) {
      if (field.isRichFormatted()) return undefined;
      return 'text';
    }
    if (field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList) return 'choice';
    if (isToggle(field, lib)) return 'toggle';
    // Button graphics/captions and signature artwork cannot be reconstructed
    // reliably from a value. Existing appearances for these are still accepted.
    return undefined;
  }

  function seedToggleAppearance(pdfDoc, record, lib) {
    const widget = record.widget;
    const oldNormal = record.appearance.normal;
    let onValue;
    if (oldNormal instanceof lib.PDFDict) {
      onValue = oldNormal.keys().find(function (key) { return key !== lib.PDFName.of('Off'); });
    }
    const state = widget.getAppearanceState();
    const value = record.field.acroField.getValue();
    if (!onValue && state && state !== lib.PDFName.of('Off')) onValue = state;
    if (!onValue && record.field instanceof lib.PDFCheckBox && value !== lib.PDFName.of('Off')) {
      onValue = value;
    }
    if (!onValue && record.field instanceof lib.PDFRadioGroup && !state && value && value !== lib.PDFName.of('Off')) {
      throw appError('UNSUPPORTED_APPEARANCE', 'Un botón de opción no tiene una apariencia ni un estado que permita determinar si está seleccionado. Guarda el PDF original con sus apariencias antes de dividirlo.');
    }
    onValue = onValue || lib.PDFName.of('Yes');
    const normal = oldNormal instanceof lib.PDFDict ? oldNormal.clone(pdfDoc.context) : pdfDoc.context.obj({});
    // pdf-lib needs the on-state name before it can generate on/off graphics.
    // The placeholder is replaced synchronously by defaultUpdateAppearances().
    if (!normal.has(onValue)) normal.set(onValue, pdfDoc.context.obj({}));
    widget.dict.lookup(lib.PDFName.of('AP'), lib.PDFDict).set(lib.PDFName.of('N'), normal);
  }

  async function regenerateMissing(pdfDoc, field, records, font, lib) {
    const kind = regenerationKind(field, lib);
    if (!kind) {
      throw appError('UNSUPPORTED_APPEARANCE', 'Un campo del formulario no tiene una apariencia visible y su tipo no permite reconstruirla de forma segura. Guarda el original con sus apariencias antes de dividirlo.');
    }
    if (kind !== 'toggle') {
      const values = kind === 'text' ? [field.getText() || ''] : field.getSelected();
      try {
        for (const value of values) font.encodeText(value.replace(/[\r\n\t]/g, ''));
      } catch (error) {
        throw appError('UNSUPPORTED_APPEARANCE_TEXT', 'Un campo sin apariencia contiene caracteres que la fuente disponible no puede representar. Guarda el original con sus campos visibles para conservar ese texto.');
      }
    }

    const kidsKey = lib.PDFName.of('Kids');
    const apKey = lib.PDFName.of('AP');
    const normalKey = lib.PDFName.of('N');
    const originalKids = field.acroField.dict.get(kidsKey);
    for (let offset = 0; offset < records.length; offset += FIELD_BATCH_SIZE) {
      const batch = records.slice(offset, offset + FIELD_BATCH_SIZE);
      for (const record of batch) {
        const ap = record.appearance.ap;
        record.widget.dict.set(apKey, ap ? ap.clone(pdfDoc.context) : pdfDoc.context.obj({}));
        if (kind === 'toggle') seedToggleAppearance(pdfDoc, record, lib);
      }
      // Temporarily expose ONLY missing widgets to the public appearance API.
      // This prevents regeneration of existing (including Unicode) appearances.
      field.acroField.dict.set(kidsKey, pdfDoc.context.obj(batch.map(function (record) { return record.ref; })));
      try {
        field.defaultUpdateAppearances(font);
      } catch (error) {
        throw appError('APPEARANCE_GENERATION_FAILED', 'No se ha podido reconstruir un campo sin apariencia. Guarda el PDF original con sus campos visibles antes de dividirlo.');
      } finally {
        if (originalKids === undefined) field.acroField.dict.delete(kidsKey);
        else field.acroField.dict.set(kidsKey, originalKids);
      }

      for (const record of batch) {
        const generatedAp = record.widget.dict.lookup(apKey, lib.PDFDict);
        const oldAp = record.appearance.ap;
        if (oldAp) {
          for (const key of oldAp.keys()) {
            if (key !== normalKey) generatedAp.set(key, oldAp.get(key));
          }
          // When only one state was missing, retain every existing state stream.
          const oldNormal = record.appearance.normal;
          const newNormal = generatedAp.lookup(normalKey);
          if (oldNormal instanceof lib.PDFDict && newNormal instanceof lib.PDFDict) {
            for (const key of oldNormal.keys()) newNormal.set(key, oldNormal.get(key));
          }
        }
        record.appearance = inspectAppearance(pdfDoc, field, record.widget, lib);
        if (!record.appearance.stream) {
          throw appError('APPEARANCE_GENERATION_FAILED', 'Un campo sigue sin tener una apariencia visible. No se ha dividido el PDF para evitar perder información.');
        }
      }
      await api.yieldToBrowser();
    }
  }

  async function prepareDocument(pdfDoc, lib) {
    await api.yieldToBrowser();
    const acroForm = pdfDoc.catalog.getAcroForm();
    if (acroForm && acroForm.dict.has(lib.PDFName.of('XFA'))) {
      throw appError('XFA_UNSUPPORTED', 'Este PDF utiliza un formulario XFA, que no se puede aplanar de forma segura.');
    }
    if (pdfDoc.isEncrypted) {
      throw appError('ENCRYPTED_PDF', 'El PDF está cifrado. Guarda una copia sin protección antes de dividirlo.');
    }
    const form = acroForm && acroForm.Fields() ? pdfDoc.getForm() : undefined;
    const fields = form ? form.getFields() : [];
    const knownFields = new Set(fields.map(function (field) { return field.acroField.dict; }));
    if (form) {
      // getFields() silently skips unknown terminal types; never discard them.
      for (const entry of form.acroForm.getAllFields()) {
        const raw = entry[0];
        if (!knownFields.has(raw.dict) && !(raw instanceof lib.PDFAcroNonTerminal)) {
          throw appError('UNSUPPORTED_FIELD', 'El formulario contiene un tipo de campo no compatible. No se puede aplanar sin arriesgar la pérdida de datos.');
        }
      }
    }

    const pages = pdfDoc.getPages();
    const pageRefs = new Map();
    const annotationRefs = new Map();
    const annotationDicts = new Map();
    const originalAnnotations = [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const page = pages[pageIndex];
      pageRefs.set(page.ref.toString(), pageIndex);
      const annotations = page.node.Annots();
      const entries = [];
      for (let index = 0; annotations && index < annotations.size(); index++) {
        const entry = annotations.get(index);
        const dict = pdfDoc.context.lookup(entry);
        if (!(dict instanceof lib.PDFDict)) {
          throw appError('BROKEN_ANNOTATION', 'El PDF contiene una anotación dañada que no se puede conservar.', { page: pageIndex + 1 });
        }
        entries.push({ entry, dict });
        if (entry instanceof lib.PDFRef) addLocation(annotationRefs, entry.toString(), pageIndex);
        addLocation(annotationDicts, dict, pageIndex);
      }
      originalAnnotations.push(entries);
      if ((pageIndex + 1) % FIELD_BATCH_SIZE === 0) await api.yieldToBrowser();
    }

    const records = [];
    const widgetDicts = new Set();
    const widgetRefs = new Set();
    const missingByField = new Map();
    for (const field of fields) {
      if (!(field.ref instanceof lib.PDFRef)) {
        throw appError('UNSUPPORTED_FIELD', 'Un campo del formulario no tiene una referencia válida y no se puede aplanar de forma segura.');
      }
      const widgets = field.acroField.getWidgets();
      if (!widgets.length) {
        throw appError('ORPHAN_WIDGET', 'Hay un campo de formulario sin ubicación en ninguna página. Corrige o vuelve a guardar el PDF original antes de dividirlo.');
      }
      for (const widget of widgets) {
        if (widgetDicts.has(widget.dict)) {
          throw appError('AMBIGUOUS_WIDGET', 'Una misma anotación pertenece a varios campos del formulario y no se puede aplanar de forma segura.');
        }
        const ref = pdfDoc.context.getObjectRef(widget.dict);
        const locations = annotationDicts.get(widget.dict) || (ref && annotationRefs.get(ref.toString())) || new Set();
        const pageRef = widget.P();
        let pageIndex = pageRef && pageRefs.get(pageRef.toString());
        if (locations.size > 1 || (pageIndex !== undefined && locations.size && !locations.has(pageIndex))) {
          throw appError('AMBIGUOUS_WIDGET_LOCATION', 'Un campo del formulario está asociado a páginas incompatibles. Vuelve a guardar el PDF original antes de dividirlo.');
        }
        if (pageIndex === undefined && locations.size === 1) pageIndex = locations.values().next().value;
        if (pageIndex === undefined) {
          throw appError('ORPHAN_WIDGET', 'No se ha podido localizar la página de un campo del formulario. No se puede aplanar sin perder su contenido.');
        }
        const rectangle = widget.getRectangle();
        if (![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite) ||
            rectangle.width < 0 || rectangle.height < 0 || !widget.Rect()) {
          throw appError('INVALID_WIDGET_RECTANGLE', 'Un campo del formulario tiene una posición inválida y no se puede conservar.', { page: pageIndex + 1 });
        }
        const appearance = inspectAppearance(pdfDoc, field, widget, lib);
        const record = { field, widget, ref, pageIndex, appearance };
        records.push(record);
        widgetDicts.add(widget.dict);
        if (ref) widgetRefs.add(ref.toString());
        if (!appearance.stream) {
          if (!regenerationKind(field, lib)) {
            throw appError('UNSUPPORTED_APPEARANCE', 'Un campo sin apariencia visible no se puede reconstruir de forma segura. Guarda el PDF original con sus campos visibles antes de dividirlo.', { page: pageIndex + 1 });
          }
          if (!missingByField.has(field)) missingByField.set(field, []);
          missingByField.get(field).push(record);
        }
        if (records.length % 100 === 0) await api.yieldToBrowser();
      }
    }

    for (let pageIndex = 0; pageIndex < originalAnnotations.length; pageIndex++) {
      for (const annotation of originalAnnotations[pageIndex]) {
        if (annotation.dict.lookup(lib.PDFName.of('Subtype')) === lib.PDFName.of('Widget') &&
            !widgetDicts.has(annotation.dict)) {
          throw appError('ORPHAN_WIDGET', 'Hay una anotación de formulario que no pertenece a ningún campo reconocible. Vuelve a guardar el original para no perder ese contenido.', { page: pageIndex + 1 });
        }
      }
      if ((pageIndex + 1) % FIELD_BATCH_SIZE === 0) await api.yieldToBrowser();
    }

    // All unsupported/orphan checks precede flattening. Register direct widget
    // dictionaries and supply P so pdf-lib can also flatten Annots-only widgets.
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record.ref) record.ref = pdfDoc.context.register(record.widget.dict);
      widgetRefs.add(record.ref.toString());
      record.widget.setP(pages[record.pageIndex].ref);
      if ((index + 1) % 100 === 0) await api.yieldToBrowser();
    }
    let font;
    for (const entry of missingByField) {
      const field = entry[0];
      if (regenerationKind(field, lib) !== 'toggle' && !font) font = form.getDefaultFont();
      await regenerateMissing(pdfDoc, field, entry[1], font, lib);
    }

    // Turn each selected existing appearance into a stream reference. This keeps
    // stream content intact, supports direct streams, and respects widget AS
    // instead of pdf-lib's V-only fallback for check boxes and radio buttons.
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const appearance = record.appearance;
      const ref = appearance.ref || pdfDoc.context.register(appearance.stream);
      const ap = appearance.ap.clone(pdfDoc.context);
      ap.set(lib.PDFName.of('N'), ref);
      record.widget.dict.set(lib.PDFName.of('AP'), ap);
      if ((index + 1) % 100 === 0) await api.yieldToBrowser();
    }

    if (form && fields.length) {
      // flatten() is synchronous. Scope its getFields() snapshot to one batch,
      // restore the method before yielding, and keep the original form tree for
      // removeField() (including hierarchical parents and merged widgets).
      // A single field with thousands of widgets still runs in one synchronous
      // flatten call: pdf-lib offers no per-widget cooperative flatten API.
      const descriptor = Object.getOwnPropertyDescriptor(form, 'getFields');
      for (let offset = 0; offset < fields.length; offset += FIELD_BATCH_SIZE) {
        const batch = fields.slice(offset, offset + FIELD_BATCH_SIZE);
        try {
          form.getFields = function () { return batch; };
          form.flatten({ updateFieldAppearances: false });
        } finally {
          if (descriptor) Object.defineProperty(form, 'getFields', descriptor);
          else delete form.getFields;
        }
        await api.yieldToBrowser();
      }
    }

    // pdf-lib removes appearance refs rather than widget refs in removeField().
    // Rebuild from the pre-flatten cache: remove every original widget while
    // preserving unrelated annotations, even after widget objects were deleted.
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const kept = originalAnnotations[pageIndex].filter(function (annotation) {
        return !widgetDicts.has(annotation.dict) &&
          !(annotation.entry instanceof lib.PDFRef && widgetRefs.has(annotation.entry.toString()));
      }).map(function (annotation) { return annotation.entry; });
      if (kept.length) pages[pageIndex].node.set(lib.PDFName.of('Annots'), pdfDoc.context.obj(kept));
      else pages[pageIndex].node.delete(lib.PDFName.of('Annots'));
      if ((pageIndex + 1) % FIELD_BATCH_SIZE === 0) await api.yieldToBrowser();
    }
  }

  async function prepareForSplitting(pdfDoc) {
    const lib = root.PDFLib;
    if (!lib || !lib.PDFDocument) throw appError('PDF_LIBRARY_MISSING', 'No se ha cargado la biblioteca PDF local.');
    if (!pdfDoc || typeof pdfDoc.getPages !== 'function' || !pdfDoc.catalog || !pdfDoc.context) {
      throw appError('INVALID_PDF_DOCUMENT', 'No se ha recibido un documento PDF válido para dividir.');
    }
    if (preparedDocuments.has(pdfDoc)) return;
    if (preparationFailures.has(pdfDoc)) throw preparationFailures.get(pdfDoc);
    if (preparations.has(pdfDoc)) return preparations.get(pdfDoc);

    const preparation = (async function () {
      try {
        await prepareDocument(pdfDoc, lib);
        preparedDocuments.add(pdfDoc);
      } catch (error) {
        const friendly = error instanceof api.AppError ? error : appError('PDF_FLATTEN_FAILED', 'No se ha podido fijar el contenido del formulario. Vuelve a guardar el PDF original con sus campos visibles antes de dividirlo.');
        // A failed flatten may already have changed the document. Prevent a
        // retry from drawing widgets twice; the UI can reload the original bytes.
        preparationFailures.set(pdfDoc, friendly);
        throw friendly;
      } finally {
        preparations.delete(pdfDoc);
      }
    })();
    preparations.set(pdfDoc, preparation);
    return preparation;
  }

  async function generatePdf(pdfDoc, pageIndexes, { onProgress } = {}) {
    const lib = root.PDFLib;
    if (!lib || !lib.PDFDocument) throw appError('PDF_LIBRARY_MISSING', 'No se ha cargado la biblioteca PDF local.');
    if (!pdfDoc || typeof pdfDoc.getPageCount !== 'function') {
      throw appError('INVALID_PDF_DOCUMENT', 'No se ha recibido un documento PDF válido para dividir.');
    }
    const pageCount = pdfDoc.getPageCount();
    if (!Array.isArray(pageIndexes) || !pageIndexes.length ||
        pageIndexes.some(function (index) { return !Number.isInteger(index) || index < 0 || index >= pageCount; }) ||
        new Set(pageIndexes).size !== pageIndexes.length) {
      throw appError('INVALID_PAGE_SELECTION', 'Selecciona páginas válidas, sin duplicados, para generar el PDF.');
    }
    // Keep the original document order even if a caller supplies an unsorted selection.
    const orderedIndexes = pageIndexes.slice().sort(function (left, right) { return left - right; });
    const total = orderedIndexes.length;
    if (typeof onProgress === 'function') onProgress(0, total);
    await prepareForSplitting(pdfDoc);
    try {
      const output = await lib.PDFDocument.create();
      let copier;
      let sourcePages;
      let copiedPages;
      if (total > PAGE_BATCH_SIZE && lib.PDFObjectCopier &&
          typeof lib.PDFObjectCopier.for === 'function' && lib.PDFPage && typeof lib.PDFPage.of === 'function') {
        // copyPages() creates a fresh resource cache on every call. For larger
        // groups reuse its exported underlying copier across cooperative batches,
        // so shared images/fonts are copied once per output document.
        await pdfDoc.flush();
        copier = lib.PDFObjectCopier.for(pdfDoc.context, output.context);
        sourcePages = pdfDoc.getPages();
      } else {
        // Prefer the high-level API for a single batch. If a future vendor build
        // omits the core export, one high-level call still avoids duplication;
        // only that fallback's initial copy step cannot yield between pages.
        copiedPages = await output.copyPages(pdfDoc, orderedIndexes);
      }
      let done = 0;
      for (let offset = 0; offset < total; offset += PAGE_BATCH_SIZE) {
        const copied = copier ? orderedIndexes.slice(offset, offset + PAGE_BATCH_SIZE).map(function (index) {
          // The copier's page path materializes inherited Resources/boxes/Rotate
          // and strips the donor Parent before traversing references. Copy the
          // page node (not its ref) and register each leaf independently, exactly
          // as copyPages() does, so page pointers remain distinct.
          const node = copier.copy(sourcePages[index].node);
          const ref = output.context.register(node);
          return lib.PDFPage.of(node, ref, output);
        }) : copiedPages.slice(offset, offset + PAGE_BATCH_SIZE);
        for (const page of copied) {
          output.addPage(page);
          if (typeof onProgress === 'function') onProgress(++done, total);
          else done++;
        }
        await api.yieldToBrowser();
      }
      const bytes = await output.save({ objectsPerTick: 25, updateFieldAppearances: false, addDefaultPage: false });
      await api.yieldToBrowser();
      return bytes;
    } catch (error) {
      if (error instanceof api.AppError) throw error;
      throw appError('PDF_GENERATION_FAILED', 'No se ha podido generar el PDF dividido. Inténtalo de nuevo con menos páginas.');
    }
  }

  Object.assign(api, { prepareForSplitting, generatePdf });
})(globalThis);
