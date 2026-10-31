import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { sql, type Kysely, type Transaction } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { matchKey } from '../../src/assets/matchKey.js'
import type { Database } from '../../src/db/connection.js'
import { DOWN as DOWN_0005 } from '../../src/db/migrations/0005_asset_catalogue.js'
import { DOWN as DOWN_0006 } from '../../src/db/migrations/0006_assets_and_history.js'
import { DOWN as DOWN_0007 } from '../../src/db/migrations/0007_import_staging.js'
import { createMigrator } from '../../src/db/migrator.js'
import { migrations } from '../../src/db/migrations/index.js'
import { appointAdministrator, createHarness, insertProfile, insertUser, insertWarehouse, type Harness } from '../support/appHarness.js'
import { forAll } from '../support/seededRandom.js'
import { findPostgresBindir } from '../support/ephemeralPostgres.js'
import { connect, createTestDatabase } from '../support/testDatabase.js'

// The asset schema of Phase 1B-3 (decision O-16, approved 2026-10-30), tested on the database as migrations
// 0001–0007 leave it. The approved draft (docs/architecture/asset-schema-draft.sql) is used only to prove
// that the migrations produce exactly its schema, and its combined reverse still applies to it.
// Synthetic data only.

const DRAFT = readFileSync(new URL('../../../docs/architecture/asset-schema-draft.sql', import.meta.url), 'utf8')
const DRAFT_DOWN = readFileSync(new URL('../../../docs/architecture/asset-schema-draft-down.sql', import.meta.url), 'utf8')
const PERMISSION_DENIED = { code: '42501' }
const CHECK_VIOLATION = { code: '23514' }
const UNIQUE_VIOLATION = { code: '23505' }
const FK_VIOLATION = { code: '23503' }
const WRONG_STATE = { code: '55000' }
const LOCK_TIMEOUT = { code: '55P03' }
const ZWNJ = String.fromCodePoint(0x200c)
const DRAFT_FUNCTIONS = [
  'match_key', 'name_key', 'scope_warehouse_ids', 'request_actor', 'running_as_schema_owner', 'reject_change', 'require_active_warehouse', 'protect_system_status',
  'persons_stamp_change', 'assets_stamp_change', 'assets_record_history', 'import_batches_guard', 'import_rows_guard',
  'apply_import_retention', 'assets_apply_import_row', 'import_batches_check_not_committing'
]

let h: Harness
let actor: number
let otherActor: number
let whA: number
let whB: number
let itemType: number
const status: Record<string, number> = {}

interface Context {
  readonly scope?: string
  readonly actor?: number
  readonly reason?: string
  readonly requestId?: string
  readonly importRowId?: number
}

type Db = Kysely<Database> | Transaction<Database>

async function setContext(db: Db, ctx: Context): Promise<void> {
  await sql`SELECT set_config('wam.warehouse_scope', ${ctx.scope ?? ''}, true),
                   set_config('wam.actor_user_id', ${ctx.actor === undefined ? '' : String(ctx.actor)}, true),
                   set_config('wam.change_reason', ${ctx.reason ?? ''}, true),
                   set_config('wam.request_id', ${ctx.requestId ?? ''}, true),
                   set_config('wam.import_row_id', ${ctx.importRowId === undefined ? '' : String(ctx.importRowId)}, true)`.execute(db)
}

function inContext<T>(db: Kysely<Database>, ctx: Context, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setContext(trx, ctx)
    return fn(trx)
  })
}

interface AssetValues {
  readonly warehouse: number
  readonly code: string
  readonly serial?: string | null
  readonly status?: number
  readonly origin?: string
  readonly importRow?: number | null
  readonly receivedByUser?: number | null
  readonly receivedByPerson?: number | null
}

async function insertAsset(db: Db, values: AssetValues): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO wam.assets (warehouse_id, asset_code, name, item_type_id, serial_number, status_id, origin, origin_import_row_id,
                            received_by_user_id, received_by_person_id)
    VALUES (${values.warehouse}, ${values.code}, 'Synthetic asset', ${itemType}, ${values.serial ?? null},
            ${values.status ?? status.in_stock}, ${values.origin ?? 'manual'}, ${values.importRow ?? null},
            ${values.receivedByUser ?? null}, ${values.receivedByPerson ?? null})
    RETURNING id`.execute(db)
  return Number(rows[0]?.id)
}

function newAsset(db: Kysely<Database>, ctx: Context, values: AssetValues): Promise<number> {
  return inContext(db, ctx, (trx) => insertAsset(trx, values))
}

async function count(db: Db, table: string, where = 'true'): Promise<number> {
  const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.raw(table)} WHERE ${sql.raw(where)}`.execute(db)
  return Number(rows[0]?.n)
}

async function client(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  return c
}
const ownerClient = () => client(h.tdb.urls.owner)
const appClient = () => client(h.tdb.urls.app)

async function runScript(url: string, script: string): Promise<void> {
  const c = await client(url)
  try {
    await c.query(script)
  } finally {
    await c.end()
  }
}

async function setClientContext(c: pg.Client, ctx: Context): Promise<void> {
  await c.query(`SELECT set_config('wam.warehouse_scope', $1, true), set_config('wam.actor_user_id', $2, true)`, [
    ctx.scope ?? '',
    ctx.actor === undefined ? '' : String(ctx.actor)
  ])
}

// --- import staging helpers (what the import service will do, reduced to the SQL) ---------------------

async function newBatch(db: Db, warehouse: number, rowCount: number | null = null): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO wam.import_batches (warehouse_id, file_name, file_sha256, file_size_bytes, file_format, row_count)
    VALUES (${warehouse}, 'synthetic.csv', ${randomBytes(32)}, 100, 'csv', ${rowCount}) RETURNING id`.execute(db)
  return Number(rows[0]?.id)
}

interface RowValues {
  readonly rowNumber?: number
  readonly outcome?: string
  readonly matched?: number
  readonly matchedVersion?: number
  readonly cells?: Record<string, string>
  readonly issues?: unknown
}

async function stageRow(db: Db, batch: number, warehouse: number, values: RowValues = {}): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO wam.import_rows (batch_id, warehouse_id, row_number, cells, outcome, issues, matched_asset_id, matched_asset_version)
    VALUES (${batch}, ${warehouse}, ${values.rowNumber ?? 2}, ${JSON.stringify(values.cells ?? { code: 'synthetic' })}::jsonb,
            ${values.outcome ?? 'create'}, ${JSON.stringify(values.issues ?? [])}::jsonb, ${values.matched ?? null},
            ${values.matchedVersion ?? null}) RETURNING id`.execute(db)
  return Number(rows[0]?.id)
}

async function setBatchState(db: Db, batch: number, state: string, failureCode: string | null = null): Promise<void> {
  await sql`UPDATE wam.import_batches SET state = ${state}, failure_code = ${failureCode} WHERE id = ${batch}`.execute(db)
}

