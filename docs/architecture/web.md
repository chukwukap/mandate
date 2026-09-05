# Web architecture

The Next.js app runs on Node; Bun manages its dependencies and tests. The original
feature folders now own their implementation. `components/workspace.tsx` composes
the shared navigation, feature screens and dialogs. `providers/use-workspace.ts`
coordinates the active route and UI state; domain reads and lifecycle actions live
in their feature hooks.

| Directory | Responsibility |
| --- | --- |
| `src/app` | Explicit Markets, Strategies, strategy detail, Activity, Settings and Welcome routes; root layout. Unknown routes return 404. |
| `src/features/auth` | Privy session, linked-wallet selection, wallet requests, bearer-token transport and stale identity protection. |
| `src/features/market` | Market polling, catalogue display, price chart, stock logos and explicitly isolated preview prices. |
| `src/features/strategies` | List/detail screens, draft construction, exact decimal limit validation, rule/text editor, lifecycle controls and preview strategies. |
| `src/features/permissions` | Prepare, sign, submit, resume, activate and revoke spending permissions. |
| `src/features/executions` | Activity, per-strategy execution/evaluation history, pagination and request cancellation guards. |
| `src/features/onboarding` | Welcome flow, versioned local preferences, first-visit gate and transition into authoring. |
| `src/features/settings` | Account and workspace preferences. |
| `src/components` | Shared workspace composition, native dialog, status indicator and route loading boundary. |
| `src/providers` | Shared in-memory workspace preferences and composition of feature hooks. |
| `src/lib` | HTTP transport and display formatting; no bundled market fixtures or strategy implementation. |
| `src/styles` | Workspace and onboarding styles, responsive rules and reduced-motion behavior. |
| `public/fonts` | Locally served Geist font and license. |
| `test/unit` | Decimal/budget boundaries, authoring payloads, onboarding persistence validation and API request/error behavior. |
| `test/browser` | Repeatable Chromium onboarding, navigation, authoring, lifecycle, responsive and axe checks. |

## Live and preview state

`?preview=1` selects a sample workspace. It never signs or submits strategies or
permissions. Its strategy changes survive client navigation and reset on full reload.
Favorites and density are also session-only. Missing live data never becomes sample
data. Live requests use the current Privy bearer token and selected linked wallet;
responses from a replaced identity are rejected. Feature effects discard old history
requests and clear owned data when their inputs change.

The browser only submits signed strategies after displaying the server-generated
review. Text authoring requires the configured API compiler and can return a
clarification. Price rules work without that compiler. Both paths use explicit caps;
the browser preserves decimal strings and validates budget ordering with integer
micro-USDC arithmetic. The API remains authoritative.

## Routes and restored controls

`/strategies/[id]` exposes a direct strategy URL in addition to quick-view dialogs.
Details include signed review, spending approvals, execution and evaluation history,
pause/start and an explicit permanent-stop confirmation. History exposes pagination,
refresh and actual errors. A stopped strategy cannot restart; stopping does not
revoke an existing spending permission or cancel a transaction already submitted.

## Structure check

Run `bun run check:structure:web` before handing off web work. It fails if any
`.gitkeep` remains. `bun run check:structure` audits the whole rewrite; remaining
non-web placeholders are documented in [the structure audit](../migration/structure-audit.md).
