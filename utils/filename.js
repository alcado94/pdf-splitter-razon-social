(function (root) {
  'use strict';

  const api = root.PDFSplitter = root.PDFSplitter || {};
  const MAX_BASE_LENGTH = 120;
  const MAX_BASE_BYTES = 180;
  const RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;

  // Bound both UTF-16 length and UTF-8 bytes, without splitting a surrogate pair.
  function boundedBase(value, suffix) {
    let result = '';
    let bytes = 0;
    const characterLimit = MAX_BASE_LENGTH - suffix.length;
    const byteLimit = MAX_BASE_BYTES - suffix.length;
    for (const character of value) {
      const point = character.codePointAt(0);
      const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (result.length + character.length > characterLimit || bytes + width > byteLimit) break;
      result += character;
      bytes += width;
    }
    return result.replace(/_+$/g, '') || 'sin_nombre';
  }

  function sanitizeFilename(name) {
    let base = name == null ? '' : String(name);
    base = base.normalize('NFC')
      .trim()
      .replace(/\.pdf$/i, '')
      .replace(/\s+/g, '_')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/[<>:"/\\|?*.]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    base = boundedBase(base, '');
    if (RESERVED.test(base)) base = '_' + base;
    return base;
  }

  function uniqueFilename(name, usedNames) {
    if (!(usedNames instanceof Set)) {
      throw new TypeError('uniqueFilename requiere un conjunto Set de nombres utilizados.');
    }
    const occupied = new Set();
    usedNames.forEach(function (used) {
      occupied.add(String(used).normalize('NFC').toLowerCase());
    });

    const base = sanitizeFilename(name);
    let filename = base + '.pdf';
    let number = 2;
    while (occupied.has(filename.toLowerCase())) {
      const suffix = '_' + number++;
      filename = boundedBase(base, suffix) + suffix + '.pdf';
    }
    usedNames.add(filename);
    return filename;
  }

  Object.assign(api, { sanitizeFilename, uniqueFilename });
})(globalThis);
