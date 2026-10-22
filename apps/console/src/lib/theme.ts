import { useCallback, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "evs.console.theme";

/** Dark by default; the choice persists. index.html applies it before first paint. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [theme, toggle];
}
