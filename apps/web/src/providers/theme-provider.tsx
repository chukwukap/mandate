"use client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
export type ThemePreference = "light" | "dark" | "system";
export function validTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
const Context = createContext<{
  theme: ThemePreference;
  resolved: "light" | "dark";
  setTheme(value: ThemePreference): void;
}>({ theme: "system", resolved: "light", setTheme: () => {} });
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setTheme(validTheme(localStorage.getItem("mandate:theme")));
    } catch {
      /* Use the device theme when storage is unavailable. */
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const actual = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = actual;
      document.documentElement.style.colorScheme = actual;
      setResolved(actual);
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("mandate:theme", theme);
    } catch {
      /* The active session still changes theme. */
    }
    return () => media.removeEventListener("change", apply);
  }, [theme, ready]);
  return <Context.Provider value={{ theme, resolved, setTheme }}>{children}</Context.Provider>;
}
export const useTheme = () => useContext(Context);
