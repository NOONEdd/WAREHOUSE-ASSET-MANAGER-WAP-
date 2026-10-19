/**
 * The company's official banner, used exactly as provided — full width of
 * the main content area, original aspect ratio preserved, no cropping or
 * redesign. Sits directly below the header toolbar and above all page
 * content, on every screen (not just Dashboard), so the app is always
 * immediately recognizable as belonging to Sanat Farabar Zarin Co.
 *
 * Same file (`sfz-banner.png`) also backs the PDF/Excel letterhead spec in
 * resources/branding/BRANDING.md — one source asset, used consistently
 * everywhere per the client's spec, rather than a recreation that could
 * drift from the real thing.
 */
export default function CompanyBanner() {
  return (
    <div
      style={{
        width: '100%',
        lineHeight: 0,
        // Phase 10 — a quiet shadow line under the banner's own edge so it
        // separates from the page content below as a distinct "letterhead"
        // layer rather than bleeding straight into the content padding.
        // The banner image itself is untouched — same file, same crop.
        boxShadow: '0 2px 6px rgba(20, 28, 39, 0.1)',
        position: 'relative',
        zIndex: 1
      }}
    >
      <img
        src="./branding/sfz-banner.png"
        alt="شرکت صنعت فرابر زرین — Sanat Farabar Zarin Co."
        style={{ width: '100%', height: 'auto', display: 'block' }}
      />
    </div>
  )
}
