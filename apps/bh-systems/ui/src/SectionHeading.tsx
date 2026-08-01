import type { ReactNode } from 'react'
import { Eyebrow } from './Eyebrow'

export interface SectionHeadingProps {
  /** Uppercase eyebrow above the title. */
  eyebrow?: ReactNode
  /** The heading, rendered in the serif display face. */
  title: ReactNode
  /** Optional supporting paragraph. */
  description?: ReactNode
  /** Center all three (used for the closing call-to-action). */
  centered?: boolean
}

/** A section header block: eyebrow, serif title, and an optional description paragraph. */
export function SectionHeading({ eyebrow, title, description, centered }: SectionHeadingProps) {
  return (
    <div
      className="bh-sechead"
      style={centered ? { textAlign: 'center', margin: '0 auto' } : undefined}
    >
      {eyebrow ? <Eyebrow centered={centered}>{eyebrow}</Eyebrow> : null}
      <h2 className="bh-sechead__title">{title}</h2>
      {description ? <p className="bh-sechead__desc">{description}</p> : null}
    </div>
  )
}
