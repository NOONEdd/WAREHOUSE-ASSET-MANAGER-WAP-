import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { assertEphemeralTestCluster, assertNotRoot, connectionUrl, SUPERUSER } from '../support/ephemeralPostgres.js'
import { clusterInfo, connect } from '../support/testDatabase.js'

// The harness's own guarantees: the tests run against a throwaway cluster
// and cannot be pointed at a real database by accident.

describe('test harness safety', () => {
  const info = clusterInfo()
  const superuserUrl = connectionUrl(info, SUPERUSER, info.passwords.superuser, 'postgres')

  it('accepts the throwaway cluster only when it presents this run’s token', async () => {
    await expect(assertEphemeralTestCluster(superuserUrl, info.token)).resolves.toBeUndefined()
    // A database without this run's token — any real server — is refused.
    await expect(assertEphemeralTestCluster(superuserUrl, 'some-other-run')).rejects.toThrow(/Refusing to use this database/)
  })

  it('listens on no TCP address, only on a socket in a fresh temporary directory', async () => {
    const db = connect(superuserUrl)
    try {
      const { rows } = await sql<{ listen_addresses: string }>`SHOW listen_addresses`.execute(db)
      expect(rows[0]?.listen_addresses).toBe('')
    } finally {
      await db.destroy()
    }
    expect(realpathSync(info.socketDir)).toMatch(new RegExp(`^${realpathSync(tmpdir())}/wampg-[^/]+/sock$`))
  })

  it('test workers see no PG* or WAM_* database variables from the developer’s shell', () => {
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('PG') || (k.startsWith('WAM_') && k !== 'WAM_TEST_PG_BINDIR'))
    expect(leaked).toEqual([])
  })

  it('refuses to run as root (PostgreSQL would refuse anyway, less clearly)', () => {
    expect(() => {
      assertNotRoot(0)
    }).toThrow(/normal \(non-root\) user/)
    expect(() => {
      assertNotRoot(1000)
    }).not.toThrow()
  })
})
