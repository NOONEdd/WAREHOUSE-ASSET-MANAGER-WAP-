#!/usr/bin/env node
// Phase 1A — dependency verification helper (read-only, no dependencies).
//
// Usage:  node scripts/verify-registry-signatures.mjs package-lock.json [server/package-lock.json ...]
//
// For every registry-resolved package in the given lockfile(s) this checks, against registry.npmjs.org:
//   1. the lockfile "integrity" equals the integrity the registry published for that exact version, and
//   2. the registry's ECDSA signature over "<name>@<version>:<integrity>" verifies with a public key that
//      the registry itself publishes at /-/npm/v1/keys (the same check `npm audit signatures` performs).
// It also reports which versions carry a provenance attestation (informational) and which lock entries are
// NOT registry-resolved (git/tarball/file URLs), which this script cannot verify.
//
// What this proves: the tarball hash recorded in the lockfile is the hash the npm registry signed.
// What it does NOT prove: that the publisher is who you think (no publisher identity), that the code is
// benign, or that the key was still valid at publish time (key expiry is reported, not enforced).
// `npm audit signatures` additionally verifies provenance attestations through Sigstore; it needs
// network access to Sigstore's TUF repository, which some restricted networks block.
//
// Exit codes: 0 = every registry entry verified; 1 = at least one failure/unverifiable entry; 2 = usage/network error.
import { readFileSync } from 'node:fs'
import { createPublicKey, createVerify } from 'node:crypto'

const REGISTRY = 'https://registry.npmjs.org'
const lockPaths = process.argv.slice(2)
if (lockPaths.length === 0) {
  console.error('usage: node scripts/verify-registry-signatures.mjs <package-lock.json> [more lockfiles...]')
  process.exit(2)
}

async function getJson(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (attempt < 3) return getJson(url, attempt + 1)
    throw new Error(`${url}: ${err.message}`)
  }
}

let keyById
try {
  const { keys } = await getJson(`${REGISTRY}/-/npm/v1/keys`)
  keyById = new Map(keys.map((k) => [k.keyid, k]))
} catch (err) {
  console.error(`cannot fetch registry signing keys: ${err.message}`)
  process.exit(2)
}

const wanted = new Map() // "name@version" -> { name, version, integrity, from: Set<lockfile> }
const problems = []
let notRegistry = 0
let skipped = 0

for (const lockPath of lockPaths) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || entry.link) continue
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (!entry.resolved) {
      skipped += 1 // bundled dependency: covered by its parent's integrity
      continue
    }
    if (!entry.resolved.startsWith(`${REGISTRY}/`)) {
      notRegistry += 1
      problems.push(`${lockPath}: ${name}@${entry.version} is not registry-resolved (${entry.resolved}); cannot verify`)
      continue
    }
    const id = `${name}@${entry.version}`
    const rec = wanted.get(id) ?? { name, version: entry.version, integrity: entry.integrity, from: new Set() }
    rec.from.add(lockPath)
    wanted.set(id, rec)
  }
}

const results = { verified: 0, integrityMismatch: 0, noSignature: 0, badSignature: 0, withProvenance: 0, expiredKey: 0 }
const keyUse = new Map()
const queue = [...wanted.values()]

async function worker() {
  for (let rec = queue.pop(); rec; rec = queue.pop()) {
    const id = `${rec.name}@${rec.version}`
    let doc
    try {
      doc = await getJson(`${REGISTRY}/${rec.name.replace('/', '%2f')}/${rec.version}`)
    } catch (err) {
      results.noSignature += 1
      problems.push(`${id}: cannot fetch registry metadata (${err.message})`)
      continue
    }
    const dist = doc.dist ?? {}
    if (dist.attestations?.url) results.withProvenance += 1
    if (!rec.integrity || rec.integrity !== dist.integrity) {
      results.integrityMismatch += 1
      problems.push(`${id}: lockfile integrity ${rec.integrity ?? '(missing)'} != registry integrity ${dist.integrity ?? '(missing)'}`)
      continue
    }
    const sigs = Array.isArray(dist.signatures) ? dist.signatures : []
    if (sigs.length === 0) {
      results.noSignature += 1
      problems.push(`${id}: registry published no signature`)
      continue
    }
    const message = `${rec.name}@${rec.version}:${dist.integrity}`
    let ok = false
    for (const { keyid, sig } of sigs) {
      const key = keyById.get(keyid)
      if (!key) continue
      const verifier = createVerify('SHA256')
      verifier.update(message)
      verifier.end()
      const publicKey = createPublicKey({ key: Buffer.from(key.key, 'base64'), format: 'der', type: 'spki' })
      if (verifier.verify(publicKey, sig, 'base64')) {
        ok = true
        keyUse.set(keyid, (keyUse.get(keyid) ?? 0) + 1)
        if (key.expires && Date.parse(key.expires) < Date.now()) results.expiredKey += 1
        break
      }
    }
    if (ok) results.verified += 1
    else {
      results.badSignature += 1
      problems.push(`${id}: no signature verified against the registry's published keys`)
    }
  }
}

await Promise.all(Array.from({ length: 12 }, worker))

console.log(`lockfiles: ${lockPaths.join(', ')}`)
console.log(`unique registry packages checked: ${wanted.size}`)
console.log(`  signature verified + lockfile integrity matches registry: ${results.verified}`)
console.log(`  integrity mismatch: ${results.integrityMismatch} | no signature/metadata: ${results.noSignature} | bad signature: ${results.badSignature}`)
console.log(`  not registry-resolved (unverifiable here): ${notRegistry} | bundled (no resolved URL): ${skipped}`)
console.log(`  informational: with provenance attestation: ${results.withProvenance} | verified with a since-expired key: ${results.expiredKey}`)
for (const [keyid, n] of keyUse) console.log(`  key ${keyid}: ${n}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('OK: every registry-resolved package matched a registry-signed integrity')
