import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { resolveShortcut, isEditableTarget } from '../utils/shortcuts'

// Wires utils/shortcuts.js to the document. "/" focuses the current page's
// search field (any element marked data-awm-search), or opens the asset list
// with its search field focused when the page has none.
export function useGlobalShortcuts({ onHelp }) {
  const navigate = useNavigate()
  const pending = useRef(null)

  useEffect(() => {
    function onKeyDown(e) {
      if (e.defaultPrevented || e.repeat) return
      const { action, pendingSince } = resolveShortcut(
        {
          code: e.code,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          inEditable: isEditableTarget(e.target) || Boolean(document.querySelector('.ant-modal-wrap:not([style*="display: none"])')),
          now: Date.now()
        },
        pending.current
      )
      pending.current = pendingSince
      if (!action) return
      e.preventDefault()
      if (action.type === 'navigate') navigate(action.to)
      else if (action.type === 'help') onHelp()
      else if (action.type === 'focusSearch') {
        const field = document.querySelector('[data-awm-search]')
        if (field) field.focus()
        else navigate('/assets', { state: { focusSearch: true } })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate, onHelp])
}
