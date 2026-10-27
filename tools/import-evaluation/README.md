# Spreadsheet import evaluation (decisions D-15, O-13, E-18)

**Evaluation only.** This folder tests how `.xlsx` and CSV files can be parsed safely on the web server, on
synthetic files, before any parser is added to `server/`. It is not part of the web server or the desktop app;
their builds never install it. Results and the recommendation: [`docs/security/import-evaluation.md`](../../docs/security/import-evaluation.md).

## What it contains

| File | Role |
|---|---|
| `package.json`, `package-lock.json` | Exact pins: `exceljs@4.4.0`, `csv-parse@7.0.3`; overrides inside ExcelJS: `unzipper@0.12.5` (O-13), `uuid@11.1.1` (GHSA-w5hq-g745-h8pq) |
| `lib/limits.mjs` | The owner's E-18 ceilings, plus derived controls that follow from how ExcelJS works |
| `lib/zip-inspect.mjs` | Pre-check of an `.xlsx` before ExcelJS sees it: archive structure, inflating with a hard cap and CRC check, no DTDs, worksheet extent and range-expansion budget |
| `lib/parse-child.mjs` | The confined parser process: pre-check, JSZip cross-check, ExcelJS `load()`, typed row output, authoritative recount; strict CSV |
| `lib/isolate.mjs` | The supervisor: starts the parser under kernel limits and Node's permission model, without network, with a resident-memory watchdog, a wall-clock kill and an output cap |
| `lib/hog-child.mjs` | A deliberately misbehaving child, to prove each confinement layer works on its own |
| `lib/corpus.mjs`, `lib/xlsx-build.mjs`, `lib/zip-write.mjs` | The synthetic corpus and the writers that build it byte by byte |
| `producers/make_reference.py` | Writes the reference table with openpyxl and XlsxWriter (independent producers) |
| `run-evaluation.mjs` | Runs everything and writes `out/evaluation-results.json` and `out/evaluation-summary.md` |

## Running it (Linux; Node 24)

Needs `prlimit` and `unshare` (util-linux), and for the producer files Python 3 with `openpyxl` and `xlsxwriter`, and
LibreOffice. Nothing here downloads or installs anything at run time.

```
cd tools/import-evaluation
npm ci --ignore-scripts
mkdir -p out/producers
python3 -I producers/make_reference.py out/producers
cp out/producers/reference-openpyxl.xlsx /tmp/reference-libreoffice.xlsx
soffice --headless --convert-to xlsx:"Calc MS Excel 2007 XML" --outdir out/producers /tmp/reference-libreoffice.xlsx
node run-evaluation.mjs            # about 10 minutes on 4 cores: measure, derive the memory limits, verify, load test
node run-evaluation.mjs --quick    # skip the measurement; verify with the recorded limits
```

Exit code 0 means every case met its expectation, the isolation layers each acted, and the load test passed. The
run uses about 5 GiB of memory at its peak (four parses at once) and must not share the machine with anything
whose timing matters.

## How to read the corpus

Each case states the outcomes it accepts: `ok` (parsed, values checked where stated), `refused` (stopped by the
pre-check or a ceiling — the message names the ceiling), `rejected` (ExcelJS itself refused the file), `contained`
(anything except a successful parse of unchecked data; the supervisor must survive). Cases ending in `u` run
ExcelJS **without** the pre-check to show what the isolation limits alone would have to absorb; they are evidence,
never a design option.
