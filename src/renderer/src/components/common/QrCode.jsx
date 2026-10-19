import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * Renders a real QR code encoding the given value (the Asset Code, per
 * Phase 1/2's decision) — not a placeholder box. Same library will drive
 * the batch label-printing feature later.
 */
export default function QrCode({ value, size = 64 }) {
  const [src, setSrc] = useState(null)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(value, { width: size * 2, margin: 0 }).then((url) => {
      if (!cancelled) setSrc(url)
    })
    return () => {
      cancelled = true
    }
  }, [value, size])

  if (!src) {
    return <div style={{ width: size, height: size, background: 'var(--awm-border)' }} />
  }

  return (
    <img
      src={src}
      alt={`QR ${value}`}
      width={size}
      height={size}
      style={{ borderRadius: 4, border: '1px solid var(--awm-border)' }}
    />
  )
}
