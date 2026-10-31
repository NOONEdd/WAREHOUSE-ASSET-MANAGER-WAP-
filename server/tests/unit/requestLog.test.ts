import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { loggerOptions } from '../../src/server.js'

// Request log lines must not carry query strings: they hold search terms, a person's name among them, and
// erasure (decision PD-05) cannot reach a log line. Found by the system test.

describe('request log lines', () => {
  it('record method and path, never the query string (with the options the server uses)', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'))
        done()
      }
    })
    const app = Fastify({ logger: { ...loggerOptions('info'), stream } })
    app.get('/api/warehouses/:id/persons', () => ({ persons: [] }))
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/warehouses/7/persons?q=Synthetic%20Secret%20Name&after=3' })
    expect(res.statusCode).toBe(200)
    await app.close()
    const incoming = lines.map((l) => JSON.parse(l) as { msg: string; req?: { method: string; url: string } }).find((l) => l.msg === 'incoming request')
    expect(incoming?.req).toMatchObject({ method: 'GET', url: '/api/warehouses/7/persons' })
    expect(lines.join('\n')).not.toMatch(/Secret|q=|after=/)
  })
})
