import type { ReactNode } from 'react';

export interface SurfaceProps {
  /** Content rendered on the navy canvas. */
  children: ReactNode;
  /** Add comfortable padding around the content. Defaults to true. */
  padded?: boolean;
}

/**
 * The bh-systems canvas: navy background, base tokens, and the faint
 * blueprint texture. Wrap any composition in Surface to get the theme.
 */
export function Surface({ children, padded = true }: SurfaceProps) {
  return <div className={`bh-surface${padded ? ' bh-surface--padded' : ''}`}>{children}</div>;
}
