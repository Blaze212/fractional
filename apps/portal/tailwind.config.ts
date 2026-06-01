import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1a3a5c',
          light: '#2d5986',
          muted: '#e8f0f8',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
