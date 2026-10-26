# Verifying the desktop app (Phase 1A)

## Protected baseline

The last desktop-only commit is **`efbd65a`**, protected by the annotated tag
**`desktop-baseline-efbd65a`**. Phase 1 work happens on branches (`phase-1a/...`);
the tag must never be moved. To compare any later state with the baseline:

```
git diff --stat desktop-baseline-efbd65a -- src resources electron.vite.config.js electron-builder.yml
```

An empty result means the desktop application's code, assets and build config are unchanged.

## One command

```
npm ci
npm run verify
```

`verify` = `verify:env` (Node version vs `engines`, better-sqlite3 native binding loads) →
`npm test` (vitest, all desktop tests) → `npm run build` (electron-vite production build).
It stops at the first failing step and exits non-zero. It never opens or modifies any real
database (tests create temporary files; the env check uses an in-memory database) and never builds an installer.

- Node: `>=22.13.0` (the highest floor among the locked dependencies; `.nvmrc` says `22`).
  The suite gives identical results on Node 22.22.2 and 24.22.1.
- Install with scripts enabled (plain `npm ci`) on Windows so the native binding is set up;
  if `verify:env` reports that better-sqlite3 failed to load, re-run `npm ci`.

`npm run verify:audit` (`npm audit --omit=dev`) is **not** part of `verify`: it needs the
network and currently reports known findings (e.g. `xlsx@0.18.5`, no fixed version on npm).
It becomes a gate once decision D-15 (xlsx handling) is made.

## Server skeleton

`server/` is a separate, empty package (see `server/README.md`). Its checks are
`cd server && npm ci && npm run verify` (Node 24) and are not part of the root `verify`.

## Test dispositions

See [`docs/testing/phase-1a-test-dispositions.md`](../testing/phase-1a-test-dispositions.md)
for what happened to the 23 baseline failures and which decisions are still open.
