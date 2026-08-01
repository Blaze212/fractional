import type { ReactNode } from 'react'

export interface StatProps {
  /** The headline figure, e.g. "99.9%+". Rendered in the serif display face. */
  value: ReactNode
  /** Supporting label under the figure. */
  label: ReactNode
}

/** A single metric tile: a large serif figure over a muted label. Use inside StatBand. */
export function Stat({ value, label }: StatProps) {
  return (
    <div className="bh-stat">
      <div className="bh-stat__num">{value}</div>
      <div className="bh-stat__label">{label}</div>
    </div>
  )
}
