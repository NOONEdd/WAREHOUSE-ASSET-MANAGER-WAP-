import { describe, it, expect } from 'vitest'
import { resolveShortcut, isEditableTarget, SEQUENCE_TIMEOUT_MS, SHORTCUTS } from '../../../src/renderer/src/utils/shortcuts'

const press = (code, extra = {}, pendingSince = null) => resolveShortcut({ code, now: 10_000, ...extra }, pendingSince)

describe('resolveShortcut', () => {
  it('maps single keys by physical position, so a Persian layout behaves the same', () => {
    expect(press('KeyN').action).toEqual({ type: 'navigate', to: '/assets/new' })
    expect(press('Slash').action).toEqual({ type: 'focusSearch' })
    expect(press('Slash', { shiftKey: true }).action).toEqual({ type: 'help' })
  })

  it('runs "g" sequences only within the timeout', () => {
    const started = press('KeyG')
    expect(started).toEqual({ action: null, pendingSince: 10_000 })
    expect(resolveShortcut({ code: 'KeyA', now: 10_000 + SEQUENCE_TIMEOUT_MS }, 10_000).action).toEqual({ type: 'navigate', to: '/assets' })
    expect(resolveShortcut({ code: 'KeyA', now: 10_001 + SEQUENCE_TIMEOUT_MS }, 10_000).action).toBeNull()
    for (const [code, to] of [['KeyD', '/'], ['KeyR', '/reports'], ['KeyL', '/audit-log'], ['KeyS', '/settings']]) {
      expect(press(code, {}, 9_900).action).toEqual({ type: 'navigate', to })
    }
  })

  it('a key that is not part of a sequence cancels it', () => {
    expect(press('KeyX', {}, 9_900)).toEqual({ action: null, pendingSince: null })
    expect(press('KeyA')).toEqual({ action: null, pendingSince: null })
  })

  it('never fires while typing, or with Ctrl, Alt or Meta held', () => {
    for (const extra of [{ inEditable: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(press('KeyN', extra).action).toBeNull()
      expect(press('Slash', extra).action).toBeNull()
      expect(press('KeyD', extra, 9_900).action).toBeNull()
    }
  })

  it('ignores other Shift combinations', () => {
    expect(press('KeyN', { shiftKey: true }).action).toBeNull()
    expect(press('KeyD', { shiftKey: true }, 9_900).action).toBeNull()
  })

  it('documents every shortcut it handles', () => {
    expect(SHORTCUTS.map((s) => s.keys.join(' '))).toEqual(['/', 'N', 'G D', 'G A', 'G R', 'G L', 'G S', '?'])
  })
})

describe('isEditableTarget', () => {
  const el = (matches, isContentEditable = false) => ({ isContentEditable, closest: (sel) => (matches(sel) ? {} : null) })

  it('treats fields, comboboxes and anything inside a dialog as editable', () => {
    expect(isEditableTarget(el(() => true))).toBe(true)
    expect(isEditableTarget(el(() => false, true))).toBe(true)
  })

  it('treats the page itself as not editable', () => {
    expect(isEditableTarget(el(() => false))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget({})).toBe(false)
  })
})
