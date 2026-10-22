import type { Config } from "tailwindcss";

// Colors resolve to CSS variables (see src/index.css) so one class set serves
// both the dark (default) and light themes.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        raised: v("raised"),
        line: v("line"),
        fg: v("fg"),
        muted: v("muted"),
        faint: v("faint"),
        accent: v("accent"),
        ok: v("ok"),
        warn: v("warn"),
        bad: v("bad"),
        info: v("info"),
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: { "2xs": ["11px", "16px"] },
    },
  },
  plugins: [],
} satisfies Config;
