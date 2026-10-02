(function (root) {
  'use strict';

  const api = root.PDFSplitter = root.PDFSplitter || {};

  class AppError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'AppError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function validateFileSelection(files) {
    const count = files && files.length;
    if (!count) {
      throw new AppError('NO_FILE', 'Selecciona un archivo PDF para continuar.');
    }
    if (count !== 1) {
      throw new AppError('MULTIPLE_FILES', 'Selecciona un solo archivo PDF cada vez.');
    }

    const file = files[0] || (typeof files.item === 'function' && files.item(0));
    if (!file || typeof file.name !== 'string' || !/\.pdf$/i.test(file.name)) {
      throw new AppError('INVALID_FILE_TYPE', 'El archivo seleccionado debe tener extensión .pdf.');
    }
    if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0) {
      throw new AppError('EMPTY_FILE', 'El archivo PDF está vacío o no se puede leer.');
    }

    // File.type is optional and is not reliable for files selected locally.
    // readPdf checks the actual bytes before handing them to the PDF parser.
    return file;
  }

  async function yieldToBrowser() {
    await new Promise(function (resolve) { root.setTimeout(resolve, 0); });
  }

  Object.assign(api, { AppError, validateFileSelection, yieldToBrowser });
})(globalThis);
