"use client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type OnboardingPreferences, onboardingKey, parseOnboarding } from "./state";

type State = {
  ready: boolean;
  preferences: OnboardingPreferences | null;
  finish(value: Omit<OnboardingPreferences, "version">): void;
};
const Context = createContext<State | null>(null);
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [preferences, setPreferences] = useState<OnboardingPreferences | null>(null);
  useEffect(() => {
    try {
      setPreferences(parseOnboarding(localStorage.getItem(onboardingKey)));
    } catch {
      /* Storage can be disabled; onboarding remains usable. */
    }
    setReady(true);
  }, []);
  return (
    <Context.Provider
      value={{
        ready,
        preferences,
        finish(value) {
          const next = { ...value, version: 1 as const };
          setPreferences(next);
          try {
            localStorage.setItem(onboardingKey, JSON.stringify(next));
          } catch {
            /* Keep the current session usable. */
          }
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useOnboarding() {
  const state = useContext(Context);
  if (!state) throw new Error("Missing onboarding provider");
  return state;
}
