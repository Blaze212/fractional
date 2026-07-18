import type { ReactNode } from 'react';

export interface EyebrowProps {
  /** Label text, rendered uppercase in mono with a leading rule. */
  children: ReactNode;
  /** Center the eyebrow (used above centered section headings). */
  centered?: boolean;
}

/** Small uppercase mono label with a leading rule. Sits above headlines and section titles. */
export function Eyebrow({ children, centered }: EyebrowProps) {
  return (
    <span className="bh-eyebrow" style={centered ? { justifyContent: 'center' } : undefined}>
      {children}
    </span>
  );
}
