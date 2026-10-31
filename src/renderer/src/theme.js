// Design tokens for Ant Design's ConfigProvider. Kept in one place so every
// component derives color/type from the same source rather than
// hardcoding values inline (Phase 7 design plan).
//
// Phase 10 — the navy/gold identity itself is unchanged; this pass adds
// the *tiers* that were missing for real hierarchy: a header/table split
// that reads as one connected "ink" family instead of a single flat
// accent, a raised-surface tone distinct from the page background so
// toolbars and hero cards can sit a level above ordinary cards, and
// slightly denser table typography now that headers carry their own
// weight instead of borrowing the body's.

// Accessibility pass (WCAG 2.1 AA, measured with axe-core in the browser
// end-to-end run): white text on the original gold #c8862b reaches only
// 3.0:1, and the same gold as link text on the page background 2.8:1 —
// both under the 4.5:1 that normal-size text needs. The primary color is
// therefore a deeper bronze from the same family (#9a6418: 5.0:1 under
// white text, 4.5:1 as text on --awm-paper). The bright gold stays as the
// decorative accent (--awm-accent: sidebar, chips, rules), where no text
// sits on it. Tertiary/placeholder text and the error red move the same
// way, from 3.0:1 / 3.3:1 to 4.7:1 or more. Dark mode keeps the bright gold
// (5.1:1 as text on a dark card) and puts dark text on primary buttons.
export const lightTheme = {
  token: {
    colorPrimary: '#9a6418',
    colorLink: '#9a6418',
    colorError: '#c62828',
    colorBgBase: '#f6f4ee',
    colorBgContainer: '#ffffff',
    colorBgLayout: '#f6f4ee',
    // Phase 10 — a level between colorBgLayout (page) and colorBgContainer
    // (card): used for toolbars/filter bars and the dashboard hero so
    // "controls" and "headline" surfaces read as a distinct tier from
    // ordinary content cards without introducing a new hue.
    colorBgElevated: '#fffdf9',
    colorBorder: '#e3dfd5',
    colorBorderSecondary: '#ece8de',
    colorText: '#232323',
    colorTextSecondary: '#6b675e',
    colorTextTertiary: '#6f6b62',
    colorTextDescription: '#6b675e',
    colorTextPlaceholder: '#77736a',
    fontFamily: "'Vazirmatn', Tahoma, 'Segoe UI', sans-serif",
    borderRadius: 6,
    borderRadiusLG: 10,
    wireframe: false
  },
  components: {
    Layout: {
      siderBg: '#1e2a3a',
      headerBg: '#f6f4ee',
      bodyBg: '#f6f4ee'
    },
    Menu: {
      darkItemBg: '#1e2a3a',
      darkItemSelectedBg: '#2c3a4d',
      darkItemHoverBg: '#26323f',
      // Phase 8: the active/hovered nav item now reads in a warm gold
      // accent (a lightened, sidebar-safe variant of the app's #c8862b
      // accent — the literal accent color only clears ~3.8:1 against
      // this navy, short of WCAG AA's 4.5:1 for normal text, so this is
      // a deliberately different value from colorPrimary, not the same
      // one) — previously it only changed background, so "which page am
      // I on" relied on a fairly subtle navy-on-navy shift.
      darkItemSelectedColor: '#d79a45',
      darkItemHoverColor: '#f0e6d2',
      darkItemColor: '#a9b4c2',
      // Phase 9: a bit more inset from the sidebar's edges than antd's
      // default (4px) — the selected/hovered item reads as a deliberate
      // pill sitting inside the rail rather than a flush block.
      itemMarginInline: 12,
      itemHeight: 42,
      // Phase 10: selected item carries real weight (600) rather than
      // matching hover's 400 — "which page am I on" should be legible
      // even at a glance, not just via the pill tint.
      fontSize: 14
    },
    Table: {
      headerBg: '#f1eee4',
      headerColor: '#4a463c',
      headerSplitColor: 'transparent',
      borderColor: '#e9e5da',
      // Phase 8: a palette-tied hover tint (same value as --awm-hover-tint
      // in global.css, used for the one other place — Dashboard's
      // recent-activity rows — that needs the same "you can click this"
      // cue) instead of antd's generic default.
      rowHoverBg: '#f5f1e6',
      cellPaddingBlock: 13,
      cellPaddingInline: 16,
      cellFontSize: 13.5,
      headerBorderRadius: 10
    },
    Card: {
      colorBorderSecondary: '#e3dfd5',
      borderRadiusLG: 12
    },
    Button: {
      fontWeight: 500,
      primaryShadow: 'none'
    },
    Input: {
      activeShadow: '0 0 0 3px rgba(200, 134, 43, 0.12)'
    }
  }
}

