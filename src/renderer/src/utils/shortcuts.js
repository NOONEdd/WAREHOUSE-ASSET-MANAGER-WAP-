// Keyboard shortcuts for the signed-in app (AppShell). Kept as a pure
// function so the rules can be unit-tested without a browser.
//
// Keys are matched by physical position (KeyboardEvent.code), not by the
// character typed (KeyboardEvent.key): on the Persian layout most staff
// use, the key in N's place types «د», so character matching would
// silently stop working whenever the layout is Persian. Shortcuts never fire while typing in a field, inside an
// open dialog, or with Ctrl/Alt/Meta held (those belong to the system and
// to text editing).

export const SEQUENCE_TIMEOUT_MS = 1500

// "g" then a second key: go to a page.
const GO_TO = {
  KeyD: '/',
  KeyA: '/assets',
  KeyR: '/reports',
  KeyL: '/audit-log',
  KeyS: '/settings'
}

// Shown in the help dialog, in this order.
export const SHORTCUTS = [
  { keys: ['/'], description: 'رفتن به جستجوی دارایی‌ها' },
  { keys: ['N'], description: 'افزودن دارایی' },
  { keys: ['G', 'D'], description: 'رفتن به داشبورد' },
  { keys: ['G', 'A'], description: 'رفتن به دارایی‌ها' },
  { keys: ['G', 'R'], description: 'رفتن به گزارش‌ها' },
  { keys: ['G', 'L'], description: 'رفتن به گزارش رویدادها' },
  { keys: ['G', 'S'], description: 'رفتن به تنظیمات' },
  { keys: ['?'], description: 'نمایش همین راهنما' }
]

/**
 * @param {{ code: string, shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean, inEditable?: boolean, now: number }} event
 * @param {number | null} pendingSince  time the "g" of a sequence was pressed, or null
 * @returns {{ action: null | { type: 'navigate', to: string } | { type: 'focusSearch' } | { type: 'help' }, pendingSince: number | null }}
 */
export function resolveShortcut(event, pendingSince) {
  if (event.ctrlKey || event.altKey || event.metaKey || event.inEditable) return { action: null, pendingSince: null }

  if (pendingSince !== null && event.now - pendingSince <= SEQUENCE_TIMEOUT_MS && !event.shiftKey) {
    const to = GO_TO[event.code]
    if (to) return { action: { type: 'navigate', to }, pendingSince: null }
  }

  if (event.code === 'Slash') {
    return { action: event.shiftKey ? { type: 'help' } : { type: 'focusSearch' }, pendingSince: null }
  }
  if (event.shiftKey) return { action: null, pendingSince: null }
  if (event.code === 'KeyG') return { action: null, pendingSince: event.now }
  if (event.code === 'KeyN') return { action: { type: 'navigate', to: '/assets/new' }, pendingSince: null }
  return { action: null, pendingSince: null }
}

/** True when keystrokes belong to the focused element, not to the app. */
export function isEditableTarget(target) {
  if (!target || typeof target.closest !== 'function') return false
  if (target.isContentEditable) return true
  return Boolean(
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="combobox"]')
  )
}
