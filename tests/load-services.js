'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const contracts = [
  'AppError',
  'validateFileSelection',
  'sanitizeFilename',
  'uniqueFilename',
  'readPdf',
  'normalizeCompanyName',
  'extractCompanies',
  'prepareForSplitting',
  'generatePdf',
  'createZip',
];

function loadVendor(filename, globalName) {
  const absolute = path.join(root, 'lib', filename);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Test prerequisite missing: lib/${filename}. Vendor the UMD library before running npm test.`);
  }
  globalThis[globalName] = require(absolute);
}

function loadServices() {
  loadVendor('pdf-lib.min.js', 'PDFLib');
  loadVendor('jszip.min.js', 'JSZip');
  // Match the classic-script service loading order in index.html.
  const serviceFiles = [
    'utils/validation.js',
    'utils/filename.js',
    'services/pdf-reader.js',
    'services/field-extractor.js',
    'services/pdf-splitter.js',
    'services/zip-generator.js',
  ];
  for (const filename of serviceFiles) {
    const absolute = path.join(root, filename);
    if (!fs.existsSync(absolute)) throw new Error(`Test prerequisite missing: ${filename}`);
    require(absolute);
  }

  const services = globalThis.PDFSplitter;
  const missing = contracts.filter((name) => typeof services?.[name] !== 'function');
  if (missing.length) {
    throw new Error(`Service contracts unavailable on globalThis.PDFSplitter: ${missing.join(', ')}`);
  }
  return { ...services, PDFLib: globalThis.PDFLib, JSZip: globalThis.JSZip };
}

module.exports = loadServices();
