# Service regression tests

Run `npm test` with Node 22 or newer. The suite uses `node:test` and
`node:assert/strict`; it needs no installed dependencies or browser.

The application services and the vendored `lib/pdf-lib.min.js` and
`lib/jszip.min.js` must be present. The test harness assigns the libraries'
CommonJS UMD exports to `globalThis.PDFLib` and `globalThis.JSZip`, then loads
the application's classic IIFE service modules into `globalThis.PDFSplitter`.

`fixtures.js` generates small PDFs entirely in memory, including hierarchical
fields, shared multi-page widgets, widgets without `/P`, merged field/widget
dictionaries, missing appearances, Unicode `/V` values, and raw XFA. Each page
has distinct MediaBox dimensions and a visible page marker. The helper exports
`createFixture`, `createGroupingFixture`, and `pageSize`; it also exposes
`globalThis.PDFSplitterTestFixtures` when loaded in a browser after PDFLib.

For example, a later browser check can obtain its upload bytes with:

```js
const { createGroupingFixture } = require('./tests/fixtures');
const { bytes, expectedCompanies, unidentifiedPages, conflictingPages } =
  await createGroupingFixture();
```

`createFixture({ pageCount, fields, xfa })` accepts fields with `name`, `value`,
and zero-based `pages`. Optional flags are `omitPageReference`, `merged`,
`missingAppearance`, and `missingAppearancePages`. Use `appearanceText` with
`rawValue` to build a standard-font appearance before writing a Unicode `/V`.
Both fixture builders return `{ bytes, pageSizes }`; the grouping builder also
returns the expected grouping and unidentified/conflicting page indexes.

The regression suite checks observable service contracts rather than private
helpers or error-code spelling. Page indexes are zero-based; conflicting pages
are included in `unidentifiedPages` and must not be silently assigned to either
company. ZIP entries use `{ filename, bytes }`. Company normalization is
expected to collapse whitespace and canonical Unicode equivalents and uppercase
company values without removing meaningful accents or rewriting field values
and existing appearances. Filename assertions allow any safe suffix scheme
while requiring case-insensitive collision avoidance.

Encrypted PDFs are not synthesized: PDFLib cannot produce them, and this suite
does not bring in another library or commit a binary fixture. XFA and corrupt
input rejection are tested independently.
