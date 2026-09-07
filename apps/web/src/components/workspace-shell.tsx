import { Suspense } from "react";
import { Workspace } from "./workspace";

/** Every workspace route except "/", which chooses between the welcome page and the workspace. */
export function WorkspaceShell() {
  return (
    <Suspense
      fallback={
        <div className="boot">
          <span className="brand-mark">m</span>
          <span>Opening your workspace…</span>
        </div>
      }
    >
      <Workspace />
    </Suspense>
  );
}
