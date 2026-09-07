"use client";
import { Suspense } from "react";
import { useSession } from "../features/auth/session-provider";
import { OnboardingView } from "../features/onboarding/onboarding-view";
import { Workspace } from "./workspace";

/**
 * "/" is the welcome page until you log in, and your workspace after.
 *
 * It used to branch on a localStorage onboarding flag instead of on the session, so anyone who
 * had once pressed "Skip for now" got the workspace forever after — signed out, looking at
 * "Not connected", an empty portfolio and three counters at zero. Whether somebody has seen a
 * tour is not the same question as whether they are logged in, and only the second one decides
 * whether there is a workspace to show.
 *
 * `session.ready` is checked first because Privy resolves an existing session asynchronously;
 * rendering on `authenticated` alone would flash the welcome page at a logged-in user on every
 * reload.
 */
function Root() {
  const session = useSession();
  if (!session.ready)
    return (
      <div className="boot">
        <span className="brand-mark">m</span>
        <span>Opening your workspace…</span>
      </div>
    );
  return session.authenticated ? <Workspace /> : <OnboardingView />;
}

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
      <Root />
    </Suspense>
  );
}
