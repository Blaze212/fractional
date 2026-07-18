import type { ReactNode } from 'react';

export interface CrossLinkProps {
  /** Small uppercase lead-in, often a question. */
  lead?: ReactNode;
  /** The main serif line. */
  headline: ReactNode;
  /** Call-to-action label at the right, e.g. "For creators →". */
  cta: ReactNode;
  /** Destination URL. */
  href: string;
}

/** A full-width banner linking to another page or audience: lead-in, serif headline, right-aligned CTA, with an ice left rule. */
export function CrossLink({ lead, headline, cta, href }: CrossLinkProps) {
  return (
    <div className="bh-crosslink">
      <a href={href}>
        <div>
          {lead ? <div className="bh-crosslink__lead">{lead}</div> : null}
          <div className="bh-crosslink__big">{headline}</div>
        </div>
        <span className="bh-crosslink__go">{cta}</span>
      </a>
    </div>
  );
}