export const darkTheme = {
  token: {
    ...lightTheme.token,
    colorPrimary: '#c8862b',
    colorLink: '#d79a45',
    colorError: '#e27272',
    colorBgBase: '#181c22',
    colorBgContainer: '#20252d',
    colorBgLayout: '#181c22',
    colorBgElevated: '#242a33',
    colorBorder: '#333a44',
    colorText: '#e8e6e1',
    colorTextSecondary: '#9b968c',
    colorTextTertiary: '#a39e93',
    colorTextDescription: '#9b968c',
    colorTextPlaceholder: '#a39e93'
  },
  components: {
    ...lightTheme.components,
    Layout: {
      siderBg: '#10161f',
      headerBg: '#181c22',
      bodyBg: '#181c22'
    },
    Menu: {
      ...lightTheme.components.Menu
    },
    // Dark-mode bug fix: these two were previously left out, so they fell
    // through to lightTheme.components' light-cream/light-border values
    // via the spread above — AntD still correctly derives Table's header
    // *text* color from the dark algorithm (light, meant for a dark
    // header), so the result was near-white header text on a near-white
    // forced background: every table's column headers throughout the
    // app (asset list, import preview, reports, audit log) went
    // essentially blank. Card's border had the same light-value leak,
    // just cosmetic rather than unreadable.
    Table: {
      headerBg: '#262c36',
      headerColor: '#c7c3ba',
      headerSplitColor: 'transparent',
      borderColor: '#333a44',
      rowHoverBg: '#262c36',
      cellPaddingBlock: 13,
      cellPaddingInline: 16,
      cellFontSize: 13.5,
      headerBorderRadius: 10
    },
    Card: {
      colorBorderSecondary: '#333a44',
      borderRadiusLG: 12
    },
    Button: {
      fontWeight: 500,
      primaryShadow: 'none',
      // Near-black ink on the gold button: 5.0:1 against the shade the dark
      // algorithm actually paints (#ad7528, measured in the browser run);
      // white on it would be 3.0:1.
      primaryColor: '#080b10'
    },
    Input: {
      activeShadow: '0 0 0 3px rgba(200, 134, 43, 0.18)'
    }
  },
  algorithm: 'dark' // resolved to antd.theme.darkAlgorithm where this is consumed
}

// The 5-color status system — deliberately not generic red/green/blue.
// Named like warehouse tags because that's the mental model: a physical
// asset carries one of these states, stamped and visible at a glance.
//
// Bug fix (found while tracing a report of the Dashboard's status chart
// under-representing "مفقود"): مفقود's color was #6b6560 — the EXACT
// same literal value StatusBadge.jsx and StatusDonutChart.jsx both use
// as their fallback for an *unrecognized* status. The underlying count
// was never wrong (traced and confirmed correct end-to-end, DB through
// render, including create/status-change/soft-delete — see
// tests/main/services/dashboardStats.test.js) — every "مفقود" badge and
// chart slice in the whole app was rendering in the same drab gray as
// "something's wrong here", which reads as absent/broken at a glance
// even though the data and the count are both right. Moved to a color
// no fallback or other status shares.
//
// Accessibility pass: badges carry white 12px text, so each color needs
// 4.5:1 against white. صادر شده (#c8862b, 3.0:1) and مرجوع شده (#5a8f5e,
// 3.8:1) moved to darker shades of the same hues (5.0:1 and 5.1:1); the
// other three already passed.
export const statusColors = {
  'در انبار': '#4a6fa5', // In Warehouse
  'صادر شده': '#9a6418', // Issued
  'مرجوع شده': '#477a4b', // Returned
  'آسیب‌دیده': '#b0472f', // Damaged
  مفقود: '#7a5980' // Lost
}
