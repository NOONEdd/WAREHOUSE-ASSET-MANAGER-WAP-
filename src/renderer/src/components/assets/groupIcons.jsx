import { IdcardOutlined, EnvironmentOutlined, CalendarOutlined, TeamOutlined, TagOutlined, ClockCircleOutlined } from '@ant-design/icons'

// Phase 9 — one small icon per field group (assetFieldGroups.js's
// iconKey), all meant to render in the same accent color rather than a
// different hue per section — a consistent "this is a section marker"
// cue instead of an arbitrary rainbow. Kept as its own module (rather
// than inline in assetFieldGroups.js) so that file stays plain data,
// importable without pulling React/JSX into it.
export const GROUP_ICONS = {
  identity: <IdcardOutlined />,
  location: <EnvironmentOutlined />,
  dates: <CalendarOutlined />,
  handover: <TeamOutlined />,
  status: <TagOutlined />,
  system: <ClockCircleOutlined />
}
