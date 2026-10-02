'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AppError,
  validateFileSelection,
  sanitizeFilename,
  uniqueFilename,
  normalizeCompanyName,
} = require('./load-services');
const { isAppError } = require('./assertions');

test('AppError retains the error code, message, and optional diagnostic details', () => {
  const details = { page: 4, field: 'solicitud4.razonSocial' };
  const error = new AppError('TEST_ERROR', 'A useful message', details);
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'TEST_ERROR');
  assert.equal(error.message, 'A useful message');
  assert.deepEqual(error.details, details);
  assert.ok(error.stack.includes('A useful message'));
  assert.equal(new AppError('WITHOUT_DETAILS', 'Still useful').message, 'Still useful');
});

test('selection validation returns the original File and supports a FileList-shaped selection', () => {
  const file = new File(['%PDF-1.7\n'], 'solicitudes.PDF', { type: 'application/pdf' });
  assert.equal(validateFileSelection([file]), file);
  assert.equal(validateFileSelection({ 0: file, length: 1, item: () => file }), file);
});

test('selection validation rejects no file, multiple files, and a non-PDF file', () => {
  const file = new File(['%PDF-1.7\n'], 'one.pdf', { type: 'application/pdf' });
  const invalid = new File(['not a PDF'], 'one.txt', { type: 'text/plain' });
  for (const selection of [[], null, undefined, [file, file], [invalid]]) {
    assert.throws(() => validateFileSelection(selection), isAppError);
  }
});

test('selection validation rejects an empty PDF and accepts a PDF with no browser MIME type', () => {
  const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
  assert.throws(() => validateFileSelection([empty]), isAppError);
  const file = new File(['%PDF-1.7\n'], 'local.pdf');
  assert.equal(validateFileSelection([file]), file);
});

test('company normalization uppercases values while preserving accents and folding whitespace and canonical Unicode equivalents', () => {
  for (const value of ['  Árbol\t Norte,\n S.L.  ', 'a\u0301rbol Norte, s.l.', 'árBOL NORTE, S.L.']) {
    assert.equal(normalizeCompanyName(value), 'ÁRBOL NORTE, S.L.');
  }
  assert.equal(normalizeCompanyName('Árbol'), 'ÁRBOL');
  assert.equal(normalizeCompanyName('Arbol'), 'ARBOL');
  for (const empty of ['', ' \t\r\n ', null, undefined]) {
    assert.equal(normalizeCompanyName(empty), '');
  }
});

function assertSafeBase(filename) {
  assert.equal(typeof filename, 'string');
  assert.ok(filename.length > 0, 'Empty names need a usable fallback');
  assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f\u007f]/);
  assert.doesNotMatch(filename, /[.\s]$/);
  assert.ok(filename !== '.' && filename !== '..', 'Dot paths are not filenames');
  assert.doesNotMatch(filename, /\.pdf$/i, 'sanitizeFilename returns a base without the PDF extension');
  assert.doesNotMatch(filename, /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
}

test('sanitization handles unsafe characters, traversal, dot names, and PDF extensions', () => {
  for (const name of [
    '  Árbol Norte, S.L.  ',
    'Company.pdf',
    'COMPANY.PDF',
    '../A<B>:C"D/E\\F|G?H*I\u0000\u001f\u007f...',
    '.',
    '..',
    '   ',
    '',
    'Trailing dots...   ',
  ]) {
    assertSafeBase(sanitizeFilename(name));
  }
  assert.equal(sanitizeFilename('Company.pdf'), sanitizeFilename('Company'));
  assertSafeBase(sanitizeFilename('A.B. Company'));
});

test('Windows device names remain safe even with an extension or mixed case', () => {
  for (const name of ['CON', 'con.txt', 'PrN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'lpt9.PDF']) {
    assertSafeBase(sanitizeFilename(name));
  }
});

test('uniqueFilename reserves safe PDF names across sanitization and case collisions', () => {
  const usedNames = new Set();
  const filenames = ['A/B', 'A\\B', 'A:B', 'A?B', 'a/b', 'A/B.pdf', 'CON', 'con']
    .map((name) => uniqueFilename(name, usedNames));
  for (const filename of filenames) {
    assert.match(filename, /\.pdf$/i);
    assertSafeBase(filename.slice(0, -4));
  }
  assert.equal(new Set(filenames.map((name) => name.toLocaleLowerCase('en-US'))).size, filenames.length);
});

test('uniqueFilename respects externally supplied mixed-case names and existing numbered names', () => {
  const usedNames = new Set(['Existing.PDF']);
  const first = uniqueFilename('existing', usedNames);
  assert.notEqual(first.toLowerCase(), 'existing.pdf');
  // Seed the actual generated suffix, without coupling to a suffix convention.
  const seeded = new Set(['Existing.PDF', first.toUpperCase()]);
  const next = uniqueFilename('EXISTING.pdf', seeded);
  assert.notEqual(next.toLowerCase(), 'existing.pdf');
  assert.notEqual(next.toLowerCase(), first.toLowerCase());
  assert.match(next, /\.pdf$/i);
});

test('filename normalization treats canonically equivalent accents as the same occupied name', () => {
  assert.equal(sanitizeFilename('A\u0301rbol Norte.pdf'), sanitizeFilename('Árbol Norte.pdf'));
  const filename = uniqueFilename('Árbol', new Set(['A\u0301rbol.PDF']));
  assert.notEqual(filename.normalize('NFC').toLowerCase(), 'árbol.pdf');
  assertSafeBase(filename.slice(0, -4));
});
