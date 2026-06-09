import type { Config } from 'tailwindcss'

export default {
  content: ['./app/web/index.html', './app/web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        star: '#ffb454',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
        sans: ['Geist', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config
