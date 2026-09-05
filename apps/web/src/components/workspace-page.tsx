import { Suspense } from "react";
import { OnboardingGate } from "../features/onboarding/onboarding-gate";
import { Workspace } from "./workspace";

export function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="boot">
          <span className="brand-mark">m</span>
          <span>Opening your workspace…</span>
        </div>
      }
    >
      <OnboardingGate>
        <Workspace />
      </OnboardingGate>
    </Suspense>
  );
}
