import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'var(--color-brand)',
          light: 'var(--color-brand-light)',
          secondary: 'var(--color-brand-secondary)',
          muted: 'var(--color-brand-muted)',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
