# Dependency verification procedure (Phase 1A closure)

Purpose: give the owner (or any reviewer) a reproducible way to check that the packages installed from
`package-lock.json` and `server/package-lock.json` are the ones the npm registry published, and to see what is
*not* covered. This is evidence about **integrity**, not a statement that the code is safe.

## What each check proves

| Check | Proves | Does NOT prove |
|---|---|---|
| Lockfile discipline (`npm ci`, never `npm install`) | Installed versions and tarball hashes are exactly those committed | That the committed hashes are the registry's |
| `verify-registry-signatures.mjs` | Each locked tarball hash equals the integrity the registry published for that version, and the registry's ECDSA signature over `name@version:integrity` verifies with a key the registry itself publishes | Who the publisher is; that the code is benign; that a compromised publisher account did not publish a bad version; key validity *at publish time* (expired keys are counted, not rejected) |
| `npm audit` | No *known, reported* advisory affects the locked version | Absence of unknown problems; advisory text was not readable from the sandbox (see limitations) |
| `npm audit signatures` (where the network allows) | Same as the script, plus verification of **provenance attestations** via Sigstore | That the build pipeline was itself trustworthy |
| Install-script review | Which packages run code at install time | What that code does (needs reading) |
| Release-age check | A version has had time for the community to notice a malicious release | Safety of an old release |

## Procedure (run from the repository root, any OS with Node ≥ 22.13)

```
# 1. Install exactly what is locked, running no install scripts
npm ci --ignore-scripts
(cd server && npm ci --ignore-scripts)

# 2. Confirm the install did not rewrite either lockfile (expect no output and exit 0)
git diff --exit-code -- package-lock.json server/package-lock.json

# 3. Registry-signature check of every locked package (needs https://registry.npmjs.org)
node scripts/verify-registry-signatures.mjs package-lock.json server/package-lock.json   # same as: npm run verify:deps

# 4. Known-advisory check
npm audit --omit=dev
(cd server && npm audit)

# 5. Provenance + signatures through npm itself (needs Sigstore access; may be blocked on restricted networks)
npm audit signatures
(cd server && npm audit signatures)
```

`scripts/verify-registry-signatures.mjs` exit codes: `0` all verified, `1` at least one package failed or could
not be verified (the output lists up to 40), `2` usage or network error. It writes nothing and installs nothing.

### Before adopting or bumping any dependency

1. `npm view <name> time --json` — note the **publish date** of the candidate version and wait at least 7 days after
   publication for routine updates (a *proposal*, see sheet item T-7; not enforced anywhere). npm 11.21.1 can enforce
   this when adding or updating a package: `npm install --save-exact <name>@<version> --min-release-age=7`
   (verified to exist in npm 11.21.1's own config definitions; npm 10.9.9 has no such option, only `--before=<date>`).
   It affects resolution, not `npm ci` from an existing lockfile.
2. Pin **exact** versions (no `^`/`~`) in `server/package.json`; the lockfile is then the single source of truth.
3. Read `scripts` of the new version (`preinstall`/`install`/`postinstall`); a new install script requires an
   explicit note in the pull request.
4. Re-run steps 1–5 above and record the output in the delivery report.

## Results recorded on 2026-10-26 (Linux sandbox, Node 22.23.4 / npm 10.9.9)

| Step | Result |
|---|---|
| Signature script, both lockfiles | **706** unique `name@version` entries checked; **706** verified, 0 integrity mismatches, 0 missing signatures, 0 bad signatures, 0 non-registry entries; exit 0 |
| Provenance attestations (informational) | 207 of 706 versions publish one (**not** verified by the script; only listed) |
| Signing keys used | 2 registry keys: 378 entries under `SHA256:DhQ8wR5A…`, 328 under `SHA256:jl3bwswu…`. The second key has since expired; 328 entries were signed with it, which is normal for versions published before the registry rotated keys, but the script reports rather than rejects it |
| Tamper test | Changing one integrity character in a copy of the lockfile made the script report a mismatch and exit 1 |
| `npm audit --omit=dev`, root | 4 findings: `xlsx` (high, **no fix on npm**), `brace-expansion` (high, transitive, fix available), `exceljs` and `uuid` (moderate; npm's suggested fix is `exceljs@3.4.0`, a semver-major *downgrade*, so there is no clean fix) |
| `npm audit` (all), root | 15 findings (4 moderate, 11 high), includes `electron`, `vite`, `xlsx` — **not changed** (outside Phase 1A scope; sheet item T-6) |
| `npm audit`, `server/` | **0** vulnerabilities after bumping `vitest` 4.1.10 → 4.1.12 |
| Packages with install scripts | root: `better-sqlite3@13.0.2`, `electron-winstaller@5.4.0`, `esbuild@0.25.12`, `esbuild@0.28.1`, `fsevents@2.3.3`; server: `fsevents@2.3.3` |

## Limitations that remain (stated plainly)

1. **`npm audit signatures` could not run here.** It failed downloading Sigstore's TUF metadata (the sandbox proxy
   returned 403 for that host). I did not retry through another route. The substitute script covers the registry
   signature, **not** the Sigstore-verified provenance attestation. Please run step 5 on your own machine/network.
2. **Advisory details were not readable.** GitHub advisory pages were blocked from the sandbox, so for the 15 root
   findings I can state package, severity and fix availability from `npm audit`, but not exploit conditions or whether
   the desktop app's use of the package is reachable.
3. **Key expiry is not enforced.** A signature from an expired key is counted as verified. Enforcing it correctly
   needs the publish timestamp, which the script does not compare.
4. **The registry is the root of trust.** If the registry itself (or its signing key) were compromised, this check
   would pass. Mitigation for later phases: vendored/mirrored tarballs with independently recorded hashes (Phase 0
   ADR on vendoring), reviewed at upgrade time.
5. **No install-script content was reviewed.** Only their existence is listed above.
6. **Only the two lockfiles are covered.** Nothing about OS packages (PostgreSQL, nginx), the Node binary itself, or
   the Windows toolchain is verified here. Node release checksums should be verified against
   `https://nodejs.org/dist/vX.Y.Z/SHASUMS256.txt` and its signature when Node is installed by hand.
7. **Windows was not used.** Lockfile hashes are platform-independent, but optional platform packages (e.g. the
   `win32-x64` binaries) are covered only because they appear in the lockfile.
8. Results reflect the registry on the date above; re-run before any release.
