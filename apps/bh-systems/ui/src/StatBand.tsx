import type { ReactNode } from 'react'
import { Stat } from './Stat'

export interface StatBandProps {
  /** Stat tiles to display. Provide either `items` or `children` of Stat. */
  items?: { value: ReactNode; label: ReactNode }[]
  /** Stat children, if you prefer composing them directly. */
  children?: ReactNode
}

/** A bordered grid of Stat tiles: three per row on desktop, one per row on mobile. */
export function StatBand({ items, children }: StatBandProps) {
  return (
    <div className="bh-stats">
      {items ? items.map((s, i) => <Stat key={i} value={s.value} label={s.label} />) : children}
    </div>
  )
}