async function batchRow(db: Db, batch: number): Promise<Record<string, unknown>> {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT state, file_name, created_by, closed_by, closed_at IS NOT NULL AS closed, content_cleared_at IS NOT NULL AS cleared, version
      FROM wam.import_batches WHERE id = ${batch}`.execute(db)
  return rows[0] ?? {}
}

/** The commit protocol of proposal §6.2 for one 'create' row: stage, preview, then one transaction. */
async function importNewAsset(warehouse: number, code: string): Promise<{ batch: number; row: number; asset: number }> {
  const ctx = { scope: String(warehouse), actor }
  const { batch, row } = await inContext(h.appDb, ctx, async (trx) => {
    const b = await newBatch(trx, warehouse, 1)
    const r = await stageRow(trx, b, warehouse, { cells: { code } })
    await setBatchState(trx, b, 'previewed')
    return { batch: b, row: r }
  })
  const asset = await inContext(h.appDb, { ...ctx, importRowId: row }, async (trx) => {
    await setBatchState(trx, batch, 'committing')
    const id = await insertAsset(trx, { warehouse, code, origin: 'import', importRow: row })
    await setBatchState(trx, batch, 'committed')
    return id
  })
  return { batch, row, asset }
}

/** Test fixture standing in for a Phase 1B-5 transfer: the server's role has no such grant in 1B-3. */
async function transfer(asset: number, to: number): Promise<void> {
  await inContext(h.ownerDb, { actor, reason: 'synthetic transfer' }, (trx) =>
    sql`UPDATE wam.assets SET warehouse_id = ${to} WHERE id = ${asset}`.execute(trx)
  )
}

beforeAll(async () => {
  h = await createHarness()
  actor = await insertUser(h, { username: 'synthetic.actor', password: null })
  otherActor = await insertUser(h, { username: 'synthetic.other', password: null })
  whA = await insertWarehouse(h, 'SYN-A')
  whB = await insertWarehouse(h, 'SYN-B')
  const { rows: statuses } = await sql<{ id: number; code: string }>`SELECT id, code FROM wam.asset_statuses`.execute(h.ownerDb)
  for (const s of statuses) status[s.code] = s.id
  const { rows: types } = await sql<{ id: number }>`INSERT INTO wam.item_types (name) VALUES ('Synthetic type') RETURNING id`.execute(h.ownerDb)
  itemType = types[0]?.id ?? 0
}, 120_000)

afterAll(async () => {
  await h.close()
})

describe('migrations 0005–0007 apply', () => {
  it('creates the functions with the intended volatility, rights and search_path', async () => {
    const { rows } = await sql<{ proname: string; provolatile: string; prosecdef: boolean; lang: string; config: string[] | null }>`
      SELECT p.proname, p.provolatile, p.prosecdef, l.lanname AS lang, p.proconfig AS config
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = 'wam'::regnamespace
          OR (p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = 'normalize')
       ORDER BY p.proname`.execute(h.ownerDb)
    const byName = Object.fromEntries(rows.map((r) => [r.proname, r]))
    expect(byName.normalize?.provolatile).toBe('i')
    expect(byName.match_key?.provolatile).toBe('i')
    expect(byName.scope_warehouse_ids?.provolatile).toBe('s')
    // The four of the approved draft, plus migration 0008's erasure tombstone (review finding S-2).
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual([
      'apply_import_retention', 'assets_apply_import_row', 'assets_record_history', 'import_batches_check_not_committing',
      'persons_tombstone_idempotency'
    ])
    for (const r of rows.filter((x) => x.prosecdef)) expect(r.config).toEqual(['search_path=pg_catalog, pg_temp'])
    // Every PL/pgSQL function of the draft pins its search_path (0004's existing function included).
    for (const r of rows.filter((x) => x.lang === 'plpgsql')) expect(r.config?.[0], r.proname).toMatch(/^search_path=pg_catalog/)
  })

  it('seeds five system statuses, "missing" among them, and no retirement status', async () => {
    const { rows } = await sql<{ code: string; name: string }>`
      SELECT code, name FROM wam.asset_statuses WHERE is_system ORDER BY sort_order`.execute(h.ownerDb)
    expect(rows.map((r) => r.code)).toEqual(['in_stock', 'issued', 'returned', 'damaged', 'missing'])
    expect(rows.find((r) => r.code === 'missing')?.name).toBe('مفقود')
    expect(rows.find((r) => r.code === 'damaged')?.name).toBe(`آسیب${ZWNJ}دیده`)
  })
})

describe('match key: SQL twin equals TypeScript', () => {
  it('on every Unicode scalar value, alone and between letters', async () => {
    const mismatches: string[] = []
    const chunk = 40_000
    for (let start = 1; start <= 0x10ffff; start += chunk) {
      const values: string[] = []
      for (let cp = start; cp < Math.min(start + chunk, 0x110000); cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue
        values.push(String.fromCodePoint(cp), `a${String.fromCodePoint(cp)}b`)
      }
      const { rows } = await sql<{ v: string; k: string }>`
        SELECT v, wam.match_key(v) AS k FROM unnest(${values}::text[]) AS v`.execute(h.ownerDb)
      for (const { v, k } of rows) {
        if (matchKey(v) !== k) mismatches.push(`U+${(v.length <= 2 ? v : v.slice(1, -1)).codePointAt(0)?.toString(16).toUpperCase() ?? '?'}`)
      }
    }
    // The only differences: characters that Unicode gave a compatibility decomposition after
    // the version PostgreSQL 16 implements (Node 24.22.1 ships Unicode 17.0). PostgreSQL leaves
    // them unchanged. Listed exactly, so any further difference fails this test.
    const unique = [...new Set(mismatches)]
    const expected = ['U+A7F1', ...Array.from({ length: 0x1ccf9 - 0x1ccd6 + 1 }, (_, i) => `U+${(0x1ccd6 + i).toString(16).toUpperCase()}`)]
    expect(unique).toEqual(expected)
    const { rows: unchanged } = await sql<{ same: boolean }>`
      SELECT bool_and(normalize(v, NFKC) = v) AS same
        FROM unnest(${expected.map((u) => String.fromCodePoint(parseInt(u.slice(2), 16)))}::text[]) AS v`.execute(h.ownerDb)
    expect(unchanged).toEqual([{ same: true }])
  }, 300_000)

  it('on generated identifiers mixing scripts, combining marks, presentation forms and separators', async () => {
    const pools = [
      [0x30, 0x39], [0x41, 0x5a], [0x61, 0x7a], [0x600, 0x6ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff], [0xff01, 0xff5e],
      [0x300, 0x36f], [0x1100, 0x11ff], [0xac00, 0xac10], [0x2000, 0x206f], [0x20, 0x2f], [0x3000, 0x3003], [0x1d400, 0x1d420]
    ] as const
    const values: string[] = []
    forAll(0x5d1f7, 20_000, (random) => {
      let s = ''
      for (let i = random.int(12); i >= 0; i--) {
        const [lo, hi] = random.pick(pools)
        s += String.fromCodePoint(lo + random.int(hi - lo + 1))
      }
      values.push(s)
    })
    const { rows } = await sql<{ v: string; k: string }>`
      SELECT v, wam.match_key(v) AS k FROM unnest(${values}::text[]) AS v`.execute(h.ownerDb)
    const mismatches = rows.filter(({ v, k }) => matchKey(v) !== k).map(({ v }) => JSON.stringify(v))
    expect(mismatches.slice(0, 20)).toEqual([])
  })
})

describe('exact comparison does not depend on the database collation (finding 1.4)', () => {
  it('declares every identifier and code column, and every name-key index, COLLATE "C"', async () => {
    const { rows: columns } = await sql<{ name: string; collation: string | null }>`
      SELECT table_name || '.' || column_name AS name, collation_name AS collation
        FROM information_schema.columns
       WHERE table_schema = 'wam'
         AND (table_name, column_name) IN (('assets', 'asset_code'), ('assets', 'asset_code_key'), ('assets', 'serial_number'),
              ('assets', 'serial_number_key'), ('asset_statuses', 'code'), ('countries', 'iso_code'),
              ('import_batches', 'state'), ('import_rows', 'outcome'))
       ORDER BY 1`.execute(h.ownerDb)
    expect(columns).toHaveLength(8)
    for (const c of columns) expect(c.collation, c.name).toBe('C')
    const { rows: indexes } = await sql<{ name: string; collation: string }>`
      SELECT r.relname AS name, c.collname AS collation
        FROM pg_index i JOIN pg_class r ON r.oid = i.indexrelid JOIN pg_collation c ON c.oid = i.indcollation[0]
       WHERE r.relnamespace = 'wam'::regnamespace
         AND r.relname IN ('asset_statuses_name_key', 'item_types_name_key', 'workshops_name_key', 'countries_name_key',
                           'assets_asset_code_key')`.execute(h.ownerDb)
    expect(indexes).toHaveLength(5)
    for (const i of indexes) expect(i.collation, i.name).toBe('C')
  })

  it('behaves the same in a database whose default collation is ICU "fa"', async () => {
    const name = `wam_icu_${randomBytes(6).toString('hex')}`
    const at = (url: string) => {
      const u = new URL(url)
      u.pathname = `/${name}`
      return u.toString()
    }
    await sql.raw(`CREATE DATABASE "${name}" OWNER wam_owner ENCODING 'UTF8' TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'fa' LOCALE 'C'`).execute(h.superDb)
    try {
      await sql.raw(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`).execute(h.superDb)
      await sql.raw(`GRANT CONNECT ON DATABASE "${name}" TO wam_app`).execute(h.superDb)
      await runScript(at(h.tdb.urls.superuser), 'REVOKE ALL ON SCHEMA public FROM PUBLIC')
      const owner = connect(at(h.tdb.urls.owner))
      try {
        const { error } = await createMigrator(owner).migrateToLatest()
        expect(error).toBeUndefined()
        // The environment really is not C: the database's default order puts lower case first.
        const { rows: env } = await sql<{ provider: string; lower_first: boolean; c_lower_first: boolean }>`
          SELECT (SELECT datlocprovider FROM pg_database WHERE datname = current_database()) AS provider,
                 'b' < 'B' AS lower_first, 'b' < 'B' COLLATE "C" AS c_lower_first`.execute(owner)
        expect(env).toEqual([{ provider: 'i', lower_first: true, c_lower_first: false }])
        const { rows: u } = await sql<{ id: number }>`INSERT INTO wam.users (username, display_name) VALUES ('icu.actor', 'ICU actor') RETURNING id`.execute(owner)
        const { rows: w } = await sql<{ id: number }>`INSERT INTO wam.warehouses (code, name) VALUES ('SYN-ICU', 'Synthetic ICU') RETURNING id`.execute(owner)
        const { rows: t } = await sql<{ id: number }>`INSERT INTO wam.item_types (name) VALUES ('Synthetic type') RETURNING id`.execute(owner)
        const { rows: s } = await sql<{ id: number }>`SELECT id FROM wam.asset_statuses WHERE code = 'in_stock'`.execute(owner)
        const ctx = { actor: u[0]?.id ?? 0 }
        const insert = (code: string) =>
          inContext(owner, ctx, (trx) =>
            sql`INSERT INTO wam.assets (warehouse_id, asset_code, name, item_type_id, status_id, origin)
                VALUES (${w[0]?.id}, ${code}, 'x', ${t[0]?.id}, ${s[0]?.id}, 'manual')`.execute(trx)
          )
        const nfc = String.fromCodePoint(0xe9)
        const nfd = `e${String.fromCodePoint(0x301)}`
        for (const code of ['abc', 'ABC', '007', '7', nfc, nfd]) await insert(code)
        await expect(insert('ABC')).rejects.toMatchObject(UNIQUE_VIOLATION)
        const { rows: ordered } = await sql<{ asset_code: string }>`SELECT asset_code FROM wam.assets ORDER BY asset_code`.execute(owner)
        // Byte order: digits, upper case, lower case, then the two-byte and combining forms.
        expect(ordered.map((r) => r.asset_code)).toEqual(['007', '7', 'ABC', 'abc', nfd, nfc])
        // Stored exactly as written; the match key reports the NFC/NFD pair as one identifier.
        const { rows: keys } = await sql<{ n: string }>`SELECT count(DISTINCT asset_code_key) AS n FROM wam.assets WHERE asset_code IN (${nfc}, ${nfd})`.execute(owner)
        expect(keys).toEqual([{ n: '1' }])
      } finally {
        await owner.destroy()
      }
    } finally {
      await sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).execute(h.superDb)
    }
  }, 120_000)
})

