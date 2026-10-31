import { Typography } from 'antd'

const { Title, Text } = Typography

/**
 * Phase 9 — every page used to either invent its own ad hoc title (a
 * lone <Title level={5}>, styled slightly differently per page) or have
 * no title at all and jump straight into a button row (Dashboard,
 * Assets, Reports, Audit Log, Settings) — one of the clearest "default
 * Ant Design demo" tells, and the biggest single hierarchy gap called
 * out for this phase: page title, description, and actions had no
 * consistent relationship to each other anywhere in the app.
 *
 * `actions` is a slot (usually a <Space> of Buttons) right-aligned in
 * LTR / start-aligned in RTL — i.e. it sits over on the reading-start
 * side, opposite the title, which is exactly where the existing pages
 * already put their action buttons, so this doesn't relocate anything
 * users are used to reaching for.
 */
export default function PageHeader({ title, description, actions }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 16,
        marginBottom: 20
      }}
    >
      <div>
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        {description && (
          <Text type="secondary" style={{ fontSize: 13 }}>
            {description}
          </Text>
        )}
      </div>
      {/* May shrink and wrap (the actions are a wrapping <Space>): on a
          phone the asset list's eight actions would otherwise push the
          page ~350px past the screen edge. */}
      {actions && <div style={{ minWidth: 0, maxWidth: '100%' }}>{actions}</div>}
    </div>
  )
}
