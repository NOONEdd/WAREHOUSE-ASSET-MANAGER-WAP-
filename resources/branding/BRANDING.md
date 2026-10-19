# Company Branding Specification

Primary source asset: `resources/branding/sfz-banner.png` — a higher-quality
version the client provided (2172×724px, aspect ratio 3.0:1), superseding
the original `sfz-banner.jpg` (3000×456px, 6.58:1, kept in the folder for
reference but no longer the primary reference). This is the one to use for
PDF/Excel — full resolution, no re-encoding.

## Main application — ✅ implemented (Phase 7, updated Phase 8)

Uses `sfz-banner.png` directly (`CompanyBanner.jsx`) — the same file behind
the PDF/Excel spec below, so the app and every export show the identical
banner rather than a code approximation that could drift from it over time.
An earlier SVG/CSS recreation was tried first; superseded once a
higher-quality source image made the real file the better choice.

- Full-width row directly below the header toolbar, wired into `AppShell.jsx`
  between `Header` and `Content`
- Spans the full width of the main content area (not the sidebar)
- Scales via `width: 100%; height: auto` — original 3:1 aspect ratio
  preserved, never stretched or distorted
- Appears on every page, not just Dashboard
- Also used on the Login screen, sized to fit the centered card

## PDF export — ⏳ not yet buildable (Phase 14)

There is no export code yet — Phases 8–13 haven't been built. Captured here
precisely so the spec isn't lost by the time we get there:

- Banner at the very top of **every** exported page (not just the first)
- Full printable page width, original aspect ratio, no distortion
- Highest resolution the source affords
- Must clearly identify the report as belonging to **Sanat Farabar Zarin Co.**

## Excel export — ⏳ not yet buildable (Phase 14)

- Banner inserted at the top of the worksheet, spanning the header area —
  as a real embedded image sized to the sheet, not a small floating picture
- Proportional scaling, maximum quality
- Appropriate spacing between the banner and where the data table begins
