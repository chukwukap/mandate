"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useOnboarding } from "./onboarding-provider";
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { ready, preferences } = useOnboarding();
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const needsWelcome = path === "/" && params.get("preview") !== "1" && !preferences;
  useEffect(() => {
    if (ready && needsWelcome) router.replace("/welcome");
  }, [ready, needsWelcome, router]);
  if (!ready || needsWelcome)
    return (
      <div className="boot" role="status">
        Opening your workspace…
      </div>
    );
  return children;
}
