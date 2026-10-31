import type { Config } from 'tailwindcss';

// Hope Kitchen's colours (the Mac app's): warm paper by day, charcoal by night, saffron the one accent,
// green = in, tomato = out. Tokens live in globals.css; classes here only name them.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)', surface: 'rgb(var(--surface) / <alpha-value>)', surface2: 'rgb(var(--surface-2) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)', ink: 'rgb(var(--ink) / <alpha-value>)', muted: 'rgb(var(--muted) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)', inc: 'rgb(var(--in) / <alpha-value>)', out: 'rgb(var(--out) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)', info: 'rgb(var(--info) / <alpha-value>)',
      },
      fontFamily: { mono: ['ui-monospace', 'SF Mono', 'Menlo', 'monospace'] },
    },
  },
  plugins: [],
};
export default config;
