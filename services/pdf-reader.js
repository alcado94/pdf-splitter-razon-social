(function (root) {
  'use strict';

  const api = root.PDFSplitter = root.PDFSplitter || {};

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new api.AppError('INVALID_PDF_BYTES', 'No se han podido leer los datos del archivo PDF.');
  }

  function hasPdfHeader(bytes) {
    // Some producers put a BOM or a short preamble before the PDF header.
    const end = Math.min(bytes.length - 8, 1023);
    for (let offset = 0; offset <= end; offset++) {
      if (bytes[offset] === 37 && bytes[offset + 1] === 80 && bytes[offset + 2] === 68 &&
          bytes[offset + 3] === 70 && bytes[offset + 4] === 45 &&
          bytes[offset + 5] >= 48 && bytes[offset + 5] <= 57 && bytes[offset + 6] === 46 &&
          bytes[offset + 7] >= 48 && bytes[offset + 7] <= 57) return true;
    }
    return false;
  }

  async function readPdf(input, { debug = false } = {}) {
    const lib = root.PDFLib;
    if (!lib || !lib.PDFDocument) {
      throw new api.AppError('PDF_LIBRARY_MISSING', 'No se ha cargado la biblioteca PDF local.');
    }
    const bytes = asBytes(input);
    if (!bytes.byteLength) {
      throw new api.AppError('EMPTY_FILE', 'El archivo PDF está vacío.');
    }
    if (!hasPdfHeader(bytes)) {
      throw new api.AppError('INVALID_PDF', 'El archivo no contiene un PDF válido, aunque tenga extensión .pdf.');
    }

    try {
      await api.yieldToBrowser();
      const pdfDoc = await lib.PDFDocument.load(bytes, {
        parseSpeed: lib.ParseSpeeds.Slow,
        ignoreEncryption: false,
        throwOnInvalidObject: true,
        updateMetadata: false,
      });
      if (pdfDoc.isEncrypted) {
        throw new api.AppError('ENCRYPTED_PDF', 'El PDF está cifrado o protegido con contraseña. Guarda una copia sin protección e inténtalo de nuevo.');
      }

      // getForm() deletes XFA, so this check must use the raw catalog first.
      const acroForm = pdfDoc.catalog.getAcroForm();
      if (acroForm && acroForm.dict.has(lib.PDFName.of('XFA'))) {
        throw new api.AppError('XFA_UNSUPPORTED', 'Este PDF utiliza un formulario XFA, que no se puede procesar. Guarda una copia con un formulario AcroForm estándar.');
      }
      const totalPages = pdfDoc.getPageCount();
      if (totalPages < 1) {
        throw new api.AppError('EMPTY_PDF', 'El PDF no contiene ninguna página.');
      }
      // Avoid creating an AcroForm (or its Fields array) while reading.
      const fields = acroForm && acroForm.Fields() ? pdfDoc.getForm().getFields() : [];
      await api.yieldToBrowser();
      if (debug && root.console && typeof root.console.debug === 'function') {
        root.console.debug('[PDFSplitter] PDF leído', { totalPages, fieldCount: fields.length });
      }
      return { pdfDoc, totalPages, fields };
    } catch (error) {
      if (error instanceof api.AppError) throw error;
      if (error && (error.name === 'EncryptedPDFError' || /encrypted/i.test(error.message || ''))) {
        throw new api.AppError('ENCRYPTED_PDF', 'El PDF está cifrado o protegido con contraseña. Guarda una copia sin protección e inténtalo de nuevo.');
      }
      if (debug && root.console && typeof root.console.debug === 'function') {
        root.console.debug('[PDFSplitter] Fallo de lectura', { errorType: error && error.name });
      }
      throw new api.AppError('CORRUPT_PDF', 'No se ha podido abrir el PDF. Puede estar dañado o incompleto; vuelve a guardarlo e inténtalo de nuevo.');
    }
  }

  api.readPdf = readPdf;
})(globalThis);
