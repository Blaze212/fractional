import type { ReactNode } from 'react'

export interface LogPanelProps {
  /** Filename-style label in the panel bar, e.g. "production.log". */
  label?: string
  /** Panel content: paragraphs and LogLine rows. */
  children: ReactNode
}

/** A terminal-style panel with a labeled bar and a royal left rule. Holds narrative copy and LogLine rows. */
export function LogPanel({ label, children }: LogPanelProps) {
  return (
    <div className="bh-panel">
      {label ? (
        <div className="bh-panel__bar">
          <span className="bh-panel__label">{label}</span>
        </div>
      ) : null}
      <div className="bh-panel__body">{children}</div>
    </div>
  )
}
