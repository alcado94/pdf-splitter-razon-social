(function (root) {
  'use strict';

  const api = root.PDFSplitter = root.PDFSplitter || {};

  async function createZip(entries, { onProgress } = {}) {
    if (typeof root.JSZip !== 'function') {
      throw new api.AppError('ZIP_LIBRARY_MISSING', 'No se ha cargado la biblioteca ZIP local.');
    }
    if (!Array.isArray(entries)) {
      throw new api.AppError('INVALID_ZIP_ENTRIES', 'No se han recibido los documentos para crear el ZIP.');
    }

    const zip = new root.JSZip();
    const usedNames = new Set();
    try {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry || typeof entry.filename !== 'string' || !entry.filename.trim() ||
            /[\/\\\u0000-\u001f\u007f]/.test(entry.filename) ||
            entry.filename === '.' || entry.filename === '..' || !(entry.bytes instanceof Uint8Array)) {
          throw new api.AppError('INVALID_ZIP_ENTRY', 'Uno de los documentos no tiene un nombre o unos datos válidos.', { entryIndex: index });
        }
        const key = entry.filename.normalize('NFC').toLowerCase();
        if (usedNames.has(key)) {
          throw new api.AppError('DUPLICATE_ZIP_FILENAME', 'Hay documentos con el mismo nombre. Genera nombres únicos antes de crear el ZIP.', { entryIndex: index });
        }
        usedNames.add(key);
        zip.file(entry.filename, entry.bytes, { binary: true, compression: 'STORE', createFolders: false });
        if ((index + 1) % 25 === 0) await api.yieldToBrowser();
      }
      await api.yieldToBrowser();
      return await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/zip',
        compression: 'STORE',
        streamFiles: true,
      }, function (metadata) {
        if (typeof onProgress === 'function') onProgress(metadata.percent, metadata.currentFile);
      });
    } catch (error) {
      if (error instanceof api.AppError) throw error;
      throw new api.AppError('ZIP_GENERATION_FAILED', 'No se ha podido crear el archivo ZIP. Inténtalo de nuevo con menos documentos.');
    }
  }

  api.createZip = createZip;
})(globalThis);
