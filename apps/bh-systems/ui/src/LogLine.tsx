import type { ReactNode } from 'react'

export interface LogLineProps {
  /** Short status tag shown in ice, e.g. "warn", "stuck", "wait". */
  tag: string
  /** The log message. */
  children: ReactNode
}

/** One line inside a LogPanel: a colored status tag followed by a monospace message. */
export function LogLine({ tag, children }: LogLineProps) {
  return (
    <div className="bh-obs">
      <span className="bh-obs__tag">{tag}</span>
      <span>{children}</span>
    </div>
  )
}
