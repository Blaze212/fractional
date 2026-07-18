import type { ReactNode } from 'react';

export interface ButtonProps {
  /** Visual style. `primary` is the royal-blue fill; `ghost` is outlined. */
  variant?: 'primary' | 'ghost';
  /** Button label. */
  children: ReactNode;
  /** If set, renders an anchor to this URL instead of a button. */
  href?: string;
  /** Show a trailing arrow that nudges right on hover. */
  arrow?: boolean;
  /** Open the href in a new tab (only applies with `href`). */
  external?: boolean;
  /** Click handler (button mode). */
  onClick?: () => void;
}

/** Primary call-to-action in the bh-systems style: royal-blue fill or outlined ghost, mono label, optional arrow. */
export function Button({ variant = 'primary', children, href, arrow, external, onClick }: ButtonProps) {
  const className = `bh-btn bh-btn--${variant}`;
  const content = (
    <>
      {children}
      {arrow ? <span className="bh-btn__arrow" aria-hidden="true">→</span> : null}
    </>
  );
  if (href) {
    const linkProps = external ? { target: '_blank', rel: 'noopener' } : {};
    return (
      <a className={className} href={href} {...linkProps}>
        {content}
      </a>
    );
  }
  return (
    <button className={className} type="button" onClick={onClick}>
      {content}
    </button>
  );
}
