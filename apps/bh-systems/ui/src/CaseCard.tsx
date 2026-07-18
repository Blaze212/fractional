import type { ReactNode } from 'react';

export interface CaseCardProps {
  /** Company or project name, rendered in the serif face. */
  company: ReactNode;
  /** Small uppercase tag, e.g. "AI · Fractional". */
  kind?: ReactNode;
  /** The narrative description of the work. */
  children: ReactNode;
  /** A single outcome line; wrap key figures in <b> for the ice highlight. */
  outcome?: ReactNode;
}

/** A portfolio case card: serif company name, a tag, a short narrative, and one highlighted outcome line. */
export function CaseCard({ company, kind, children, outcome }: CaseCardProps) {
  return (
    <div className="bh-case">
      <div className="bh-case__top">
        <span className="bh-case__co">{company}</span>
        {kind ? <span className="bh-case__kind">{kind}</span> : null}
      </div>
      <p className="bh-case__body">{children}</p>
      {outcome ? <p className="bh-case__outcome">{outcome}</p> : null}
    </div>
  );
}
