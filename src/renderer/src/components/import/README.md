The Import Wizard (Phase 9). Real four-step flow, wired to src/main/services/importService.js
via the importData IPC namespace — no mock data:

  1. Select File   (ImportPage.jsx)        - native file dialog, Excel sheet selection
  2. Map Columns    (ColumnMappingStep.jsx) - header -> Asset field, pre-filled by
                                              importFieldAliases.js's Persian/English guesses
  3. Preview        (ImportPreviewStep.jsx) - per-row VALID/WARNING/DUPLICATE/ERROR
                                              classification + duplicate-handling choice
  4. Result         (inline in ImportPage.jsx) - commit summary + per-row error details

PDF import (task's Phase 3) is not yet implemented — Excel (.xlsx/.xls) and CSV only so far.
