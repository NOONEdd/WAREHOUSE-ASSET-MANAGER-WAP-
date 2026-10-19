import { describe, it, expect } from 'vitest'
import { statusColors } from '../../src/renderer/src/theme'

// Regression test for a real bug: مفقود (Lost) was assigned the exact
// same color StatusBadge.jsx and StatusDonutChart.jsx both use as their
// fallback for an *unrecognized* status. The count was always correct —
// see tests/main/services/dashboardStats.test.js — but every "Lost"
// badge and chart slice in the app rendered visually identical to an
// error/unmapped state. These fallback values are hardcoded independently
// in each component (not imported from a shared constant), so this test
// hardcodes them too — the point is catching a value that silently
// matches either one, not DRY-ing up the components.
const KNOWN_FALLBACK_COLORS = ['#6b6560']

describe('statusColors', () => {
  it('has exactly the five real asset statuses', () => {
    expect(Object.keys(statusColors).sort()).toEqual(
      ['آسیب‌دیده', 'در انبار', 'صادر شده', 'مرجوع شده', 'مفقود'].sort()
    )
  })

  it('assigns every status a color different from every other status', () => {
    const values = Object.values(statusColors)
    expect(new Set(values).size).toBe(values.length)
  })

  it('never assigns a real status the same color used as an "unrecognized status" fallback', () => {
    for (const [status, color] of Object.entries(statusColors)) {
      expect(KNOWN_FALLBACK_COLORS, `${status} must not reuse a fallback color`).not.toContain(color)
    }
  })
})
