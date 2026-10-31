import { describe, expect, it } from 'vitest'
import { applyFieldChanges, planFieldChanges, type IncomingCell } from '../../src/imports/fieldChanges.js'
import { forAll, type Random } from '../support/seededRandom.js'

// "Blank never erases" (src/imports/fieldChanges.ts), with invented field names and values.

type Field = 'name' | 'model' | 'serial' | 'notes'
const FIELDS: readonly Field[] = ['name', 'model', 'serial', 'notes']
const VALUES = ['alpha', 'beta', 'gamma', '0042', '']

function randomRecord(random: Random): Record<Field, string | null> {
  return Object.fromEntries(FIELDS.map((f) => [f, random.int(3) === 0 ? null : random.pick(VALUES)])) as Record<Field, string | null>
}

function randomIncoming(random: Random): Partial<Record<Field, IncomingCell<string>>> {
  const incoming: Partial<Record<Field, IncomingCell<string>>> = {}
  for (const field of FIELDS) {
    const roll = random.int(3)
    if (roll === 1) incoming[field] = { kind: 'set', value: random.pick(VALUES) }
    else if (roll === 2) incoming[field] = { kind: 'clear' }
    // roll 0: the cell was blank, so the field is absent
  }
  return incoming
}

describe('planFieldChanges: examples', () => {
  const current = { name: 'alpha', model: null, serial: '0042', notes: 'kept' }

  it('changes nothing for a row of blank cells', () => {
    expect(planFieldChanges(current, {})).toEqual([])
  })

  it('sets a different value and leaves blank cells alone', () => {
    expect(planFieldChanges(current, { model: { kind: 'set', value: 'beta' } })).toEqual([{ field: 'model', before: null, after: 'beta' }])
  })

  it('does not report an identical value as a change', () => {
    expect(planFieldChanges(current, { name: { kind: 'set', value: 'alpha' } })).toEqual([])
  })

  it('clears a field only on an explicit marker, and only if it has a value', () => {
    expect(planFieldChanges(current, { notes: { kind: 'clear' } })).toEqual([{ field: 'notes', before: 'kept', after: null }])
    expect(planFieldChanges(current, { model: { kind: 'clear' } })).toEqual([])
  })

  it('keeps leading zeros: the values are compared exactly, never as numbers', () => {
    expect(planFieldChanges(current, { serial: { kind: 'set', value: '42' } })).toEqual([{ field: 'serial', before: '0042', after: '42' }])
  })

  it('refuses a field the record does not have instead of ignoring it', () => {
    const incoming = { colour: { kind: 'set', value: 'red' } } as unknown as Partial<Record<Field, IncomingCell<string>>>
    expect(() => planFieldChanges(current, incoming)).toThrow('unknown field in an import change: colour')
  })

  it('uses the given comparison', () => {
    const caseInsensitive = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    expect(planFieldChanges(current, { name: { kind: 'set', value: 'ALPHA' } }, caseInsensitive)).toEqual([])
  })

  it('applies changes to a copy', () => {
    const changes = planFieldChanges(current, { notes: { kind: 'clear' } })
    expect(applyFieldChanges(current, changes)).toEqual({ ...current, notes: null })
    expect(current.notes).toBe('kept')
  })
})

describe('planFieldChanges: properties', () => {
  it('never touches a field whose cell was blank', () => {
    forAll(0xb1a4c01, 3000, (random) => {
      const current = randomRecord(random)
      const incoming = randomIncoming(random)
      for (const { field } of planFieldChanges(current, incoming)) expect(incoming[field]).toBeDefined()
    })
  })

  it('produces null only from an explicit clear marker', () => {
    forAll(0xb1a4c02, 3000, (random) => {
      const incoming = randomIncoming(random)
      for (const change of planFieldChanges(randomRecord(random), incoming)) {
        if (change.after === null) expect(incoming[change.field]?.kind).toBe('clear')
      }
    })
  })

  it('reaches exactly the stated values for every non-blank cell', () => {
    forAll(0xb1a4c03, 3000, (random) => {
      const current = randomRecord(random)
      const incoming = randomIncoming(random)
      const next = applyFieldChanges(current, planFieldChanges(current, incoming))
      for (const field of FIELDS) {
        const cell = incoming[field]
        const expected = cell === undefined ? current[field] : cell.kind === 'clear' ? null : cell.value
        expect(next[field]).toBe(expected)
      }
    })
  })

  it('is idempotent: importing the same row again changes nothing', () => {
    forAll(0xb1a4c04, 3000, (random) => {
      const current = randomRecord(random)
      const incoming = randomIncoming(random)
      const once = applyFieldChanges(current, planFieldChanges(current, incoming))
      expect(planFieldChanges(once, incoming)).toEqual([])
    })
  })
})
