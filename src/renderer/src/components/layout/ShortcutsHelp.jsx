import { Modal } from 'antd'
import { SHORTCUTS } from '../../utils/shortcuts'

// Opened with "?" (Shift + /) or the header's help button. Keys are shown
// as the Latin letters printed on the keycaps; they work the same with the
// Persian layout active (utils/shortcuts.js matches physical keys).
export default function ShortcutsHelp({ open, onClose }) {
  return (
    <Modal title="میان‌برهای صفحه‌کلید" open={open} onCancel={onClose} footer={null} width={460}>
      <p style={{ marginTop: 0, color: 'var(--awm-text-secondary)', fontSize: 13 }}>
        هنگام تایپ در یک فیلد یا وقتی پنجره‌ای باز است، میان‌برها کار نمی‌کنند. با چیدمان فارسی صفحه‌کلید هم همین کلیدها کار می‌کنند.
      </p>
      <table className="awm-shortcuts-table">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys.join('+')}>
              <td>{s.description}</td>
              <td>
                {s.keys.map((k, i) => (
                  <span key={k + i}>
                    {i > 0 && <span className="awm-kbd-then"> سپس </span>}
                    <kbd className="awm-kbd">{k}</kbd>
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}