describe('row-level security fails closed', () => {
  it('shows nothing and accepts nothing without a scope', async () => {
    await newAsset(h.ownerDb, { actor }, { warehouse: whA, code: 'RLS-0001' })
    expect(await count(h.ownerDb, 'wam.assets')).toBeGreaterThan(0)
    expect(await count(h.appDb, 'wam.assets')).toBe(0)
    expect(await inContext(h.appDb, { actor }, (trx) => count(trx, 'wam.assets'))).toBe(0)
    await expect(newAsset(h.appDb, { actor }, { warehouse: whA, code: 'RLS-0002' })).rejects.toMatchObject(PERMISSION_DENIED)
  })

  it('refuses a malformed scope instead of guessing', async () => {
    await expect(inContext(h.appDb, { scope: `${String(whA)},x` }, (trx) => count(trx, 'wam.assets'))).rejects.toMatchObject({ code: '22P02' })
  })

  it('confines reads and writes to the scope', async () => {
    const inB = await newAsset(h.ownerDb, { actor }, { warehouse: whB, code: 'RLS-B-0001' })
    const scopeA = { scope: String(whA), actor }
    expect(await inContext(h.appDb, scopeA, (trx) => count(trx, 'wam.assets', `warehouse_id = ${String(whB)}`))).toBe(0)
    expect(await inContext(h.appDb, scopeA, (trx) => count(trx, 'wam.assets', `warehouse_id = ${String(whA)}`))).toBeGreaterThan(0)
    const updated = await inContext(h.appDb, scopeA, (trx) => sql`UPDATE wam.assets SET notes = 'x' WHERE id = ${inB}`.execute(trx))
    expect(updated.numAffectedRows).toBe(0n)
    await expect(newAsset(h.appDb, scopeA, { warehouse: whB, code: 'RLS-B-0002' })).rejects.toMatchObject(PERMISSION_DENIED)
    expect(await inContext(h.appDb, scopeA, (trx) => count(trx, 'wam.asset_status_history', `asset_id = ${String(inB)}`))).toBe(0)
    expect(await inContext(h.appDb, { scope: String(whB) }, (trx) => count(trx, 'wam.asset_status_history', `asset_id = ${String(inB)}`))).toBe(1)
  })

  it('is trusted context, not a boundary: SQL running as the server role can widen its own scope (documented limit)', async () => {
    // Proposal §5.1: whoever can run arbitrary SQL as wam_app can also set wam.warehouse_scope. Row-level
    // security guards against mistakes in the server's queries, not against a compromised server role.
    expect(await inContext(h.appDb, { scope: `${String(whA)},${String(whB)}` }, (trx) => count(trx, 'wam.assets', `warehouse_id = ${String(whB)}`))).toBeGreaterThan(0)
  })

  it('does not leak a scope to the next transaction on the same pooled connection', async () => {
    const c = await appClient()
    try {
      const n = async () => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM wam.assets')).rows[0]?.n)
      await c.query('BEGIN')
      await c.query(`SELECT set_config('wam.warehouse_scope', $1, true)`, [String(whA)])
      expect(await n()).toBeGreaterThan(0)
      await c.query('COMMIT')
      expect(await n()).toBe(0)
      await c.query('BEGIN')
      await c.query(`SELECT set_config('wam.warehouse_scope', $1, true)`, [String(whA)])
      await c.query('ROLLBACK')
      expect(await n()).toBe(0)
      await c.query('BEGIN')
      await c.query(`SELECT set_config('wam.warehouse_scope', $1, true)`, [String(whA)])
      await expect(c.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' })
      await c.query('ROLLBACK')
      expect(await n()).toBe(0)
    } finally {
      await c.end()
    }
  })

  it('does not leak through the server pool under interleaved requests', async () => {
    await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        if (i % 2 === 0) {
          expect(await inContext(h.appDb, { scope: String(whA) }, (trx) => count(trx, 'wam.assets', `warehouse_id = ${String(whA)}`))).toBeGreaterThan(0)
        } else {
          expect(await count(h.appDb, 'wam.assets')).toBe(0)
        }
      })
    )
  })

  it('keeps staged rows inside their batch and its warehouse', async () => {
    const batch = await inContext(h.appDb, { scope: String(whA), actor }, (trx) => newBatch(trx, whA))
    await inContext(h.appDb, { scope: String(whA), actor }, (trx) => stageRow(trx, batch, whA))
    expect(await inContext(h.appDb, { scope: String(whB) }, (trx) => count(trx, 'wam.import_rows', `batch_id = ${String(batch)}`))).toBe(0)
    // In scope B the batch is invisible, so the row guard refuses before the policy is even reached.
    await expect(inContext(h.appDb, { scope: String(whB), actor }, (trx) => stageRow(trx, batch, whA, { rowNumber: 3 }))).rejects.toMatchObject(
      WRONG_STATE
    )
    // The policy itself: a row claiming warehouse A, written in scope B against a batch of B.
    const batchB = await inContext(h.appDb, { scope: String(whB), actor }, (trx) => newBatch(trx, whB))
    await expect(inContext(h.appDb, { scope: String(whB), actor }, (trx) => stageRow(trx, batchB, whA))).rejects.toMatchObject(PERMISSION_DENIED)
    // A row cannot claim a batch of another warehouse either (composite foreign key), not even for the schema owner.
    await expect(stageRow(h.ownerDb, batch, whB, { rowNumber: 3 })).rejects.toMatchObject(FK_VIOLATION)
  })

  it('evaluates the scope once per statement (InitPlan parameter), not once per row', async () => {
    const plan = await inContext(h.appDb, { scope: String(whA) }, async (trx) => {
      await sql`SET LOCAL enable_seqscan = off`.execute(trx)
      const { rows } = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN SELECT id FROM wam.assets WHERE warehouse_id = ${whA} ORDER BY id LIMIT 50`.execute(trx)
      return rows.map((r) => r['QUERY PLAN']).join('\n')
    })
    expect(plan).toMatch(/InitPlan/)
    // The scope appears as the InitPlan's parameter ($n), in a filter or an index condition.
    expect(plan).toMatch(/warehouse_id = ANY \(\$\d+\)/)
    expect(plan).toMatch(/Index (Only )?Scan/)
  })
})

describe('history is complete and cannot be forged or skipped', () => {
  it('records creation and status changes, with reason and request ID, and nothing for other edits', async () => {
    const scopeA = { scope: String(whA), actor }
    const id = await newAsset(h.appDb, scopeA, { warehouse: whA, code: 'HIS-0001' })
    const requestId = '00000000-0000-4000-8000-000000000001'
    await inContext(h.appDb, { ...scopeA, actor: otherActor, reason: 'synthetic reason', requestId }, (trx) =>
      sql`UPDATE wam.assets SET status_id = ${status.issued} WHERE id = ${id}`.execute(trx)
    )
    await inContext(h.appDb, scopeA, (trx) => sql`UPDATE wam.assets SET notes = 'edited' WHERE id = ${id}`.execute(trx))
    await inContext(h.appDb, scopeA, (trx) => sql`UPDATE wam.assets SET status_id = status_id WHERE id = ${id}`.execute(trx))
    const { rows } = await sql<Record<string, unknown>>`
      SELECT from_status_id, to_status_id, changed_by, reason, request_id::text AS request_id
        FROM wam.asset_status_history WHERE asset_id = ${id} ORDER BY id`.execute(h.ownerDb)
    expect(rows).toEqual([
      { from_status_id: null, to_status_id: status.in_stock, changed_by: actor, reason: null, request_id: null },
      { from_status_id: status.in_stock, to_status_id: status.issued, changed_by: otherActor, reason: 'synthetic reason', request_id: requestId }
    ])
    expect(await count(h.ownerDb, 'wam.asset_warehouse_history', `asset_id = ${String(id)}`)).toBe(1)
    const { rows: stamp } = await sql<{ version: number; created_by: number; updated_by: number }>`
      SELECT version, created_by, updated_by FROM wam.assets WHERE id = ${id}`.execute(h.ownerDb)
    expect(stamp).toEqual([{ version: 4, created_by: actor, updated_by: actor }])
  })

  it('refuses any asset change without an actor, leaving no history', async () => {
    const before = await count(h.ownerDb, 'wam.asset_status_history')
    await expect(newAsset(h.appDb, { scope: String(whA) }, { warehouse: whA, code: 'HIS-0002' })).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(newAsset(h.ownerDb, {}, { warehouse: whA, code: 'HIS-0003' })).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(
      inContext(h.appDb, { scope: String(whA) }, (trx) => sql`UPDATE wam.assets SET status_id = ${status.damaged} WHERE asset_code = 'HIS-0001'`.execute(trx))
    ).rejects.toMatchObject(PERMISSION_DENIED)
    expect(await count(h.ownerDb, 'wam.asset_status_history')).toBe(before)
  })

  it('gives the server no way to write history, stamped or provenance columns', async () => {
    const scopeA = { scope: String(whA), actor }
    const id = await newAsset(h.appDb, scopeA, { warehouse: whA, code: 'HIS-0004' })
    for (const statement of [
      sql`INSERT INTO wam.asset_status_history (asset_id, warehouse_id, to_status_id, changed_at, changed_by) VALUES (${id}, ${whA}, ${status.issued}, now(), ${actor})`,
      sql`UPDATE wam.asset_status_history SET reason = 'forged' WHERE asset_id = ${id}`,
      sql`DELETE FROM wam.asset_status_history WHERE asset_id = ${id}`,
      sql`UPDATE wam.assets SET version = 99 WHERE id = ${id}`,
      sql`UPDATE wam.assets SET updated_by = ${otherActor} WHERE id = ${id}`,
      sql`UPDATE wam.assets SET warehouse_id = ${whA} WHERE id = ${id}`,
      sql`UPDATE wam.assets SET origin = 'import' WHERE id = ${id}`,
      sql`UPDATE wam.assets SET origin_warehouse_id = ${whA} WHERE id = ${id}`,
      sql`UPDATE wam.assets SET retired_at = now() WHERE id = ${id}`,
      sql`DELETE FROM wam.assets WHERE id = ${id}`,
      sql`INSERT INTO wam.assets (warehouse_id, asset_code, name, item_type_id, status_id, origin, created_by)
            VALUES (${whA}, 'HIS-0005', 'x', ${itemType}, ${status.in_stock}, 'manual', ${otherActor})`
    ]) {
      await expect(inContext(h.appDb, scopeA, (trx) => statement.execute(trx))).rejects.toMatchObject(PERMISSION_DENIED)
    }
  })

  it('keeps history append-only and assets undeletable even for the schema owner', async () => {
    await expect(sql`UPDATE wam.asset_status_history SET reason = 'x'`.execute(h.ownerDb)).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(sql`DELETE FROM wam.asset_status_history`.execute(h.ownerDb)).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(sql`TRUNCATE wam.asset_warehouse_history`.execute(h.ownerDb)).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(inContext(h.ownerDb, { actor }, (trx) => sql`DELETE FROM wam.assets`.execute(trx))).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(sql`TRUNCATE wam.assets CASCADE`.execute(h.ownerDb)).rejects.toMatchObject(PERMISSION_DENIED)
  })
})

describe('handover parties as ids, with erasure (PD-05, option C)', () => {
  async function newPerson(warehouse: number, name: string): Promise<number> {
    return inContext(h.appDb, { scope: String(warehouse), actor }, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO wam.persons (warehouse_id, display_name) VALUES (${warehouse}, ${name}) RETURNING id`.execute(trx)
      return Number(rows[0]?.id)
    })
  }

  it('keeps names out of the history tables entirely', async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'wam' AND table_name IN ('asset_status_history', 'asset_warehouse_history')
         AND data_type IN ('text', 'character varying', 'jsonb')
       ORDER BY 1, 2`.execute(h.ownerDb)
    expect(rows).toEqual([
      { table_name: 'asset_status_history', column_name: 'reason' },
      { table_name: 'asset_warehouse_history', column_name: 'reason' }
    ])
  })

  it('records a registered user or a person by id; erasing the person removes the name and keeps the history', async () => {
    const scopeA = { scope: String(whA), actor }
    const person = await newPerson(whA, 'Synthetic Recipient')
    const byUser = await newAsset(h.appDb, scopeA, { warehouse: whA, code: 'PER-1', status: status.issued ?? 0, receivedByUser: otherActor })
    const byPerson = await newAsset(h.appDb, scopeA, { warehouse: whA, code: 'PER-2', status: status.issued ?? 0, receivedByPerson: person })
    const { rows: history } = await sql<{ asset_id: string; received_by_user_id: number | null; received_by_person_id: string | null }>`
      SELECT asset_id, received_by_user_id, received_by_person_id FROM wam.asset_status_history
       WHERE asset_id IN (${byUser}, ${byPerson}) ORDER BY asset_id`.execute(h.ownerDb)
    expect(history.map((r) => [Number(r.asset_id), r.received_by_user_id, r.received_by_person_id === null ? null : Number(r.received_by_person_id)])).toEqual([
      [byUser, otherActor, null],
      [byPerson, null, person]
    ])
    // Erasure needs person.erase (a system permission, so its holder has MFA: rule A7).
    const erase = (by: number) =>
      inContext(h.appDb, { scope: String(whA), actor: by }, (trx) =>
        sql`UPDATE wam.persons SET display_name = NULL, erased_at = now() WHERE id = ${person}`.execute(trx)
      )
    await expect(erase(actor)).rejects.toMatchObject(PERMISSION_DENIED)
    const eraser = await insertUser(h, { username: 'synthetic.eraser', password: null })
    await appointAdministrator(h, eraser, await insertProfile(h, 'Synthetic erasure', 'system', ['person.erase']))
    // Erasure: one row changes, the id stays, every reference stays valid.
    await erase(eraser)
    const { rows: after } = await sql<{ display_name: string | null; refs: string }>`
      SELECT p.display_name, (SELECT count(*) FROM wam.asset_status_history WHERE received_by_person_id = p.id) AS refs
        FROM wam.persons p WHERE p.id = ${person}`.execute(h.ownerDb)
    expect(after).toEqual([{ display_name: null, refs: '1' }])
    await expect(
      inContext(h.appDb, scopeA, (trx) => sql`UPDATE wam.persons SET display_name = 'Restored', erased_at = NULL WHERE id = ${person}`.execute(trx))
    ).rejects.toMatchObject(WRONG_STATE)
    // An erased person cannot be chosen again; history keeps pointing at them.
    await expect(newAsset(h.appDb, scopeA, { warehouse: whA, code: 'PER-3', receivedByPerson: person })).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(sql`DELETE FROM wam.persons WHERE id = ${person}`.execute(h.ownerDb)).rejects.toMatchObject(PERMISSION_DENIED)
  })

  it('refuses a person of another warehouse, and a user and a person for the same role', async () => {
    const personB = await newPerson(whB, 'Synthetic Person B')
    const personA = await newPerson(whA, 'Synthetic Person A')
    await expect(newAsset(h.ownerDb, { actor }, { warehouse: whA, code: 'PER-4', receivedByPerson: personB })).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(
      newAsset(h.ownerDb, { actor }, { warehouse: whA, code: 'PER-5', receivedByPerson: personA, receivedByUser: otherActor })
    ).rejects.toMatchObject(CHECK_VIOLATION)
    // The server cannot even see a person of another warehouse.
    expect(await inContext(h.appDb, { scope: String(whA) }, (trx) => count(trx, 'wam.persons', `id = ${String(personB)}`))).toBe(0)
  })
})

describe('invariants', () => {
  it('keeps exact codes unique among assets in use, but only reports match-key collisions', async () => {
    const ctx = { actor }
    await newAsset(h.ownerDb, ctx, { warehouse: whA, code: 'UNQ-12' })
    await expect(newAsset(h.ownerDb, ctx, { warehouse: whB, code: 'UNQ-12' })).rejects.toMatchObject(UNIQUE_VIOLATION)
    await newAsset(h.ownerDb, ctx, { warehouse: whA, code: 'unq12' })
    const { rows } = await sql<{ asset_code: string }>`
      SELECT asset_code FROM wam.assets WHERE asset_code_key = wam.match_key('ＵＮＱ－۱۲') ORDER BY asset_code`.execute(h.ownerDb)
    expect(rows.map((r) => r.asset_code)).toEqual(['UNQ-12', 'unq12'])
    await inContext(h.ownerDb, ctx, (trx) =>
      sql`UPDATE wam.assets SET retired_at = now(), retired_by = ${actor}, retirement_reason = 'synthetic' WHERE asset_code = 'UNQ-12'`.execute(trx)
    )
    await newAsset(h.ownerDb, ctx, { warehouse: whB, code: 'UNQ-12' })
    await expect(
      inContext(h.ownerDb, ctx, (trx) => sql`UPDATE wam.assets SET notes = 'x' WHERE asset_code = 'UNQ-12' AND retired_at IS NOT NULL`.execute(trx))
    ).rejects.toMatchObject(CHECK_VIOLATION)
  })

  it('rejects blank identifiers but accepts an unknown serial', async () => {
    const ctx = { actor }
    await expect(newAsset(h.ownerDb, ctx, { warehouse: whA, code: ` -${ZWNJ} ` })).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(newAsset(h.ownerDb, ctx, { warehouse: whA, code: 'BLK-1', serial: '' })).rejects.toMatchObject(CHECK_VIOLATION)
    await newAsset(h.ownerDb, ctx, { warehouse: whA, code: 'BLK-2', serial: null })
    await newAsset(h.ownerDb, ctx, { warehouse: whA, code: '۰۰۷', serial: '0042' })
    const { rows } = await sql<{ asset_code: string; serial_number: string }>`
      SELECT asset_code, serial_number FROM wam.assets WHERE asset_code_key = '007'`.execute(h.ownerDb)
    expect(rows).toEqual([{ asset_code: '۰۰۷', serial_number: '0042' }])
  })

  it('refuses asset writes in an inactive warehouse, nothing leaves it, and deactivation waits for a write in progress', async () => {
    const whC = await insertWarehouse(h, 'SYN-C')
    const ctx = { actor }
    const leaving = await newAsset(h.ownerDb, ctx, { warehouse: whC, code: 'INA-0' })
    const writer = await ownerClient()
    const deactivator = await ownerClient()
    try {
      await writer.query('BEGIN')
      await setClientContext(writer, { actor })
      await writer.query(
        `INSERT INTO wam.assets (warehouse_id, asset_code, name, item_type_id, status_id, origin) VALUES ($1, 'INA-1', 'x', $2, $3, 'manual')`,
        [whC, itemType, status.in_stock]
      )
      await deactivator.query(`SET lock_timeout = '300ms'`)
      await expect(deactivator.query('UPDATE wam.warehouses SET is_active = false WHERE id = $1', [whC])).rejects.toMatchObject(LOCK_TIMEOUT)
      await writer.query('COMMIT')
      await deactivator.query('UPDATE wam.warehouses SET is_active = false WHERE id = $1', [whC])
    } finally {
      await writer.end()
      await deactivator.end()
    }
    await expect(newAsset(h.ownerDb, ctx, { warehouse: whC, code: 'INA-2' })).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(
      inContext(h.ownerDb, ctx, (trx) => sql`UPDATE wam.assets SET notes = 'x' WHERE asset_code = 'INA-1'`.execute(trx))
    ).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(transfer(leaving, whA)).rejects.toMatchObject(CHECK_VIOLATION)
  })

  it('protects system statuses and refuses newly chosen inactive catalogue entries', async () => {
    await expect(sql`UPDATE wam.asset_statuses SET name = 'renamed' WHERE code = 'missing'`.execute(h.ownerDb)).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(sql`UPDATE wam.asset_statuses SET is_active = false WHERE code = 'issued'`.execute(h.ownerDb)).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(sql`INSERT INTO wam.item_types (name) VALUES ('synthetic   TYPE')`.execute(h.ownerDb)).rejects.toMatchObject(UNIQUE_VIOLATION)
    await sql`INSERT INTO wam.asset_statuses (name) VALUES ('كيف تجريبي')`.execute(h.appDb)
    await expect(sql`INSERT INTO wam.asset_statuses (name) VALUES ('کیف تجریبی')`.execute(h.appDb)).rejects.toMatchObject(UNIQUE_VIOLATION)
    await expect(sql`INSERT INTO wam.asset_statuses (name, code, is_system) VALUES ('x', 'x_code', true)`.execute(h.appDb)).rejects.toMatchObject(
      PERMISSION_DENIED
    )
    const { rows } = await sql<{ id: number }>`UPDATE wam.asset_statuses SET is_active = false WHERE name = 'كيف تجريبي' RETURNING id`.execute(h.appDb)
    const inactive = rows[0]?.id ?? 0
    await expect(newAsset(h.ownerDb, { actor }, { warehouse: whA, code: 'CAT-1', status: inactive })).rejects.toMatchObject(CHECK_VIOLATION)
  })

  it('detects a stale version (optimistic concurrency)', async () => {
    const scopeA = { scope: String(whA), actor }
    const id = await newAsset(h.appDb, scopeA, { warehouse: whA, code: 'OCC-1' })
    const first = await inContext(h.appDb, scopeA, (trx) => sql`UPDATE wam.assets SET notes = 'a' WHERE id = ${id} AND version = 1`.execute(trx))
    const stale = await inContext(h.appDb, scopeA, (trx) => sql`UPDATE wam.assets SET notes = 'b' WHERE id = ${id} AND version = 1`.execute(trx))
    expect([first.numAffectedRows, stale.numAffectedRows]).toEqual([1n, 0n])
  })
})

describe('provenance survives a transfer (finding 1.1)', () => {
  it('keeps the source row valid and the history correct after an imported asset moves', async () => {
    const { row, asset } = await importNewAsset(whA, 'TRF-1')
    await transfer(asset, whB)
    const { rows } = await sql<Record<string, unknown>>`
      SELECT a.warehouse_id, a.origin, a.origin_warehouse_id, r.id AS row_id, r.warehouse_id AS row_warehouse, r.applied_at IS NOT NULL AS applied
        FROM wam.assets a JOIN wam.import_rows r ON (r.id, r.warehouse_id) = (a.origin_import_row_id, a.origin_warehouse_id)
       WHERE a.id = ${asset}`.execute(h.ownerDb)
    expect(rows).toEqual([{ warehouse_id: whB, origin: 'import', origin_warehouse_id: whA, row_id: String(row), row_warehouse: whA, applied: true }])
    const { rows: moves } = await sql<{ from_warehouse_id: number | null; to_warehouse_id: number; reason: string | null }>`
      SELECT from_warehouse_id, to_warehouse_id, reason FROM wam.asset_warehouse_history WHERE asset_id = ${asset} ORDER BY id`.execute(h.ownerDb)
    expect(moves).toEqual([
      { from_warehouse_id: null, to_warehouse_id: whA, reason: null },
      { from_warehouse_id: whA, to_warehouse_id: whB, reason: 'synthetic transfer' }
    ])
    const { rows: created } = await sql<{ import_row_id: string }>`
      SELECT import_row_id FROM wam.asset_status_history WHERE asset_id = ${asset}`.execute(h.ownerDb)
    expect(created.map((r) => Number(r.import_row_id))).toEqual([row])
    // Isolation is unchanged: B sees the asset and the move; A sees the move out, not the asset;
    // the source row stays in A's scope.
    const inScope = (w: number, table: string, where: string) => inContext(h.appDb, { scope: String(w) }, (trx) => count(trx, table, where))
    expect(await inScope(whB, 'wam.assets', `id = ${String(asset)}`)).toBe(1)
    expect(await inScope(whB, 'wam.asset_warehouse_history', `asset_id = ${String(asset)}`)).toBe(1)
    expect(await inScope(whA, 'wam.assets', `id = ${String(asset)}`)).toBe(0)
    expect(await inScope(whA, 'wam.asset_warehouse_history', `asset_id = ${String(asset)}`)).toBe(2)
    expect(await inScope(whB, 'wam.import_rows', `id = ${String(row)}`)).toBe(0)
    expect(await inScope(whA, 'wam.import_rows', `id = ${String(row)}`)).toBe(1)
  })

  it('keeps a committed row that updated an asset valid after that asset moves', async () => {
    const ctx = { scope: String(whA), actor }
    const asset = await newAsset(h.appDb, ctx, { warehouse: whA, code: 'TRF-2' })
    const { batch, row } = await inContext(h.appDb, ctx, async (trx) => {
      const b = await newBatch(trx, whA, 1)
      const r = await stageRow(trx, b, whA, { outcome: 'update', matched: asset, matchedVersion: 1 })
      await setBatchState(trx, b, 'previewed')
      return { batch: b, row: r }
    })
    await inContext(h.appDb, { ...ctx, importRowId: row }, async (trx) => {
      await setBatchState(trx, batch, 'committing')
      await sql`UPDATE wam.assets SET notes = 'from import' WHERE id = ${asset} AND version = 1`.execute(trx)
      await setBatchState(trx, batch, 'committed')
    })
    await transfer(asset, whB)
    const { rows } = await sql<{ matched: string; warehouse_id: number }>`
      SELECT r.matched_asset_id AS matched, a.warehouse_id FROM wam.import_rows r JOIN wam.assets a ON a.id = r.matched_asset_id
       WHERE r.id = ${row}`.execute(h.ownerDb)
    expect(rows).toEqual([{ matched: String(asset), warehouse_id: whB }])
  })
})

describe('imports in an inactive warehouse are read-only (finding 1.2)', () => {
  it('refuses batch creation, staging and state changes once the warehouse is inactive', async () => {
    const whD = await insertWarehouse(h, 'SYN-D')
    const ctx = { scope: String(whD), actor }
    const open = await inContext(h.appDb, ctx, (trx) => newBatch(trx, whD))
    await sql`UPDATE wam.warehouses SET is_active = false WHERE id = ${whD}`.execute(h.ownerDb)
    await expect(inContext(h.appDb, ctx, (trx) => newBatch(trx, whD))).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(inContext(h.appDb, ctx, (trx) => stageRow(trx, open, whD))).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(inContext(h.appDb, ctx, (trx) => setBatchState(trx, open, 'cancelled'))).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(inContext(h.appDb, ctx, (trx) => setBatchState(trx, open, 'previewed'))).rejects.toMatchObject(CHECK_VIOLATION)
  })

  it('serializes an import write with a concurrent deactivation, in both orders', async () => {
    const whE = await insertWarehouse(h, 'SYN-E')
    const ctx = { scope: String(whE), actor }
    const batch = await inContext(h.appDb, ctx, (trx) => newBatch(trx, whE))
    // Order 1: the import write starts first; the deactivation must wait for it.
    const writer = await appClient()
    const deactivator = await ownerClient()
    try {
      await writer.query('BEGIN')
      await setClientContext(writer, ctx)
      await writer.query(`INSERT INTO wam.import_rows (batch_id, warehouse_id, row_number, cells, outcome) VALUES ($1, $2, 2, '{}', 'invalid')`, [batch, whE])
      await deactivator.query(`SET lock_timeout = '300ms'`)
      await expect(deactivator.query('UPDATE wam.warehouses SET is_active = false WHERE id = $1', [whE])).rejects.toMatchObject(LOCK_TIMEOUT)
      await writer.query('COMMIT')
      // Order 2: the deactivation starts first; the import write waits, then sees it and stops.
      await deactivator.query('BEGIN')
      await deactivator.query('UPDATE wam.warehouses SET is_active = false WHERE id = $1', [whE])
      await writer.query('BEGIN')
      await setClientContext(writer, ctx)
      await writer.query(`SET LOCAL lock_timeout = '300ms'`)
      await expect(
        writer.query(`INSERT INTO wam.import_rows (batch_id, warehouse_id, row_number, cells, outcome) VALUES ($1, $2, 3, '{}', 'invalid')`, [batch, whE])
      ).rejects.toMatchObject(LOCK_TIMEOUT)
      await writer.query('ROLLBACK')
      await deactivator.query('COMMIT')
      await writer.query('BEGIN')
      await setClientContext(writer, ctx)
      await expect(
        writer.query(`INSERT INTO wam.import_rows (batch_id, warehouse_id, row_number, cells, outcome) VALUES ($1, $2, 3, '{}', 'invalid')`, [batch, whE])
      ).rejects.toMatchObject(CHECK_VIOLATION)
      await writer.query('ROLLBACK')
    } finally {
      await writer.end()
      await deactivator.end()
    }
    expect(await count(h.ownerDb, 'wam.import_rows', `batch_id = ${String(batch)}`)).toBe(1)
  })
})

describe('import batch state machine and frozen rows (finding 2)', () => {
  const scopeA = () => ({ scope: String(whA), actor })

  it('starts every batch as uploaded with the actor stamped, whatever the insert says', async () => {
    const batch = await inContext(h.ownerDb, { actor }, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO wam.import_batches (warehouse_id, state, file_name, file_sha256, file_size_bytes, file_format, created_by, version, closed_at)
        VALUES (${whA}, 'committed', 'x.csv', ${randomBytes(32)}, 1, 'csv', ${otherActor}, 7, now()) RETURNING id`.execute(trx)
      return Number(rows[0]?.id)
    })
    expect(await batchRow(h.ownerDb, batch)).toMatchObject({ state: 'uploaded', created_by: actor, closed_by: null, closed: false, version: 1 })
    await expect(
      inContext(h.appDb, scopeA(), (trx) =>
        sql`INSERT INTO wam.import_batches (warehouse_id, state, file_name, file_sha256, file_size_bytes, file_format) VALUES (${whA}, 'committed', 'x.csv', ${randomBytes(32)}, 1, 'csv')`.execute(trx)
      )
    ).rejects.toMatchObject(PERMISSION_DENIED)
    await expect(inContext(h.appDb, { scope: String(whA) }, (trx) => newBatch(trx, whA))).rejects.toMatchObject(PERMISSION_DENIED)
  })

  it('refuses invalid transitions', async () => {
    const batch = await inContext(h.appDb, scopeA(), (trx) => newBatch(trx, whA))
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'committed'))).rejects.toMatchObject(WRONG_STATE)
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'failed'))).rejects.toMatchObject(CHECK_VIOLATION)
    await inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'previewed'))
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'uploaded'))).rejects.toMatchObject(WRONG_STATE)
    // A commit always passes through 'committing' inside its own transaction (§6.1).
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'committed'))).rejects.toMatchObject(WRONG_STATE)
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'failed', 'parse_error'))).rejects.toMatchObject(WRONG_STATE)
    await inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'cancelled'))
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'previewed'))).rejects.toMatchObject(WRONG_STATE)
    expect(await batchRow(h.ownerDb, batch)).toMatchObject({ state: 'cancelled', closed_by: actor, closed: true, version: 3 })
  })

  it('commits a batch once; a committed batch and its rows can never change or reopen', async () => {
    const { batch, row } = await importNewAsset(whA, 'STM-1')
    expect(await batchRow(h.ownerDb, batch)).toMatchObject({ state: 'committed', closed_by: actor, closed: true })
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'committed'))).rejects.toMatchObject(WRONG_STATE)
    await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'previewed'))).rejects.toMatchObject(WRONG_STATE)
    await expect(
      inContext(h.appDb, scopeA(), (trx) => sql`UPDATE wam.import_batches SET row_count = 2 WHERE id = ${batch}`.execute(trx))
    ).rejects.toMatchObject(WRONG_STATE)
    // Even the schema owner cannot reopen it or rewrite its identity.
    await expect(inContext(h.ownerDb, { actor }, (trx) => setBatchState(trx, batch, 'previewed'))).rejects.toMatchObject(WRONG_STATE)
    await expect(sql`UPDATE wam.import_batches SET file_sha256 = ${randomBytes(32)} WHERE id = ${batch}`.execute(h.ownerDb)).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(sql`UPDATE wam.import_batches SET file_name = 'other.csv' WHERE id = ${batch}`.execute(h.ownerDb)).rejects.toMatchObject(WRONG_STATE)
    await expect(sql`DELETE FROM wam.import_batches WHERE id = ${batch}`.execute(h.ownerDb)).rejects.toMatchObject(PERMISSION_DENIED)
    // The server role cannot touch closing or retention columns at all.
    for (const statement of [
      sql`UPDATE wam.import_batches SET content_cleared_at = now() WHERE id = ${batch}`,
      sql`UPDATE wam.import_batches SET closed_by = ${otherActor} WHERE id = ${batch}`,
      sql`UPDATE wam.import_batches SET file_name = 'other.csv' WHERE id = ${batch}`,
      sql`UPDATE wam.import_rows SET cells = '{}' WHERE id = ${row}`,
      sql`UPDATE wam.import_rows SET applied_at = now() WHERE id = ${row}`
    ]) {
      await expect(inContext(h.appDb, scopeA(), (trx) => statement.execute(trx))).rejects.toMatchObject(PERMISSION_DENIED)
    }
    // Applied rows are frozen, and no row can be added to a closed or previewed batch.
    await expect(
      inContext(h.appDb, scopeA(), (trx) => sql`UPDATE wam.import_rows SET outcome = 'invalid' WHERE id = ${row}`.execute(trx))
    ).rejects.toMatchObject(WRONG_STATE)
    await expect(inContext(h.appDb, scopeA(), (trx) => stageRow(trx, batch, whA, { rowNumber: 3 }))).rejects.toMatchObject(WRONG_STATE)
    const previewed = await inContext(h.appDb, scopeA(), async (trx) => {
      const b = await newBatch(trx, whA)
      await setBatchState(trx, b, 'previewed')
      return b
    })
    await expect(inContext(h.appDb, scopeA(), (trx) => stageRow(trx, previewed, whA))).rejects.toMatchObject(WRONG_STATE)
  })

  it('lets only the retention step expire a batch: not the server role, not even with the marker set (revision 2.2)', async () => {
    const uploaded = await inContext(h.appDb, scopeA(), (trx) => newBatch(trx, whA))
    const previewed = await inContext(h.appDb, scopeA(), async (trx) => {
      const b = await newBatch(trx, whA)
      await setBatchState(trx, b, 'previewed')
      return b
    })
    const withMarker = (ctx: Context, batch: number) =>
      inContext(h.appDb, ctx, async (trx) => {
        await sql`SELECT set_config('wam.applying_retention', 'on', true)`.execute(trx)
        await setBatchState(trx, batch, 'expired')
      })
    for (const batch of [uploaded, previewed]) {
      // 1. Directly, as the server's role.
      await expect(inContext(h.appDb, scopeA(), (trx) => setBatchState(trx, batch, 'expired'))).rejects.toMatchObject(PERMISSION_DENIED)
      // 2. With the retention marker set by hand — with and without an actor: still refused.
      await expect(withMarker(scopeA(), batch)).rejects.toMatchObject(PERMISSION_DENIED)
      await expect(withMarker({ scope: String(whA) }, batch)).rejects.toMatchObject(PERMISSION_DENIED)
    }
    // The schema owner's rights alone are not enough either: the retention function also sets its marker.
    await expect(sql`UPDATE wam.import_batches SET state = 'expired' WHERE id = ${uploaded}`.execute(h.ownerDb)).rejects.toMatchObject(PERMISSION_DENIED)
    expect(await batchRow(h.ownerDb, uploaded)).toMatchObject({ state: 'uploaded', closed: false })
    expect(await batchRow(h.ownerDb, previewed)).toMatchObject({ state: 'previewed', closed: false })
  })

  it('lets exactly one of two concurrent commits of the same batch succeed', async () => {
    const batch = await inContext(h.appDb, scopeA(), async (trx) => {
      const b = await newBatch(trx, whA)
      await setBatchState(trx, b, 'previewed')
      return b
    })
    const first = await appClient()
    const second = await appClient()
    try {
      await first.query('BEGIN')
      await setClientContext(first, { scope: String(whA), actor })
      await first.query(`UPDATE wam.import_batches SET state = 'committing' WHERE id = $1`, [batch])
      await first.query(`UPDATE wam.import_batches SET state = 'committed' WHERE id = $1`, [batch])
      await second.query('BEGIN')
      await setClientContext(second, { scope: String(whA), actor: otherActor })
      const racing = second.query(`UPDATE wam.import_batches SET state = 'committing' WHERE id = $1`, [batch])
      const outcome = racing.then(
        () => 'committed',
        (err: unknown) => (err as { code?: string }).code
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      await first.query('COMMIT')
      expect(await outcome).toBe('55000')
      await second.query('ROLLBACK')
    } finally {
      await first.end()
      await second.end()
    }
    expect(await batchRow(h.ownerDb, batch)).toMatchObject({ state: 'committed', closed_by: actor })
  })

  it('serializes re-validating a row with committing its batch', async () => {
    const { batch, row } = await inContext(h.appDb, scopeA(), async (trx) => {
      const b = await newBatch(trx, whA)
      const r = await stageRow(trx, b, whA, { outcome: 'invalid' })
      await setBatchState(trx, b, 'previewed')
      return { batch: b, row: r }
    })
    const committer = await appClient()
    const validator = await appClient()
    try {
      await committer.query('BEGIN')
      await setClientContext(committer, { scope: String(whA), actor })
      await committer.query(`UPDATE wam.import_batches SET state = 'committing' WHERE id = $1`, [batch])
      await committer.query(`UPDATE wam.import_batches SET state = 'committed' WHERE id = $1`, [batch])
      await validator.query('BEGIN')
      await setClientContext(validator, { scope: String(whA), actor })
      await validator.query(`SET LOCAL lock_timeout = '300ms'`)
      await expect(validator.query(`UPDATE wam.import_rows SET outcome = 'suspected_duplicate' WHERE id = $1`, [row])).rejects.toMatchObject(LOCK_TIMEOUT)
      await validator.query('ROLLBACK')
      await committer.query('COMMIT')
      await validator.query('BEGIN')
      await setClientContext(validator, { scope: String(whA), actor })
      await expect(validator.query(`UPDATE wam.import_rows SET outcome = 'suspected_duplicate' WHERE id = $1`, [row])).rejects.toMatchObject(WRONG_STATE)
      await validator.query('ROLLBACK')
    } finally {
      await committer.end()
      await validator.end()
    }
  })

  it('accepts staged cells once, and only issues without cell values', async () => {
    const batch = await inContext(h.appDb, scopeA(), (trx) => newBatch(trx, whA))
    const row = await inContext(h.appDb, scopeA(), (trx) =>
      stageRow(trx, batch, whA, { outcome: 'invalid', issues: [{ code: 'invalid_date', column: 'entry_date' }] })
    )
    await expect(sql`UPDATE wam.import_rows SET cells = '{"code": "changed"}' WHERE id = ${row}`.execute(h.ownerDb)).rejects.toMatchObject(CHECK_VIOLATION)
    let n = 10
    // A field is an internal identifier or a 0-based column index below 100 — never header text from the file.
    await inContext(h.appDb, scopeA(), (trx) => stageRow(trx, batch, whA, { rowNumber: 9, outcome: 'invalid', issues: [{ code: 'too_long', column: 7 }] }))
    for (const issues of [
      [{ code: 'invalid_date', value: 'cell text' }],
      ['cell text'],
      [{ column: 'entry_date' }],
      [{ code: 'Not A Code' }],
      [{ code: 'x', column: 'Serial No.' }],
      [{ code: 'x', column: 100 }],
      [{ code: 'x', column: 1.5 }],
      [{ code: 'x', column: -1 }]
    ]) {
      await expect(inContext(h.appDb, scopeA(), (trx) => stageRow(trx, batch, whA, { rowNumber: n++, outcome: 'invalid', issues }))).rejects.toMatchObject(CHECK_VIOLATION)
    }
  })

  it('refuses forged provenance', async () => {
    const ctx = scopeA()
    const existing = await newAsset(h.appDb, ctx, { warehouse: whA, code: 'FRG-0' })
    const { batch, row, invalid, update } = await inContext(h.appDb, ctx, async (trx) => {
      const b = await newBatch(trx, whA)
      const r = await stageRow(trx, b, whA, { rowNumber: 2 })
      const i = await stageRow(trx, b, whA, { rowNumber: 3, outcome: 'invalid' })
      const u = await stageRow(trx, b, whA, { rowNumber: 4, outcome: 'update', matched: existing, matchedVersion: 1 })
      await setBatchState(trx, b, 'previewed')
      return { batch: b, row: r, invalid: i, update: u }
    })
    // A manual asset cannot claim a row; an imported one cannot claim an invalid row.
    await expect(newAsset(h.appDb, ctx, { warehouse: whA, code: 'FRG-1', origin: 'manual', importRow: row })).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(
      inContext(h.appDb, ctx, async (trx) => {
        await setBatchState(trx, batch, 'committing')
        await insertAsset(trx, { warehouse: whA, code: 'FRG-2', origin: 'import', importRow: invalid })
      })
    ).rejects.toMatchObject(CHECK_VIOLATION)
    // Nor can a new asset claim an update row: only a create row creates an asset.
    await expect(
      inContext(h.appDb, ctx, async (trx) => {
        await setBatchState(trx, batch, 'committing')
        await insertAsset(trx, { warehouse: whA, code: 'FRG-2', origin: 'import', importRow: update })
      })
    ).rejects.toMatchObject(CHECK_VIOLATION)
    // Outside a commit no row can be claimed; a row of a committed batch never again.
    await expect(newAsset(h.appDb, ctx, { warehouse: whA, code: 'FRG-2', origin: 'import', importRow: row })).rejects.toMatchObject(WRONG_STATE)
    const committed = await importNewAsset(whA, 'FRG-3')
    // (That row already has its asset; the unique source-row index refuses before any trigger runs.)
    await expect(newAsset(h.appDb, ctx, { warehouse: whA, code: 'FRG-4', origin: 'import', importRow: committed.row })).rejects.toMatchObject(UNIQUE_VIOLATION)
    // History cannot be attributed to a row of another warehouse through the setting.
    const rowB = await inContext(h.appDb, { scope: String(whB), actor }, async (trx) => stageRow(trx, await newBatch(trx, whB), whB))
    await expect(newAsset(h.appDb, { ...ctx, importRowId: rowB }, { warehouse: whA, code: 'FRG-5' })).rejects.toMatchObject(CHECK_VIOLATION)
    // Second layer: with the apply trigger switched off (test only, as the table owner, rolled back), the
    // history trigger alone still refuses that row.
    await expect(
      inContext(h.ownerDb, { actor, importRowId: rowB }, async (trx) => {
        await sql`ALTER TABLE wam.assets DISABLE TRIGGER assets_apply_import_row`.execute(trx)
        await insertAsset(trx, { warehouse: whA, code: 'FRG-5' })
        throw new Error('the history trigger accepted the row (this transaction is rolled back regardless)')
      })
    ).rejects.toMatchObject(CHECK_VIOLATION)
    // A row cannot match an asset of another warehouse.
    const inB = await newAsset(h.ownerDb, { actor }, { warehouse: whB, code: 'FRG-6' })
    const openA = await inContext(h.appDb, ctx, (trx) => newBatch(trx, whA))
    await expect(stageRow(h.ownerDb, openA, whA, { outcome: 'update', matched: inB, matchedVersion: 1 })).rejects.toMatchObject(CHECK_VIOLATION)
    expect(batch).toBeGreaterThan(0)
  })
})

