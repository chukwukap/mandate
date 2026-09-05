# Web design and verification

## Direction

Warm off-white canvas, charcoal-green sidebar, white surfaces and restrained green
for active controls. Geist is served locally under its included OFL license.
Markets prioritize company, price and the next action. Strategy details disclose
budgets and signed content on demand; authoring separates input from final review.

The layout includes Markets, Strategies, Activity and Settings. Desktop uses a
persistent sidebar; smaller screens use a drawer and contained table scrolling.
Search supports Cmd/Ctrl+K. Native dialogs support keyboard focus and Escape.
Watchlist changes, card selection, chart inspection, button presses and success
notifications provide feedback. Reduced-motion preferences suppress transitions.

## State and integration

`src/providers/workspace-state.tsx` owns session-only preview strategies, favorites
and density preferences. Preview requires `?preview=1` and never submits API writes,
signatures or transactions. Live mode uses the API proxy and Privy session, clears
owned records on identity changes, and rejects stale wallet-scoped responses.
The UI never fills missing live prices with fixtures.

The domain directories own their views and data hooks; see [web architecture](../architecture/web.md).
[Onboarding](onboarding.md) introduces the product and carries user choices into authoring.

`StrategyEditor` requests and displays a server-generated review before signing.
`SpendingPermission` prepares, signs, submits, activates and revokes permissions;
activation depends on API-confirmed chain state. Signed approvals can be resumed
if the initial wallet submission was cancelled. Requested automatic mode is
returned separately from the instance's current mode by the API.

## Verification — September 5, 2026

Repeatable tests live in `apps/web/test/unit` and `apps/web/test/browser`.
Browser checks use local Chromium with an unconfigured Privy app and explicit
preview data. Covered strategy creation across navigation, detail/pause controls,
command search, mobile Settings navigation and mobile document overflow. Desktop
and mobile screenshots were inspected. No browser runtime errors were observed.
Automated axe checks cover onboarding, the four preview routes, strategy details and authoring; these
supplement visual inspection and do not establish complete accessibility compliance.

Root TypeScript, Biome and the production Next build are checked. The API regression
suite includes resumed approval payloads and requested automatic mode. No funded
transactions were sent. Real Privy login, smart-wallet approval and worker execution
were not exercised through the browser. Historical prices and aggregate live 24h
changes remain unavailable; the live interface says so.
