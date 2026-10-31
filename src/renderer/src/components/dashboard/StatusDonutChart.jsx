import { PieChart, Pie, Cell, Legend, Tooltip, ResponsiveContainer } from 'recharts'
import { Empty } from 'antd'
import { InboxOutlined, ExportOutlined, RollbackOutlined, WarningOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { statusColors } from '../../theme'
import { formatPersianNumber } from '../../utils/numberFormat'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

// One icon per official status, keyed by name exactly like statusColors —
// تعمیر has no entry since it was dropped from the canonical set (see
// lookupService.js's CANONICAL_STATUS_NAMES comment); an unrecognized
// name (a legacy status someone hasn't cleaned up yet) just renders with
// no icon rather than a guessed one, same as statusColors' fallback.
const STATUS_ICONS = {
  'در انبار': InboxOutlined,
  'صادر شده': ExportOutlined,
  'مرجوع شده': RollbackOutlined,
  'آسیب‌دیده': WarningOutlined,
  مفقود: QuestionCircleOutlined
}

/**
 * The Dashboard's status-breakdown chart — a donut rather than a bar chart
 * on purpose: the stat cards above already give exact counts, so this is
 * about proportion at a glance, which a part-of-a-whole shape communicates
 * better than bars. Same status colors as StatusBadge, so the chart
 * and every table/detail view read as one consistent system.
 */
export default function StatusDonutChart({ byStatus, total }) {
  // recharts draws the ring in with a JavaScript animation (~1.5 s) that
  // the CSS reduced-motion rules cannot reach. recharts 3 already skips it
  // under the system setting by default ('auto'); stated here so it does
  // not depend on that library default.
  const reducedMotion = usePrefersReducedMotion()
  if (!total) {
    return (
      <Empty
        description="با ثبت اولین دارایی، نمودار اینجا نمایش داده می‌شود"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    )
  }

  const data = (byStatus || [])
    .filter((s) => s.n > 0)
    .map((s) => ({ name: s.status, value: s.n }))

  return (
    <div style={{ position: 'relative', height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={55}
            outerRadius={80}
            paddingAngle={2}
            stroke="none"
            isAnimationActive={!reducedMotion}
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={statusColors[entry.name] || '#6b6560'} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, name) => [formatPersianNumber(value), name]}
            contentStyle={{ fontFamily: 'Vazirmatn, Tahoma, sans-serif', direction: 'rtl' }}
          />
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            wrapperStyle={{ fontSize: 12, direction: 'rtl' }}
            // Recharts colors legend text to match each slice by default
            // (entry.color) — fine for the swatch, but some of the
            // status colors fall below readable contrast once the
            // surrounding card is genuinely dark (see theme.js/dark-mode
            // notes). labelStyle's color takes precedence over that
            // per-entry color, so the swatch stays each status's true
            // color while the label text stays the normal, always-legible
            // theme text color.
            labelStyle={{ color: 'var(--awm-text)' }}
            // Icon rides inside the same labelStyle-colored span as the
            // text (formatter's return value is what labelStyle colors),
            // so it inherits that same always-legible color via
            // currentColor rather than needing its own per-status color
            // that could hit the same dark-mode contrast problem the
            // comment above exists to avoid.
            formatter={(value) => {
              const Icon = STATUS_ICONS[value]
              return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {Icon && <Icon />}
                  {value}
                </span>
              )
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          pointerEvents: 'none'
        }}
      >
        <div className="awm-mono" style={{ fontSize: 22, fontWeight: 600 }}>
          {formatPersianNumber(total)}
        </div>
        <div style={{ fontSize: 11, color: 'var(--awm-text-secondary)' }}>کل دارایی‌ها</div>
      </div>
    </div>
  )
}