describe('retention (PD-09)', () => {
  /** Moves a batch's timestamps into the past. Test-only: a superuser bypasses the triggers to do it. */
  async function backdate(batch: number, days: number): Promise<void> {
    await h.superDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx)
      await sql`UPDATE wam.import_batches
                   SET updated_at = now() - make_interval(days => ${days}),
                       closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE now() - make_interval(days => ${days}) END
                 WHERE id = ${batch}`.execute(trx)
    })
  }

  async function closedBatch(warehouse: number, state: 'cancelled' | 'failed'): Promise<{ batch: number; row: number }> {
    return inContext(h.appDb, { scope: String(warehouse), actor }, async (trx) => {
      const b = await newBatch(trx, warehouse)
      const r = await stageRow(trx, b, warehouse, { cells: { code: 'synthetic content' } })
      await setBatchState(trx, b, state, state === 'failed' ? 'parse_error' : null)
      return { batch: b, row: r }
    })
  }

  async function cells(row: number): Promise<unknown> {
    const { rows } = await sql<{ cells: unknown }>`SELECT cells FROM wam.import_rows WHERE id = ${row}`.execute(h.ownerDb)
    return rows[0]?.cells
  }

  it('expires abandoned batches and clears cells on schedule, keeps provenance, and audits every run', async () => {
    const oldCommit = await importNewAsset(whA, 'RET-1')
    const recentCommit = await importNewAsset(whA, 'RET-2')
    const oldFailed = await closedBatch(whA, 'failed')
    const recentCancelled = await closedBatch(whA, 'cancelled')
    const whF = await insertWarehouse(h, 'SYN-F')
    const inactiveCancelled = await closedBatch(whF, 'cancelled')
    const inactiveAbandoned = await inContext(h.appDb, { scope: String(whF), actor }, (trx) => newBatch(trx, whF))
    await sql`UPDATE wam.warehouses SET is_active = false WHERE id = ${whF}`.execute(h.ownerDb)
    const abandoned = await inContext(h.appDb, { scope: String(whA), actor }, async (trx) => {
      const b = await newBatch(trx, whA)
      return { batch: b, row: await stageRow(trx, b, whA, { cells: { code: 'abandoned content' } }) }
    })
    const recentOpen = await inContext(h.appDb, { scope: String(whA), actor }, (trx) => newBatch(trx, whA))
    const sixDaysOpen = await inContext(h.appDb, { scope: String(whA), actor }, (trx) => newBatch(trx, whA))
    await backdate(oldCommit.batch, 91)
    await backdate(recentCommit.batch, 89)
    await backdate(oldFailed.batch, 8)
    await backdate(recentCancelled.batch, 6)
    await backdate(inactiveCancelled.batch, 8)
    await backdate(abandoned.batch, 8)
    await backdate(inactiveAbandoned, 8)
    await backdate(sixDaysOpen, 6)

    const auditBefore = await count(h.ownerDb, 'wam.audit_events', `action = 'import.retention_applied'`)
    const { rows: first } = await sql<{ expired_batches: number; cleared_batches: number; cleared_rows: number }>`
      SELECT * FROM wam.apply_import_retention()`.execute(h.appDb)
    expect(first).toEqual([{ expired_batches: 2, cleared_batches: 3, cleared_rows: 3 }])

    expect(await batchRow(h.ownerDb, abandoned.batch)).toMatchObject({ state: 'expired', closed_by: null, closed: true, cleared: false })
    expect(await batchRow(h.ownerDb, inactiveAbandoned)).toMatchObject({ state: 'expired', closed_by: null, closed: true })
    expect(await batchRow(h.ownerDb, recentOpen)).toMatchObject({ state: 'uploaded', closed: false })
    expect(await batchRow(h.ownerDb, sixDaysOpen)).toMatchObject({ state: 'uploaded', closed: false })
    for (const cleared of [oldCommit, oldFailed, inactiveCancelled]) {
      expect(await cells(cleared.row)).toEqual({})
      expect(await batchRow(h.ownerDb, cleared.batch)).toMatchObject({ cleared: true, file_name: null })
    }
    for (const kept of [recentCommit, recentCancelled, abandoned]) {
      expect(await batchRow(h.ownerDb, kept.batch)).toMatchObject({ cleared: false, file_name: 'synthetic.csv' })
    }
    expect(await cells(recentCommit.row)).toEqual({ code: 'RET-2' })
    expect(await cells(recentCancelled.row)).toEqual({ code: 'synthetic content' })
    expect(await cells(abandoned.row)).toEqual({ code: 'abandoned content' })
    // Provenance remains: the asset still names its row, which keeps its position, outcome and application.
    const { rows: kept } = await sql<Record<string, unknown>>`
      SELECT r.row_number, r.outcome, r.applied_at IS NOT NULL AS applied, b.file_sha256 IS NOT NULL AS hashed, b.state
        FROM wam.assets a JOIN wam.import_rows r ON (r.id, r.warehouse_id) = (a.origin_import_row_id, a.origin_warehouse_id)
        JOIN wam.import_batches b ON b.id = r.batch_id WHERE a.id = ${oldCommit.asset}`.execute(h.ownerDb)
    expect(kept).toEqual([{ row_number: 2, outcome: 'create', applied: true, hashed: true, state: 'committed' }])

    const { rows: audit } = await sql<{ actor_user_id: number | null; outcome: string; details: unknown }>`
      SELECT actor_user_id, outcome, details FROM wam.audit_events WHERE action = 'import.retention_applied' ORDER BY id DESC LIMIT 1`.execute(h.ownerDb)
    expect(audit).toEqual([{ actor_user_id: null, outcome: 'success', details: { expired_batches: 2, cleared_batches: 3, cleared_rows: 3 } }])

    // Idempotent; each run is audited, also when it changes nothing.
    const { rows: second } = await sql`SELECT * FROM wam.apply_import_retention()`.execute(h.appDb)
    expect(second).toEqual([{ expired_batches: 0, cleared_batches: 0, cleared_rows: 0 }])
    expect(await count(h.ownerDb, 'wam.audit_events', `action = 'import.retention_applied'`)).toBe(auditBefore + 2)

    // An expired batch's cells are cleared seven days after it expired.
    await backdate(abandoned.batch, 8)
    const { rows: third } = await sql`SELECT * FROM wam.apply_import_retention()`.execute(h.appDb)
    expect(third).toEqual([{ expired_batches: 0, cleared_batches: 1, cleared_rows: 1 }])
    expect(await cells(abandoned.row)).toEqual({})
    expect(await batchRow(h.ownerDb, abandoned.batch)).toMatchObject({ cleared: true, file_name: null })
    // Cleared content cannot be put back, not even by the schema owner; the server role cannot touch the name.
    await expect(sql`UPDATE wam.import_rows SET cells = '{"code": "x"}' WHERE id = ${abandoned.row}`.execute(h.ownerDb)).rejects.toMatchObject(WRONG_STATE)
    await expect(sql`UPDATE wam.import_batches SET file_name = 'restored.csv' WHERE id = ${oldCommit.batch}`.execute(h.ownerDb)).rejects.toMatchObject(WRONG_STATE)
    await expect(
      inContext(h.appDb, { scope: String(whA), actor }, (trx) => sql`UPDATE wam.import_batches SET file_name = 'x.csv' WHERE id = ${recentCommit.batch}`.execute(trx))
    ).rejects.toMatchObject(PERMISSION_DENIED)
    // Not even the schema owner clears a name early, outside the retention function.
    await expect(
      sql`UPDATE wam.import_batches SET file_name = NULL, content_cleared_at = now() WHERE id = ${recentCommit.batch}`.execute(h.ownerDb)
    ).rejects.toMatchObject(WRONG_STATE)
  })
})

