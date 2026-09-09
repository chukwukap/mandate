"use client";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ThemePreference, useTheme } from "../../providers/theme-provider";

const choices = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;
export function ThemeChoices() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-choices">
      {choices.map(({ value, label, icon: Icon }) => (
        <button
          type="button"
          key={value}
          className={theme === value ? "selected" : ""}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
        >
          <span className={`theme-mini theme-mini-${value}`}>
            <i />
            <b />
            <em />
          </span>
          <span>
            <Icon size={14} />
            {label}
            {theme === value && <Check size={13} />}
          </span>
        </button>
      ))}
    </div>
  );
}
export function ThemeControl() {
  const { theme, resolved, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        ref.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);
  return (
    <div className="theme-control" ref={ref}>
      <button
        type="button"
        className="desk-icon-button"
        aria-label="Change theme"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {resolved === "dark" ? <Moon size={18} /> : <Sun size={18} />}
      </button>
      {open && (
        <div className="theme-menu">
          {choices.map(({ value, label, icon: Icon }) => (
            <button
              type="button"
              key={value}
              onClick={() => {
                setTheme(value as ThemePreference);
                setOpen(false);
              }}
            >
              <Icon size={15} />
              {label} theme{theme === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
