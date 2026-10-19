import { describe, it, expect, vi, beforeEach } from 'vitest'

let isPackaged

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return isPackaged
    }
  }
}))

const { guardDevTools } = await import('../../../src/main/utils/devToolsGuard.js')

// A minimal fake webContents: just enough to register a listener and
// record whether closeDevTools() was called, and to let the test
// trigger the 'devtools-opened' event manually the same way Electron
// itself would.
function fakeWebContents() {
  const listeners = {}
  return {
    on(event, handler) {
      listeners[event] = handler
    },
    trigger(event) {
      listeners[event]?.()
    },
    closeDevTools: vi.fn()
  }
}

beforeEach(() => {
  isPackaged = false
})

describe('guardDevTools', () => {
  it('registers a devtools-opened listener', () => {
    const wc = fakeWebContents()
    guardDevTools(wc)
    wc.trigger('devtools-opened') // isPackaged is false here — should not throw
    expect(wc.closeDevTools).not.toHaveBeenCalled()
  })

  it('does nothing in development (app.isPackaged false) — DevTools stay open', () => {
    isPackaged = false
    const wc = fakeWebContents()
    guardDevTools(wc)
    wc.trigger('devtools-opened')
    expect(wc.closeDevTools).not.toHaveBeenCalled()
  })

  it('closes DevTools immediately when opened in a packaged build', () => {
    isPackaged = true
    const wc = fakeWebContents()
    guardDevTools(wc)
    wc.trigger('devtools-opened')
    expect(wc.closeDevTools).toHaveBeenCalledTimes(1)
  })

  it('closes it again every time it is reopened in a packaged build, not just once', () => {
    isPackaged = true
    const wc = fakeWebContents()
    guardDevTools(wc)
    wc.trigger('devtools-opened')
    wc.trigger('devtools-opened')
    wc.trigger('devtools-opened')
    expect(wc.closeDevTools).toHaveBeenCalledTimes(3)
  })
})