describe('a row is applied only by its asset operation inside the commit (revision 2.1, finding 1)', () => {
  const ctxA = () => ({ scope: String(whA), actor })

  async function previewedBatch(rows: readonly RowValues[]): Promise<{ batch: number; rows: number[] }> {
    return inContext(h.appDb, ctxA(), async (trx) => {
      const b = await newBatch(trx, whA)
      const ids: number[] = []
      for (const [i, values] of rows.entries()) ids.push(await stageRow(trx, b, whA, { rowNumber: i + 2, ...values }))
      await setBatchState(trx, b, 'previewed')
      return { batch: b, rows: ids }
    })
  }

  async function appliedAt(row: number): Promise<unknown> {
    const { rows } = await sql<{ applied_at: unknown }>`SELECT applied_at FROM wam.import_rows WHERE id = ${row}`.execute(h.ownerDb)
    return rows[0]?.applied_at
  }

  it('refuses a forged applied_at on a previewed batch, and a commit that applied nothing', async () => {
    const staged = await previewedBatch([{ cells: { code: 'APP-1' } }])
    const batch = staged.batch
    const row = staged.rows[0] ?? 0
    // The server's role has no privilege on applied_at at all.
    await expect(
      inContext(h.appDb, ctxA(), (trx) => sql`UPDATE wam.import_rows SET applied_at = '2000-01-01T00:00:00Z' WHERE id = ${row}`.execute(trx))
    ).rejects.toMatchObject(PERMISSION_DENIED)
    // Not even the schema owner marks it applied without the asset operation: not on the previewed batch,
    // and not inside a commit either.
    await expect(sql`UPDATE wam.import_rows SET applied_at = '2000-01-01T00:00:00Z' WHERE id = ${row}`.execute(h.ownerDb)).rejects.toMatchObject(WRONG_STATE)
    await expect(
      inContext(h.ownerDb, { actor }, async (trx) => {
        await setBatchState(trx, batch, 'committing')
        await sql`UPDATE wam.import_rows SET applied_at = '2000-01-01T00:00:00Z' WHERE id = ${row}`.execute(trx)
        await setBatchState(trx, batch, 'committed')
      })
    ).rejects.toMatchObject(WRONG_STATE)
    // A commit that applied nothing cannot complete; a transaction cannot leave the batch 'committing'.
    await expect(
      inContext(h.appDb, ctxA(), async (trx) => {
        await setBatchState(trx, batch, 'committing')
        await setBatchState(trx, batch, 'committed')
      })
    ).rejects.toMatchObject(WRONG_STATE)
    await expect(inContext(h.appDb, ctxA(), (trx) => setBatchState(trx, batch, 'committing'))).rejects.toMatchObject(WRONG_STATE)
    expect(await batchRow(h.ownerDb, batch)).toMatchObject({ state: 'previewed', closed: false })
    expect(await appliedAt(row)).toBeNull()
  })

  it('stamps applied_at in a valid commit, and a failed commit rolls everything back together', async () => {
    const staged = await previewedBatch([{ cells: { code: 'APP-2' } }, { cells: { code: 'APP-3' } }])
    const batch = staged.batch
    const [first, second] = [staged.rows[0] ?? 0, staged.rows[1] ?? 0]
    const commit = () =>
      inContext(h.appDb, ctxA(), async (trx) => {
        await setBatchState(trx, batch, 'committing')
        await sql`INSERT INTO wam.audit_events (action, outcome, warehouse_id, details)
                  VALUES ('import.committed', 'success', ${whA}, ${JSON.stringify({ probe: batch })}::jsonb)`.execute(trx)
        await setContext(trx, { ...ctxA(), importRowId: first })
        await insertAsset(trx, { warehouse: whA, code: 'APP-2', origin: 'import', importRow: first })
        await setContext(trx, { ...ctxA(), importRowId: second })
        await insertAsset(trx, { warehouse: whA, code: 'APP-3', origin: 'import', importRow: second })
        await setBatchState(trx, batch, 'committed')
      })
    const probes = () => count(h.ownerDb, 'wam.audit_events', `details->>'probe' = '${String(batch)}'`)
    // The second code is already in use elsewhere: the commit fails part-way.
    await newAsset(h.ownerDb, { actor }, { warehouse: whB, code: 'APP-3' })
    await expect(commit()).rejects.toMatchObject(UNIQUE_VIOLATION)
    expect(await batchRow(h.ownerDb, batch)).toMatchObject({ state: 'previewed', closed: false })
    expect(await count(h.ownerDb, 'wam.assets', `asset_code = 'APP-2'`)).toBe(0)
    expect([await appliedAt(first), await appliedAt(second)]).toEqual([null, null])
    expect(await probes()).toBe(0)
    // With the conflict gone, the same commit succeeds; every marker is the commit's own timestamp.
    await inContext(h.ownerDb, { actor }, (trx) =>
      sql`UPDATE wam.assets SET retired_at = now(), retired_by = ${actor}, retirement_reason = 'synthetic' WHERE asset_code = 'APP-3'`.execute(trx)
    )
    await commit()
    const { rows } = await sql<{ same: boolean; n: string }>`
      SELECT bool_and(r.applied_at = b.closed_at AND r.applied_at = a.created_at) AS same, count(*) AS n
        FROM wam.import_rows r JOIN wam.import_batches b ON b.id = r.batch_id JOIN wam.assets a ON a.origin_import_row_id = r.id
       WHERE r.batch_id = ${batch}`.execute(h.ownerDb)
    expect(rows).toEqual([{ same: true, n: '2' }])
    expect(await batchRow(h.ownerDb, batch)).toMatchObject({ state: 'committed', closed_by: actor })
    expect(await probes()).toBe(1)
  })

  it('applies an update row once, only to its matched asset, at the version its preview saw', async () => {
    const target = await newAsset(h.appDb, ctxA(), { warehouse: whA, code: 'APP-4' })
    const other = await newAsset(h.appDb, ctxA(), { warehouse: whA, code: 'APP-5' })
    const staged = await previewedBatch([{ outcome: 'update', matched: target, matchedVersion: 1 }])
    const row = staged.rows[0] ?? 0
    const attempt = (fn: (trx: Transaction<Database>) => Promise<unknown>) =>
      inContext(h.appDb, { ...ctxA(), importRowId: row }, async (trx) => {
        await setBatchState(trx, staged.batch, 'committing')
        await fn(trx)
      })
    await expect(attempt((trx) => sql`UPDATE wam.assets SET notes = 'x' WHERE id = ${other}`.execute(trx))).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(
      attempt(async (trx) => {
        await sql`UPDATE wam.assets SET notes = 'x' WHERE id = ${target}`.execute(trx)
        await sql`UPDATE wam.assets SET notes = 'y' WHERE id = ${target}`.execute(trx)
      })
    ).rejects.toMatchObject(WRONG_STATE)
    await inContext(h.appDb, ctxA(), (trx) => sql`UPDATE wam.assets SET notes = 'meanwhile' WHERE id = ${target}`.execute(trx))
    await expect(attempt((trx) => sql`UPDATE wam.assets SET notes = 'x' WHERE id = ${target}`.execute(trx))).rejects.toMatchObject(CHECK_VIOLATION)
    expect(await batchRow(h.ownerDb, staged.batch)).toMatchObject({ state: 'previewed' })
    expect(await appliedAt(row)).toBeNull()
  })
})

