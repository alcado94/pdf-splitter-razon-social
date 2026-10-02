# Offline browser regression

`browser-smoke.cjs` uses a real Chromium browser to open the absolute `file://`
URL of `index.html`, with an offline context and the application's CSP intact.
Playwright is test tooling only; no npm dependencies are added to the runtime app.

## Temporary tooling and execution

From the repository root, first verify the temporary parent directory:

```sh
ls -ld /tmp/opencode
npm install --prefix /tmp/opencode --cache /tmp/opencode/npm-cache playwright@1.63.0
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/browsers TMPDIR=/tmp/opencode \
  node /tmp/opencode/node_modules/playwright/cli.js install chromium --no-shell
PLAYWRIGHT_MODULE=/tmp/opencode/node_modules/playwright \
  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/browsers TMPDIR=/tmp/opencode \
  node tests/browser-smoke.cjs
```

If Playwright is already available to Node, omit `PLAYWRIGHT_MODULE`; the script
defaults to `require('playwright')`. The script uses full Chromium's new headless
mode (`channel: 'chromium'`), not headless shell. Missing OS libraries are reported
by Playwright at launch; browser installation itself does not install OS packages.

To retain review screenshots, verify an existing directory under `/tmp/opencode`
and set `BROWSER_SCREENSHOT_DIR` to it. For example, append
`BROWSER_SCREENSHOT_DIR=/tmp/opencode` to the execution environment above. The
script rejects screenshot directories outside that temporary tree, including
symlinks that resolve outside it. Download files are read from Playwright's
temporary download paths and removed when their browser contexts close.

## Coverage and reporting

- Desktop 1365×900, mobile/touch 390×844 and narrow 320px results: horizontal
  document/control/table-cell overflow, including a long source filename.
- Nine-page synthetic fixture: uppercase company groups, counts, unknown pages
  4–5 and 7, conflict on page 5, disabled ZIP and individual outputs until explicit
  consent. Actual individual downloads and ZIP downloads are reopened with the
  vendored PDFLib/JSZip; exact filenames, original page order, flattened fields,
  drawn appearances, CRCs and complete, nonduplicated page coverage are checked.
- Reset and reselect the identical PDF; native `DataTransfer`/`File` drag/drop;
  keyboard Enter/Space filechooser events, cancellation and stable focus.
- Invalid PDF, multiple-file drop and the precise XFA rejection message, each
  followed by reset/reselection. A genuine no-AcroForm PDF is accepted as all
  unknown and downloaded after consent.
- Two 300-page fixtures: 300 hierarchical fields with three interleaved companies,
  and one shared field with 300 widgets (some without `/P`). Downloaded outputs
  are reopened and checked for all pages and flattened, drawn appearances.
  Unmodified DOM progress is sampled during real animation frames, alongside an
  event-loop heartbeat; analysis and generation must render advancing progress.
- Local resource requests, uncaught exceptions, console errors, CSP violation
  events and HTTP(S)/WS(S) attempts are collected. Network attempts are also
  rejected. Expected warning stage/code objects are verified for invalid input;
  unexpected warnings fail their scenario.

Each scenario runs in a fresh offline context, so independent checks continue
after a failure. Keyboard activation and cancellation use independent contexts
to avoid Chromium's suppression of rapidly repeated/cancelled native pickers;
focus is checked across two animation frames with a bounded wait.
The script prints browser/Playwright/Node versions, scenario
timings and a JSON summary. A failure exits with status 1. Timings and maximum
observed frame gaps are diagnostic observations, not benchmark thresholds; the
120-second operation timeout only detects a stalled check. No binary fixtures
are stored and application services are never substituted in the browser.
