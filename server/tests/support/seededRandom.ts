// A small deterministic random source for property-style tests (mulberry32).
// No dependency: the properties are written against plain generators, and every
// failure message names the seed and case number, so a failing case can be
// replayed exactly.

export interface Random {
  /** A float in [0, 1). */
  next(): number
  /** An integer in [0, bound). */
  int(bound: number): number
  pick<T>(items: readonly T[]): T
  bool(): boolean
}

export function seededRandom(seed: number): Random {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  const int = (bound: number): number => Math.floor(next() * bound)
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)]
      if (item === undefined) throw new Error('pick from an empty list')
      return item
    },
    bool: () => next() < 0.5
  }
}

/** Runs `property` for `cases` generated cases; the seed and case number go into any failure. */
export function forAll(seed: number, cases: number, property: (random: Random, caseNumber: number) => void): void {
  const random = seededRandom(seed)
  for (let i = 0; i < cases; i++) {
    try {
      property(random, i)
    } catch (err) {
      throw new Error(`property failed (seed ${String(seed)}, case ${String(i)}): ${err instanceof Error ? err.message : String(err)}`, {
        cause: err
      })
    }
  }
}