describe('catalogue names (revision 2.1, finding 5)', () => {
  it('keeps legitimately different names apart: punctuation and separators count', async () => {
    for (const [a, b] of [['1/2 inch', '12 inch'], ['Model 3.5', 'Model 35'], ['A-1', 'A1'], ['Type A', 'TypeA'], ['C++', 'C'], ['Lab (North)', 'Lab North']]) {
      await sql`INSERT INTO wam.workshops (name) VALUES (${a}), (${b})`.execute(h.ownerDb)
    }
    expect(await count(h.ownerDb, 'wam.workshops')).toBe(12)
  })

  it('treats case, spacing, invisible marks and Persian/Arabic variants as the same name', async () => {
    const zwnj = String.fromCodePoint(0x200c)
    const rlm = String.fromCodePoint(0x200f)
    const ideographicSpace = String.fromCodePoint(0x3000)
    for (const [a, b] of [
      ['Store Room', 'store  ROOM'],
      [' Store Room 2 ', 'Store Room 2'],
      ['كيف', 'کیف'],
      ['واحد ۱۲', 'واحد 12'],
      ['ＬＡＢ ９', 'lab 9'],
      [`آسیب${zwnj}دیده`, 'آسیب دیده'],
      [`Bay${rlm} 7`, 'Bay 7'],
      [`Dock${ideographicSpace}3`, 'dock 3']
    ]) {
      await sql`INSERT INTO wam.countries (name) VALUES (${a})`.execute(h.ownerDb)
      await expect(sql`INSERT INTO wam.countries (name) VALUES (${b})`.execute(h.ownerDb), [a, b].join(' / ')).rejects.toMatchObject(UNIQUE_VIOLATION)
    }
    const { rows } = await sql<{ k: string }>`SELECT wam.name_key(${'  Store' + ideographicSpace + 'ROOM-1/2  '}) AS k`.execute(h.ownerDb)
    expect(rows).toEqual([{ k: 'store room-1/2' }])
  })
})

