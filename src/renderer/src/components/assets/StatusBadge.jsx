import { statusColors } from '../../theme'

/**
 * The one consistent visual motif used everywhere a status appears —
 * table rows, asset details, the dashboard breakdown: a solid-color
 * stamped tag rather than a generic outline pill (Phase 7 design plan).
 *
 * Deliberately NOT monospace/letter-spaced/uppercase here — those read as
 * "stamped data" for Latin script, but status labels are Persian words,
 * a connected cursive script where letter-spacing distorts the joins and
 * "uppercase" has no equivalent. The mono/stamped treatment is reserved
 * for actual Western-digit content (Asset Code, Serial Number) instead.
 */
export default function StatusBadge({ status }) {
  const color = statusColors[status] || '#6b6560'

  return (
    <span
      style={{
        display: 'inline-block',
        background: color,
        color: '#fff',
        fontSize: 12,
        fontWeight: 600,
        padding: '4px 13px',
        borderRadius: 5,
        // Phase 10 — a faint inset edge rather than a flat color block, so
        // the "stamped tag" reads with a touch of tactile depth instead of
        // a solid-fill sticker. Kept to a single low-alpha shadow line
        // (no glow, no gradient) per the brief's restraint requirement.
        boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.08), inset 0 -1px 0 rgba(0, 0, 0, 0.06)'
      }}
    >
      {status}
    </span>
  )
}
