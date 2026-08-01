import type { ReactNode } from 'react'

export interface OfferCardProps {
  /** Small mono kicker, e.g. "PHASE ONE" or "TRACK 01". */
  kicker?: string
  /** Offer title, rendered in the serif face. */
  title: ReactNode
  /** Who it's for or the cadence, e.g. "4-week fixed-fee sprint". */
  who?: ReactNode
  /** One-line description above the deliverables. */
  description?: ReactNode
  /** Bullet list of deliverables, each shown with an arrow marker. */
  items?: string[]
}

/** A service/offer card with a royal top rule: kicker, serif title, cadence line, and an arrow-marked deliverables list. */
export function OfferCard({ kicker, title, who, description, items }: OfferCardProps) {
  return (
    <div className="bh-track">
      {kicker ? <div className="bh-track__num">{kicker}</div> : null}
      <h3 className="bh-track__title">{title}</h3>
      {who ? <div className="bh-track__who">{who}</div> : null}
      {description ? <p className="bh-track__desc">{description}</p> : null}
      {items ? (
        <ul className="bh-track__list">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