describe('UNASSIGNED (revision 2.1, finding 6)', () => {
  it('is the single, always-active system warehouse, reached through an ordinary warehouse scope', async () => {
    const { rows } = await sql<{ id: number }>`SELECT id FROM wam.warehouses WHERE is_system AND code = 'UNASSIGNED'`.execute(h.ownerDb)
    expect(rows).toHaveLength(1)
    const unassigned = rows[0]?.id ?? 0
    await expect(sql`INSERT INTO wam.warehouses (code, name, is_system) VALUES ('SECOND', 'Second system', true)`.execute(h.ownerDb)).rejects.toMatchObject(
      UNIQUE_VIOLATION
    )
    await expect(sql`UPDATE wam.warehouses SET is_active = false WHERE id = ${unassigned}`.execute(h.ownerDb)).rejects.toMatchObject(CHECK_VIOLATION)
    await expect(sql`UPDATE wam.warehouses SET code = 'OTHER' WHERE id = ${unassigned}`.execute(h.appDb)).rejects.toMatchObject(PERMISSION_DENIED)
    const asset = await newAsset(h.appDb, { scope: String(unassigned), actor }, { warehouse: unassigned, code: 'UNA-1' })
    expect(await inContext(h.appDb, { scope: String(whA) }, (trx) => count(trx, 'wam.assets', `id = ${String(asset)}`))).toBe(0)
    expect(await inContext(h.appDb, { scope: String(unassigned) }, (trx) => count(trx, 'wam.assets', `id = ${String(asset)}`))).toBe(1)
  })
})

describe('the server role cannot subvert definer functions, triggers or the permission rules (finding 7)', () => {
  it('cannot alter, replace or re-own a SECURITY DEFINER function, or switch triggers off', async () => {
    for (const statement of [
      'ALTER FUNCTION wam.assets_record_history() SECURITY INVOKER',
      'ALTER FUNCTION wam.apply_import_retention() OWNER TO wam_app',
      'ALTER FUNCTION wam.persons_tombstone_idempotency() SECURITY INVOKER',
      'DROP TRIGGER persons_tombstone_idempotency ON wam.persons',
      'ALTER TABLE wam.persons DISABLE TRIGGER persons_tombstone_idempotency',
      'UPDATE wam.idempotency_keys SET fingerprint = fingerprint',
      "ALTER FUNCTION wam.apply_import_retention() SET search_path = public",
      "CREATE OR REPLACE FUNCTION wam.assets_record_history() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'",
      'ALTER TABLE wam.assets DISABLE TRIGGER assets_record_history',
      'DROP TRIGGER assets_stamp_change ON wam.assets',
      'ALTER TABLE wam.assets DISABLE ROW LEVEL SECURITY',
      'SET session_replication_role = replica'
    ]) {
      await expect(sql.raw(statement).execute(h.appDb), statement).rejects.toMatchObject(PERMISSION_DENIED)
    }
    const { rows } = await sql<{ owner: string; public_execute: boolean; member: boolean }>`
      SELECT pg_get_userbyid(p.proowner) AS owner,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_execute,
             pg_has_role('wam_app', 'wam_owner', 'MEMBER') AS member
        FROM pg_proc p WHERE p.pronamespace = 'wam'::regnamespace AND p.prosecdef ORDER BY p.proname`.execute(h.ownerDb)
    expect(rows).toHaveLength(5)
    for (const r of rows) expect(r).toEqual({ owner: 'wam_owner', public_execute: false, member: false })
  })

  it('assigns catalog.manage to nobody, and its holder needs an enrolled authenticator (rules A1, A7)', async () => {
    expect(await count(h.ownerDb, 'wam.permission_profile_permissions', `permission = 'catalog.manage'`)).toBe(0)
    const holder = await insertUser(h, { username: 'synthetic.catalog', password: null })
    await expect(
      h.ownerDb.transaction().execute(async (trx) => {
        const { rows } = await sql<{ id: number }>`INSERT INTO wam.permission_profiles (name, scope) VALUES ('Synthetic catalogue', 'system') RETURNING id`.execute(trx)
        const profile = rows[0]?.id ?? 0
        await sql`INSERT INTO wam.permission_profile_permissions (profile_id, scope, permission) VALUES (${profile}, 'system', 'catalog.manage')`.execute(trx)
        await sql`INSERT INTO wam.user_system_profiles (user_id, profile_id) VALUES (${holder}, ${profile})`.execute(trx)
      })
    ).rejects.toMatchObject(CHECK_VIOLATION)
  })
})

const insertBatch = `INSERT INTO wam.import_batches (warehouse_id, file_name, file_sha256, file_size_bytes, file_format)
                     VALUES ($1, 'race.csv', $2, 1, 'csv')`
const insertPerson = `INSERT INTO wam.persons (warehouse_id, display_name) VALUES ($1, 'Synthetic Race Person')`
const insertItemType = `INSERT INTO wam.item_types (name) VALUES ('Synthetic race type')`
const outcome = (p: Promise<unknown>) => p.then(() => 'done', (err: unknown) => (err as { code?: string }).code ?? 'error')

