(function () {
  'use strict';

  const CONFIG = { companyField: 'razonSocial' };
  const DEBUG = false;

  const byId = (id) => document.getElementById(id);
  const ui = {
    app: byId('app'),
    upload: byId('upload-panel'),
    input: byId('file-input'),
    select: byId('select-file'),
    dropZone: byId('drop-zone'),
    source: byId('source-panel'),
    sourceFilename: byId('source-filename'),
    sourceDetails: byId('source-details'),
    progressPanel: byId('progress-panel'),
    progressTitle: byId('progress-title'),
    progressDescription: byId('progress-description'),
    progressPercent: byId('progress-percent'),
    progress: byId('task-progress'),
    results: byId('results-panel'),
    resultsTitle: byId('results-title'),
    resultsSummary: byId('results-summary'),
    companyList: byId('company-list'),
    unidentified: byId('unidentified-panel'),
    unidentifiedDescription: byId('unidentified-description'),
    unidentifiedPages: byId('unidentified-pages'),
    continueUnidentified: byId('continue-unidentified'),
    unidentifiedConfirmed: byId('unidentified-confirmed'),
    conflicting: byId('conflicting-panel'),
    conflictingDescription: byId('conflicting-description'),
    zip: byId('download-zip'),
    outputHelp: byId('output-help'),
    completion: byId('completion-message'),
    resetActions: byId('reset-actions'),
    reset: byId('reset-button'),
    errorPanel: byId('error-panel'),
    errorTitle: byId('error-title'),
    errorMessage: byId('error-message'),
    errorDetails: byId('error-details'),
    retry: byId('retry-error'),
    status: byId('status-message')
  };

  const busyStatuses = new Set(['loading', 'analyzing', 'generating']);
  const pendingDownloads = new Map();
  const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  let status = 'idle';
  let services = null;
  let dependenciesReady = false;
  let currentDocument = null;
  let errorState = null;
  let revision = 0;
  let dragDepth = 0;
  let outputButtons = [];

  function isBusy() {
    return busyStatuses.has(status);
  }

  function canSelect() {
    return dependenciesReady && !isBusy() && !currentDocument;
  }

  function canDownload() {
    return dependenciesReady && !isBusy() && currentDocument &&
      currentDocument.groups && currentDocument.confirmed && !currentDocument.requiresReset;
  }

  function announce(message) {
    ui.status.textContent = message;
  }

  function refreshControls() {
    const busy = isBusy();
    const selectable = canSelect();
    const downloadable = Boolean(canDownload());
    ui.app.dataset.status = status;
    ui.select.disabled = !selectable;
    ui.input.disabled = !selectable;
    ui.dropZone.tabIndex = selectable ? 0 : -1;
    ui.dropZone.setAttribute('aria-disabled', String(!selectable));
    ui.upload.hidden = Boolean(currentDocument) || !dependenciesReady;
    ui.source.hidden = !currentDocument;
    ui.progressPanel.hidden = !busy;
    ui.progressPanel.setAttribute('aria-busy', String(busy));
    ui.results.hidden = !currentDocument || !currentDocument.groups;
    ui.zip.disabled = !downloadable;
    outputButtons.forEach((button) => { button.disabled = !downloadable; });
    ui.continueUnidentified.disabled = busy || Boolean(currentDocument && currentDocument.requiresReset);
    ui.continueUnidentified.hidden = !currentDocument || currentDocument.confirmed;
    ui.unidentifiedConfirmed.hidden = !currentDocument || !currentDocument.confirmed;
    ui.resetActions.hidden = !dependenciesReady || (!currentDocument && !errorState);
    ui.reset.disabled = busy;
    ui.errorPanel.hidden = !errorState;
    ui.retry.hidden = !errorState || !errorState.retry;
    ui.retry.disabled = busy;
    if (currentDocument && currentDocument.groups) {
      if (currentDocument.requiresReset) {
        ui.outputHelp.textContent = 'Procesa de nuevo el PDF para volver a generar los documentos.';
      } else if (!currentDocument.confirmed) {
        ui.outputHelp.textContent = 'Confirma las páginas sin razón social para habilitar todas las descargas.';
      } else {
        ui.outputHelp.textContent = 'Cada documento tendrá su propio archivo PDF dentro del ZIP.';
      }
    }
  }

  function setStatus(nextStatus, message) {
    status = nextStatus;
    refreshControls();
    if (message) announce(message);
  }

  function updateProgress(title, description, percent = null) {
    ui.progressTitle.textContent = title;
    ui.progressDescription.textContent = description;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      const value = Math.min(100, Math.max(0, percent));
      ui.progress.value = value;
      ui.progressPercent.textContent = `${Math.floor(value)} %`;
    } else {
      ui.progress.removeAttribute('value');
      ui.progressPercent.textContent = 'En curso';
    }
  }

  function progressRatio(done, total) {
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
    return Math.min(1, Math.max(0, done / total));
  }

  function logError(stage, error) {
    // Deliberately exclude document names, field values, bytes and raw error messages.
    console.warn('[PDFSplitter]', {
      stage,
      type: services && error instanceof services.AppError ? 'AppError' : error instanceof Error ? 'Error' : 'Unknown',
      code: error && typeof error.code === 'string' && /^[A-Z_\d]+$/.test(error.code) ? error.code : 'UNEXPECTED_ERROR'
    });
  }

  function logFieldNames(fields) {
    if (!DEBUG || !Array.isArray(fields)) return;
    const names = fields.map((field) => {
      try {
        return field && typeof field.getName === 'function' ? field.getName() : null;
      } catch {
        return null;
      }
    }).filter((name) => typeof name === 'string');
    console.debug('[PDFSplitter] Campos disponibles', names);
  }

  function clearError() {
    errorState = null;
    ui.errorMessage.textContent = '';
    ui.errorDetails.textContent = '';
    ui.errorDetails.hidden = true;
  }

  function showError(message, { retry = null, details = '', title = 'No hemos podido continuar' } = {}) {
    errorState = { retry };
    ui.errorTitle.textContent = title;
    ui.errorMessage.textContent = message;
    ui.errorDetails.textContent = details;
    ui.errorDetails.hidden = !details;
    ui.retry.textContent = retry && retry.type === 'dependencies' ? 'Volver a comprobar' : 'Volver a intentar';
    setStatus('error', message);
    ui.errorTitle.focus({ preventScroll: true });
  }

  function checkDependencies() {
    const missing = new Set();
    if (!globalThis.PDFLib || !globalThis.PDFLib.PDFDocument) missing.add('lib/pdf-lib.min.js');
    if (typeof globalThis.JSZip !== 'function') missing.add('lib/jszip.min.js');
    const namespace = globalThis.PDFSplitter;
    const required = {
      AppError: 'utils/validation.js',
      validateFileSelection: 'utils/validation.js',
      yieldToBrowser: 'utils/validation.js',
      sanitizeFilename: 'utils/filename.js',
      uniqueFilename: 'utils/filename.js',
      readPdf: 'services/pdf-reader.js',
      extractCompanies: 'services/field-extractor.js',
      prepareForSplitting: 'services/pdf-splitter.js',
      generatePdf: 'services/pdf-splitter.js',
      createZip: 'services/zip-generator.js'
    };
    Object.entries(required).forEach(([name, path]) => {
      if (!namespace || typeof namespace[name] !== 'function') missing.add(path);
    });
    dependenciesReady = missing.size === 0;
    if (!dependenciesReady) {
      logError('startup', { code: 'MISSING_DEPENDENCIES' });
      showError('No se han podido cargar los componentes locales. Mantén este archivo junto a las carpetas lib, utils y services y vuelve a abrir index.html.', {
        title: 'Faltan componentes de la aplicación',
        retry: { type: 'dependencies' },
        details: `Comprueba estos archivos: ${Array.from(missing).join(', ')}.`
      });
      return false;
    }
    services = namespace;
    clearError();
    setStatus('idle');
    return true;
  }

  function fileSizeLabel(size) {
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(size / (1024 * 1024))} MB`;
  }

  function pageLabel(count) {
    return `${count} ${count === 1 ? 'página' : 'páginas'}`;
  }

  function updateSource() {
    ui.sourceFilename.textContent = currentDocument.fileName;
    const details = [fileSizeLabel(currentDocument.fileSize)];
    if (currentDocument.totalPages) details.push(pageLabel(currentDocument.totalPages));
    ui.sourceDetails.textContent = details.filter(Boolean).join(' · ');
  }

  function invalidResult() {
    return new services.AppError('INVALID_RESULT', 'No se ha podido organizar el PDF.');
  }

  function copyPageIndexes(indexes, totalPages) {
    if (!Array.isArray(indexes) || indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= totalPages)) {
      throw invalidResult();
    }
    return Array.from(new Set(indexes)).sort((a, b) => a - b);
  }

  function buildGroups(extracted, totalPages) {
    if (!extracted || !(extracted.companies instanceof Map) || extracted.totalPages !== totalPages) throw invalidResult();
    const unknown = new Set(copyPageIndexes(extracted.unidentifiedPages, totalPages));
    const conflicts = copyPageIndexes(extracted.conflictingPages, totalPages);
    const assigned = new Set();
    const companies = [];
    for (const [name, indexes] of extracted.companies) {
      const pages = copyPageIndexes(indexes, totalPages);
      if (typeof name !== 'string' || !name.trim()) {
        pages.forEach((index) => unknown.add(index));
        continue;
      }
      companies.push({ name, pageIndexes: pages, isUnidentified: false });
    }
    // Account for every original page, even if a service omits an unassigned page.
    companies.forEach((group) => {
      group.pageIndexes = group.pageIndexes.filter((index) => !unknown.has(index));
      group.pageIndexes.forEach((index) => {
        if (assigned.has(index)) throw invalidResult();
        assigned.add(index);
      });
    });
    for (let index = 0; index < totalPages; index += 1) {
      if (!assigned.has(index)) unknown.add(index);
    }
    const unidentifiedPages = Array.from(unknown).sort((a, b) => a - b);
    const usedNames = new Set();
    // Reserve this exact name before company names can collide with it.
    const unidentifiedFilename = unidentifiedPages.length ? services.uniqueFilename('SIN_RAZON_SOCIAL', usedNames) : null;
    const groups = companies.filter((group) => group.pageIndexes.length).sort((a, b) => collator.compare(a.name, b.name));
    groups.forEach((group) => { group.filename = services.uniqueFilename(group.name, usedNames); });
    if (unidentifiedPages.length) {
      groups.push({ name: 'Sin razón social', pageIndexes: unidentifiedPages, filename: unidentifiedFilename, isUnidentified: true });
    }
    return { groups, unidentifiedPages, conflictingPages: conflicts };
  }

  function pageNumbers(indexes) {
    const ranges = [];
    for (let cursor = 0; cursor < indexes.length; cursor += 1) {
      const start = indexes[cursor] + 1;
      let end = start;
      while (cursor + 1 < indexes.length && indexes[cursor + 1] === indexes[cursor] + 1) {
        cursor += 1;
        end = indexes[cursor] + 1;
      }
      ranges.push(start === end ? String(start) : `${start}–${end}`);
    }
    return ranges.join(', ');
  }

  function renderResults(doc) {
    outputButtons = [];
    ui.companyList.replaceChildren();
    ui.resultsSummary.textContent = `${doc.groups.length} ${doc.groups.length === 1 ? 'documento' : 'documentos'} con las ${doc.totalPages} ${doc.totalPages === 1 ? 'página del original' : 'páginas del original'}.`;
    const fragment = document.createDocumentFragment();
    doc.groups.forEach((group) => {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      const name = document.createElement('p');
      name.className = 'company-name';
      name.textContent = group.name;
      const filename = document.createElement('p');
      filename.className = 'company-filename';
      filename.textContent = group.filename;
      nameCell.append(name, filename);
      if (group.isUnidentified) {
        const label = document.createElement('span');
        label.className = 'unidentified-label';
        label.textContent = 'Para revisar';
        nameCell.append(label);
      }
      const pageCell = document.createElement('td');
      pageCell.className = 'pages-column page-count';
      pageCell.textContent = String(group.pageIndexes.length);
      const downloadCell = document.createElement('td');
      downloadCell.className = 'download-column';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-secondary download-individual';
      button.setAttribute('aria-label', `Descargar PDF de ${group.name}`);
      button.setAttribute('aria-describedby', 'output-help');
      // Clone a static icon; no document content is interpreted as markup.
      button.append(ui.zip.querySelector('svg').cloneNode(true));
      const buttonText = document.createElement('span');
      buttonText.className = 'button-text';
      buttonText.textContent = 'Descargar PDF';
      button.append(buttonText);
      button.addEventListener('click', () => {
        if (currentDocument === doc) runDownload({ type: 'individual', group });
      });
      outputButtons.push(button);
      downloadCell.append(button);
      row.append(nameCell, pageCell, downloadCell);
      fragment.append(row);
    });
    ui.companyList.append(fragment);
    ui.unidentified.hidden = doc.unidentifiedPages.length === 0;
    if (doc.unidentifiedPages.length) {
      ui.unidentifiedDescription.textContent = `No hemos podido asignar ${pageLabel(doc.unidentifiedPages.length)} a una empresa. Se guardarán juntas en SIN_RAZON_SOCIAL.pdf. Ninguna página se perderá.`;
      ui.unidentifiedPages.textContent = `Páginas: ${pageNumbers(doc.unidentifiedPages)}.`;
    }
    ui.conflicting.hidden = doc.conflictingPages.length === 0;
    if (doc.conflictingPages.length) {
      const allUnidentified = doc.conflictingPages.every((index) => doc.unidentifiedPages.includes(index));
      ui.conflictingDescription.textContent = `Se han encontrado razones sociales distintas en estas páginas: ${pageNumbers(doc.conflictingPages)}. ${allUnidentified ? 'Se han incluido en «Sin razón social» para que puedas revisarlas con el PDF original.' : 'Revisa su clasificación con el PDF original antes de usar los documentos.'}`;
    }
  }

  async function processSelection(files) {
    if (!canSelect()) return;
    let file;
    try {
      file = services.validateFileSelection(files);
    } catch (error) {
      logError('validation', error);
      ui.input.value = '';
      const count = files ? files.length : 0;
      const message = count !== 1 ? 'Selecciona un único archivo PDF para continuar.' :
        'No podemos utilizar este archivo. Selecciona un PDF válido que no esté vacío.';
      showError(error instanceof services.AppError ? error.message : message);
      return;
    }

    const runId = ++revision;
    clearError();
    currentDocument = {
      fileName: file.name,
      fileSize: file.size,
      totalPages: null,
      pdfDoc: null,
      groups: null,
      unidentifiedPages: [],
      conflictingPages: [],
      confirmed: false,
      preparation: 'pending',
      requiresReset: false,
      cache: new Map(),
      zipCache: null
    };
    updateSource();
    ui.completion.hidden = true;
    updateProgress('Leyendo el PDF', 'Abriendo el archivo en tu navegador.');
    setStatus('loading', 'Leyendo el PDF. Los archivos nunca salen de tu ordenador.');
    let stage = 'reading';
    try {
      const bytes = await file.arrayBuffer();
      if (runId !== revision) return;
      const read = await services.readPdf(bytes, { debug: DEBUG });
      if (runId !== revision) return;
      if (!read || !read.pdfDoc || !Number.isInteger(read.totalPages) || read.totalPages <= 0) throw invalidResult();
      logFieldNames(read.fields);
      currentDocument.pdfDoc = read.pdfDoc;
      currentDocument.totalPages = read.totalPages;
      updateSource();
      stage = 'analysis';
      updateProgress('Buscando razones sociales', `0 de ${read.totalPages} páginas analizadas.`, 0);
      setStatus('analyzing', 'Buscando la razón social en todas las páginas.');
      const extracted = await services.extractCompanies(read.pdfDoc, {
        companyField: CONFIG.companyField,
        onProgress(done, total) {
          if (runId !== revision || status !== 'analyzing') return;
          const ratio = progressRatio(done, total);
          const completed = ratio === null ? 0 : Math.floor(ratio * read.totalPages);
          updateProgress('Buscando razones sociales', `${completed} de ${read.totalPages} páginas analizadas.`, ratio === null ? null : ratio * 100);
        }
      });
      if (runId !== revision) return;
      Object.assign(currentDocument, buildGroups(extracted, read.totalPages));
      currentDocument.confirmed = currentDocument.unidentifiedPages.length === 0;
      renderResults(currentDocument);
      setStatus('processed', currentDocument.confirmed ?
        'Análisis completado. Ya puedes descargar los documentos.' :
        'Análisis completado. Confirma las páginas sin razón social antes de descargar.');
      ui.resultsTitle.focus({ preventScroll: true });
    } catch (error) {
      if (runId !== revision) return;
      logError(stage, error);
      currentDocument.requiresReset = true;
      const message = stage === 'reading' ?
        'No hemos podido abrir este PDF. Comprueba que no esté dañado ni protegido con contraseña.' :
        'No hemos podido analizar todas las páginas.';
      showError(error instanceof services.AppError ? error.message : message, {
        details: 'Pulsa «Procesar otro PDF» para volver a intentarlo con el archivo original.'
      });
    } finally {
      ui.input.value = '';
    }
  }

  async function prepareOnce(doc) {
    if (doc.preparation === 'ready') return;
    if (doc.preparation !== 'pending') throw invalidResult();
    doc.preparation = 'working';
    updateProgress('Preparando el PDF', 'Conservando los campos del formulario en las páginas.');
    try {
      await services.prepareForSplitting(doc.pdfDoc);
      doc.preparation = 'ready';
    } catch (error) {
      // Flattening may have modified the source before failing. Start with a fresh file.
      doc.preparation = 'failed';
      doc.requiresReset = true;
      throw error;
    }
  }

  async function groupBytes(doc, group, onProgress) {
    if (doc.cache.has(group.filename)) return doc.cache.get(group.filename);
    await prepareOnce(doc);
    const bytes = await services.generatePdf(doc.pdfDoc, group.pageIndexes, { onProgress });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw invalidResult();
    doc.cache.set(group.filename, bytes);
    return bytes;
  }

  function revokeDownload(url) {
    const timer = pendingDownloads.get(url);
    if (timer !== undefined) clearTimeout(timer);
    URL.revokeObjectURL(url);
    pendingDownloads.delete(url);
  }

  function cleanupDownloads() {
    Array.from(pendingDownloads.keys()).forEach(revokeDownload);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    // Give the browser time to consume the URL before releasing it.
    pendingDownloads.set(url, setTimeout(() => revokeDownload(url), 60000));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    try {
      anchor.click();
    } catch (error) {
      revokeDownload(url);
      throw error;
    } finally {
      anchor.remove();
    }
  }

  async function runDownload(request) {
    if (!canDownload()) return;
    const doc = currentDocument;
    const runId = revision;
    clearError();
    ui.completion.hidden = true;
    updateProgress('Preparando la descarga', 'Los documentos se generan solo cuando los necesitas.');
    setStatus('generating', request.type === 'zip' ? 'Preparando todos los documentos y el ZIP.' : 'Preparando el documento PDF.');
    let stage = 'preparation';
    try {
      if (request.type === 'individual') {
        const group = request.group;
        if (!doc.groups.includes(group)) throw invalidResult();
        if (!doc.cache.has(group.filename)) await prepareOnce(doc);
        stage = 'pdf';
        updateProgress('Creando el documento', `0 de ${group.pageIndexes.length} páginas preparadas.`, 0);
        const bytes = await groupBytes(doc, group, (done, total) => {
          if (runId !== revision || status !== 'generating') return;
          const ratio = progressRatio(done, total);
          const count = ratio === null ? 0 : Math.floor(ratio * group.pageIndexes.length);
          updateProgress('Creando el documento', `${count} de ${group.pageIndexes.length} páginas preparadas.`, ratio === null ? null : ratio * 100);
        });
        if (runId !== revision) return;
        stage = 'download';
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), group.filename);
        ui.completion.textContent = 'PDF preparado. La descarga se ha iniciado.';
      } else {
        if (!doc.zipCache) {
          await prepareOnce(doc);
          stage = 'pdf';
          const entries = [];
          let completedPages = 0;
          for (let index = 0; index < doc.groups.length; index += 1) {
            const group = doc.groups[index];
            const description = `Documento ${index + 1} de ${doc.groups.length}.`;
            updateProgress('Creando los documentos', description, completedPages / doc.totalPages * 100);
            const bytes = await groupBytes(doc, group, (done, total) => {
              if (runId !== revision || status !== 'generating') return;
              const ratio = progressRatio(done, total);
              const pages = completedPages + (ratio === null ? 0 : ratio * group.pageIndexes.length);
              updateProgress('Creando los documentos', `${description} ${Math.floor(pages)} de ${doc.totalPages} páginas preparadas.`, ratio === null ? null : pages / doc.totalPages * 100);
            });
            if (runId !== revision) return;
            entries.push({ filename: group.filename, bytes });
            completedPages += group.pageIndexes.length;
            updateProgress('Creando los documentos', `${completedPages} de ${doc.totalPages} páginas preparadas.`, completedPages / doc.totalPages * 100);
            await services.yieldToBrowser();
          }
          stage = 'zip';
          updateProgress('Creando el ZIP', 'Agrupando todos los documentos en un único archivo.', 0);
          const zip = await services.createZip(entries, {
            onProgress(percent, currentFile) {
              if (runId !== revision || status !== 'generating') return;
              updateProgress('Creando el ZIP', currentFile ? `Añadiendo ${currentFile}` : 'Agrupando todos los documentos en un único archivo.', percent);
            }
          });
          if (runId !== revision) return;
          if (!(zip instanceof Blob) || zip.size === 0) throw invalidResult();
          doc.zipCache = zip;
        }
        stage = 'download';
        downloadBlob(doc.zipCache, 'documentos_fragmentados.zip');
        ui.completion.textContent = 'ZIP preparado. La descarga se ha iniciado.';
      }
      ui.completion.hidden = false;
      setStatus('completed', ui.completion.textContent);
    } catch (error) {
      if (runId !== revision) return;
      logError(stage, error);
      const safeToRetry = doc.preparation === 'ready' && !doc.requiresReset;
      if (!safeToRetry) doc.requiresReset = true;
      const message = safeToRetry ? 'No hemos podido completar la descarga.' : 'No hemos podido preparar las páginas de forma segura.';
      showError(error instanceof services.AppError ? error.message : message, {
        retry: safeToRetry ? request : null,
        details: safeToRetry ?
          'Los documentos ya preparados se conservan. Pulsa «Volver a intentar» para completar la descarga.' :
          'Pulsa «Procesar otro PDF» y selecciona de nuevo el archivo original.'
      });
    }
  }

  function reset() {
    if (isBusy()) return;
    revision += 1;
    cleanupDownloads();
    if (currentDocument) {
      currentDocument.cache.clear();
      currentDocument.zipCache = null;
      currentDocument.pdfDoc = null;
      currentDocument.groups = null;
    }
    currentDocument = null;
    outputButtons = [];
    ui.companyList.replaceChildren();
    ui.input.value = '';
    ui.sourceFilename.textContent = '';
    ui.sourceDetails.textContent = '';
    ui.resultsSummary.textContent = '';
    ui.unidentifiedDescription.textContent = '';
    ui.unidentifiedPages.textContent = '';
    ui.conflictingDescription.textContent = '';
    ui.unidentified.hidden = true;
    ui.conflicting.hidden = true;
    ui.completion.textContent = '';
    ui.completion.hidden = true;
    dragDepth = 0;
    ui.dropZone.classList.remove('is-dragging');
    clearError();
    updateProgress('Leyendo el PDF', '');
    setStatus('idle', 'Selecciona un PDF para empezar.');
    ui.select.focus({ preventScroll: true });
  }

  function openFilePicker() {
    if (!canSelect()) return;
    ui.input.value = '';
    ui.input.click();
  }

  function isFileDrag(event) {
    return event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
  }

  ui.select.addEventListener('click', (event) => {
    event.stopPropagation();
    openFilePicker();
  });
  ui.input.addEventListener('click', (event) => event.stopPropagation());
  ui.input.addEventListener('change', () => {
    if (ui.input.files && ui.input.files.length) processSelection(ui.input.files);
  });
  ui.dropZone.addEventListener('click', (event) => {
    if (!event.target.closest('button, input')) openFilePicker();
  });
  ui.dropZone.addEventListener('keydown', (event) => {
    if (event.target !== ui.dropZone) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!event.repeat) openFilePicker();
    }
  });
  ui.dropZone.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (!canSelect()) return;
    dragDepth += 1;
    ui.dropZone.classList.add('is-dragging');
  });
  ui.dropZone.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropZone.classList.remove('is-dragging');
  });
  // Prevent dropping a file elsewhere from navigating away from the app.
  document.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const inside = ui.dropZone.contains(event.target);
    event.dataTransfer.dropEffect = canSelect() && inside ? 'copy' : 'none';
  });
  document.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    ui.dropZone.classList.remove('is-dragging');
    if (canSelect() && ui.dropZone.contains(event.target)) processSelection(event.dataTransfer.files);
  });
  ui.continueUnidentified.addEventListener('click', () => {
    if (isBusy() || !currentDocument || !currentDocument.groups || currentDocument.requiresReset) return;
    currentDocument.confirmed = true;
    refreshControls();
    announce('Confirmado. Ya puedes descargar todos los documentos, incluidas las páginas sin razón social.');
    ui.zip.focus({ preventScroll: true });
  });
  ui.zip.addEventListener('click', () => runDownload({ type: 'zip' }));
  ui.reset.addEventListener('click', reset);
  ui.retry.addEventListener('click', () => {
    if (isBusy() || !errorState || !errorState.retry) return;
    const request = errorState.retry;
    if (request.type === 'dependencies') {
      if (checkDependencies()) ui.select.focus({ preventScroll: true });
    } else {
      runDownload(request);
    }
  });
  globalThis.addEventListener('pagehide', cleanupDownloads);
  checkDependencies();

  // file:// remains usable; a service worker needs an HTTP(S) origin.
  if (location.protocol !== 'file:' && globalThis.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      console.warn('[PDFSplitter]', { stage: 'offline', code: 'SERVICE_WORKER_UNAVAILABLE' });
    });
  }
}());