/** pg_dump --schema-only of schema wam, without comments and pg_dump's per-run \restrict keys. */
async function schemaDump(url: string): Promise<string> {
  const { stdout } = await promisify(execFile)(`${findPostgresBindir()}/pg_dump`, ['--schema-only', '--schema=wam', `--dbname=${url}`], {
    env: { PATH: process.env.PATH ?? '' },
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout
    .split('\n')
    .filter((line) => !line.startsWith('--') && !line.startsWith('\\restrict') && !line.startsWith('\\unrestrict') && line.trim() !== '')
    .join('\n')
}

describe('migrations 0005–0007 are exactly the approved draft, with guarded downs (O-16)', () => {
  it('produce exactly the schema, grants and seed rows of the approved draft', async () => {
    // 0005–0007 are the approved draft; 0008 (review finding S-2) is a later addition, so the comparison is
    // made against a database migrated exactly to 0007.
    const draftDb = await createTestDatabase()
    const migratedDb = await createTestDatabase()
    try {
      const owner = connect(draftDb.urls.owner)
      const migratedOwner = connect(migratedDb.urls.owner)
      try {
        const upTo = (last: string) => Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= last))
        expect((await createMigrator(owner, upTo('0004_administrators_require_mfa')).migrateToLatest()).error).toBeUndefined()
        expect((await createMigrator(migratedOwner, upTo('0007_import_staging')).migrateToLatest()).error).toBeUndefined()
        await runScript(draftDb.urls.owner, DRAFT)
        const [fromDraft, fromMigrations] = await Promise.all([schemaDump(draftDb.urls.superuser), schemaDump(migratedDb.urls.superuser)])
        expect(fromMigrations.length).toBeGreaterThan(20_000)
        expect(fromMigrations).toBe(fromDraft)
        const seeds = async (db: Kysely<Database>) => ({
          statuses: (await sql`SELECT code, name, sort_order FROM wam.asset_statuses WHERE is_system ORDER BY id`.execute(db)).rows,
          permissions: (await sql`SELECT code, scope, description FROM wam.permissions ORDER BY code`.execute(db)).rows
        })
        expect(await seeds(migratedOwner)).toEqual(await seeds(owner))
        expect(await seeds(h.ownerDb)).toEqual(await seeds(owner))
        // The approved combined reverse still reverts the draft's schema.
        await runScript(draftDb.urls.owner, DRAFT_DOWN)
      } finally {
        await owner.destroy()
        await migratedOwner.destroy()
      }
    } finally {
      await draftDb.drop()
      await migratedDb.drop()
    }
  }, 120_000)

  it('refuse to revert once the schema holds data, and change nothing', async () => {
    // The latest migration, 0008, guards stored responses linked to persons; this database has one.
    const { rows: persons } = await sql<{ id: string }>`SELECT id FROM wam.persons ORDER BY id LIMIT 1`.execute(h.ownerDb)
    const user = await insertUser(h, { username: 'synthetic.keyholder', password: null })
    await sql`INSERT INTO wam.idempotency_keys (user_id, key, fingerprint, subject_person_id)
              VALUES (${user}, ${randomUUID()}, ${randomBytes(32)}, ${persons[0]?.id})`.execute(h.ownerDb)
    const { error } = await createMigrator(h.ownerDb).migrateDown()
    expect(error).toMatchObject(WRONG_STATE)
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM wam.kysely_migration WHERE name IN ('0007_import_staging', '0008_idempotency_person_subjects')`.execute(h.ownerDb)
    expect(rows).toEqual([{ n: '2' }])
  })

  it.each([
    ['0007_import_staging', 'an import batch'],
    ['0006_assets_and_history', 'a person'],
    ['0005_asset_catalogue', 'a catalogue entry']
  ] as const)('%s down refuses once %s exists, and changes nothing', async (name, _what) => {
    const fresh = await createHarness()
    try {
      const migrator = createMigrator(fresh.ownerDb)
      const order = ['0008_idempotency_person_subjects', '0007_import_staging', '0006_assets_and_history', '0005_asset_catalogue']
      for (let i = 0; i < order.indexOf(name); i += 1) expect((await migrator.migrateDown()).error).toBeUndefined()
      const user = await insertUser(fresh, { username: 'guard.actor', password: null })
      const warehouse = await insertWarehouse(fresh, 'SYN-GUARD')
      const writer = await client(fresh.tdb.urls.app)
      try {
        await writer.query('BEGIN')
        await setClientContext(writer, { scope: String(warehouse), actor: user })
        if (name === '0007_import_staging') await writer.query(insertBatch, [warehouse, randomBytes(32)])
        if (name === '0006_assets_and_history') await writer.query(insertPerson, [warehouse])
        if (name === '0005_asset_catalogue') await writer.query(insertItemType)
        await writer.query('COMMIT')
      } finally {
        await writer.end()
      }
      expect((await migrator.migrateDown()).error).toMatchObject(WRONG_STATE)
      const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.kysely_migration WHERE name = ${name}`.execute(fresh.ownerDb)
      expect(rows).toEqual([{ n: '1' }])
    } finally {
      await fresh.close()
    }
  }, 120_000)

  it('revert an unused schema completely, one migration per run, after which it applies again', async () => {
    const fresh = await createHarness()
    try {
      const migrator = createMigrator(fresh.ownerDb)
      for (const name of ['0008_idempotency_person_subjects', '0007_import_staging', '0006_assets_and_history', '0005_asset_catalogue']) {
        const { error, results } = await migrator.migrateDown()
        expect(error).toBeUndefined()
        expect(results?.map((r) => [r.migrationName, r.status])).toEqual([[name, 'Success']])
      }
      const { rows } = await sql<{ tables: string; functions: string; permission: string; index: string | null }>`
        SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'wam'
                  AND tablename IN ('assets', 'persons', 'import_batches', 'import_rows', 'asset_statuses')) AS tables,
               (SELECT count(*) FROM pg_proc WHERE pronamespace = 'wam'::regnamespace AND proname = ANY (${DRAFT_FUNCTIONS})) AS functions,
               (SELECT count(*) FROM wam.permissions WHERE code IN ('catalog.manage', 'person.erase')) AS permission,
               to_regclass('wam.warehouses_single_system')::text AS index`.execute(fresh.ownerDb)
      expect(rows).toEqual([{ tables: '0', functions: '0', permission: '0', index: null }])
      const { rows: s2 } = await sql<{ column: string; fn: string }>`
        SELECT (SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'wam' AND table_name = 'idempotency_keys' AND column_name = 'subject_person_id') AS column,
               (SELECT count(*) FROM pg_proc WHERE pronamespace = 'wam'::regnamespace AND proname = 'persons_tombstone_idempotency') AS fn`.execute(fresh.ownerDb)
      expect(s2).toEqual([{ column: '0', fn: '0' }])
      expect((await migrator.migrateToLatest()).error).toBeUndefined()
    } finally {
      await fresh.close()
    }
  }, 120_000)

  it("run each down() in the runner's single transaction: one that fails after reverting leaves everything in place", async () => {
    const fresh = await createHarness()
    try {
      const withProbe = {
        ...migrations,
        '9999_probe': {
          up: async () => {
            // nothing to apply
          },
          down: async (db: Kysely<unknown>) => {
            await sql.raw(DOWN_0007).execute(db)
            throw new Error('simulated failure after the reverse had run')
          }
        }
      }
      const migrator = createMigrator(fresh.ownerDb, withProbe)
      expect((await migrator.migrateToLatest()).error).toBeUndefined()
      const { error } = await migrator.migrateDown()
      expect(error).toBeInstanceOf(Error)
      const { rows } = await sql<{ present: boolean; recorded: string }>`
        SELECT to_regclass('wam.import_batches') IS NOT NULL AS present,
               (SELECT count(*) FROM wam.kysely_migration WHERE name = '9999_probe') AS recorded`.execute(fresh.ownerDb)
      expect(rows).toEqual([{ present: true, recorded: '1' }])
    } finally {
      await fresh.close()
    }
  }, 120_000)

  /** A fresh, unused database reverted down to (and including the reversal of) the migrations after `name`. */
  async function raceSetup(name = '0007_import_staging'): Promise<{ fresh: Harness; user: number; warehouse: number }> {
    const fresh = await createHarness()
    const order = ['0008_idempotency_person_subjects', '0007_import_staging', '0006_assets_and_history', '0005_asset_catalogue']
    for (let i = 0; i < order.indexOf(name); i += 1) expect((await createMigrator(fresh.ownerDb).migrateDown()).error).toBeUndefined()
    return { fresh, user: await insertUser(fresh, { username: 'race.actor', password: null }), warehouse: await insertWarehouse(fresh, 'SYN-RACE') }
  }

  async function ownerWaitsForLock(fresh: Harness): Promise<boolean> {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_stat_activity
       WHERE datname = current_database() AND usename = 'wam_owner' AND wait_event_type = 'Lock'`.execute(fresh.superDb)
    return Number(rows[0]?.n) > 0
  }

  async function appWaitsForLock(fresh: Harness, pid: number): Promise<boolean> {
    const { rows } = await sql<{ waiting: boolean }>`
      SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`.execute(fresh.superDb)
    return rows[0]?.waiting === true
  }

  it.each([
    ['an import batch', insertBatch, (warehouse: number) => [warehouse, randomBytes(32)]],
    [
      'an audit event about imports',
      `INSERT INTO wam.audit_events (action, outcome, warehouse_id) VALUES ('import.uploaded', 'success', $1)`,
      (warehouse: number) => [warehouse]
    ]
  ] as const)('0007 down against a concurrent write that started first (%s): it waits, sees the write and refuses', async (_, statement, params) => {
    const { fresh, user, warehouse } = await raceSetup()
    try {
      const writer = await client(fresh.tdb.urls.app)
      try {
        await writer.query('BEGIN')
        await setClientContext(writer, { scope: String(warehouse), actor: user })
        await writer.query(statement, params(warehouse))
        const reverting = outcome(
          createMigrator(fresh.ownerDb)
            .migrateDown()
            .then((r) => {
              if (r.error !== undefined) throw r.error instanceof Error ? r.error : new Error('migration failed')
            })
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(await ownerWaitsForLock(fresh)).toBe(true)
        await writer.query('COMMIT')
        expect(await reverting).toBe('55000')
      } finally {
        await writer.end()
      }
      const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.kysely_migration WHERE name = '0007_import_staging'`.execute(fresh.ownerDb)
      expect(rows).toEqual([{ n: '1' }])
    } finally {
      await fresh.close()
    }
  }, 120_000)

  // The same two orders for 0006 and 0005 (review finding S-6), each on a database reverted down to it.
  it.each([
    ['0006_assets_and_history', 'a person', insertPerson, (warehouse: number) => [warehouse]],
    [
      '0006_assets_and_history',
      'an audit event about assets',
      `INSERT INTO wam.audit_events (action, outcome, warehouse_id) VALUES ('asset.created', 'success', $1)`,
      (warehouse: number) => [warehouse]
    ],
    ['0005_asset_catalogue', 'a catalogue entry', insertItemType, () => []],
    ['0005_asset_catalogue', 'an audit event about the catalogue', `INSERT INTO wam.audit_events (action, outcome) VALUES ('catalog.created', 'success')`, () => []]
  ] as const)('%s down against a concurrent write that started first (%s): it waits, sees the write and refuses', async (name, _, statement, params) => {
    const { fresh, user, warehouse } = await raceSetup(name)
    try {
      const writer = await client(fresh.tdb.urls.app)
      try {
        await writer.query('BEGIN')
        await setClientContext(writer, { scope: String(warehouse), actor: user })
        await writer.query(statement, params(warehouse))
        const reverting = outcome(
          createMigrator(fresh.ownerDb)
            .migrateDown()
            .then((r) => {
              if (r.error !== undefined) throw r.error instanceof Error ? r.error : new Error('migration failed')
            })
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(await ownerWaitsForLock(fresh)).toBe(true)
        await writer.query('COMMIT')
        expect(await reverting).toBe('55000')
      } finally {
        await writer.end()
      }
      const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM wam.kysely_migration WHERE name = ${name}`.execute(fresh.ownerDb)
      expect(rows).toEqual([{ n: '1' }])
    } finally {
      await fresh.close()
    }
  }, 120_000)

  it.each([
    ['0006_assets_and_history', DOWN_0006, insertPerson, (warehouse: number) => [warehouse], 'wam.persons'],
    ['0005_asset_catalogue', DOWN_0005, insertItemType, () => [], 'wam.item_types']
  ] as const)('%s down against a write that starts after it: the write waits, then cannot succeed', async (name, down, statement, params, table) => {
    const { fresh, user, warehouse } = await raceSetup(name)
    try {
      const writer = await client(fresh.tdb.urls.app)
      const reverter = await client(fresh.tdb.urls.owner)
      try {
        await reverter.query('BEGIN')
        await reverter.query(down)
        const pid = Number((await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
        await writer.query('BEGIN')
        await setClientContext(writer, { scope: String(warehouse), actor: user })
        const writing = outcome(writer.query(statement, params(warehouse)))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(await appWaitsForLock(fresh, pid)).toBe(true)
        await reverter.query('COMMIT')
        // undefined_table: the write finds the table gone; nothing was written anywhere.
        expect(await writing).toBe('42P01')
        await writer.query('ROLLBACK')
      } finally {
        await writer.end()
        await reverter.end()
      }
      const { rows } = await sql<{ t: string | null }>`SELECT to_regclass(${table})::text AS t`.execute(fresh.ownerDb)
      expect(rows).toEqual([{ t: null }])
    } finally {
      await fresh.close()
    }
  }, 120_000)

  it('0007 down against a write that starts after it: the write waits, then cannot succeed', async () => {
    const { fresh, user, warehouse } = await raceSetup()
    try {
      const writer = await client(fresh.tdb.urls.app)
      const reverter = await client(fresh.tdb.urls.owner)
      try {
        await reverter.query('BEGIN')
        await reverter.query(DOWN_0007)
        const pid = Number((await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
        await writer.query('BEGIN')
        await setClientContext(writer, { scope: String(warehouse), actor: user })
        const writing = outcome(writer.query(insertBatch, [warehouse, randomBytes(32)]))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(await appWaitsForLock(fresh, pid)).toBe(true)
        await reverter.query('COMMIT')
        // undefined_table: the write finds the tables gone; nothing was written anywhere.
        expect(await writing).toBe('42P01')
        await writer.query('ROLLBACK')
      } finally {
        await writer.end()
        await reverter.end()
      }
      const { rows } = await sql<{ t: string | null }>`SELECT to_regclass('wam.import_batches')::text AS t`.execute(fresh.ownerDb)
      expect(rows).toEqual([{ t: null }])
    } finally {
      await fresh.close()
    }
  }, 120_000)
})
