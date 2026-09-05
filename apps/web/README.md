# Mandate web

A warm, minimal trading workspace: light canvas, dark navigation, restrained green
accents, local Geist typography and small, purposeful transitions.

## Run

From `mandate-node/`:

```sh
bun install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
bun run dev:web
```

Open `/welcome` for the three-step onboarding flow. A first live visit to `/` opens
it automatically. Stock and execution preferences carry into the editor; skipping
or finishing is remembered locally.

Open [the preview](http://localhost:3000/?preview=1) to explore Markets, Strategies,
Activity and Settings without credentials. Create a strategy, review it, save it,
pause it, search stocks with Cmd/Ctrl+K, or build a watchlist. Preview changes and
workspace preferences survive client navigation and reset on a full reload.
Sample prices, history and activity are explicitly marked as preview data.

## Connect the API and Privy

Set `NEXT_PUBLIC_PRIVY_APP_ID` in `apps/web/.env.local` to the same app used by the
API. Configure the web origin in Privy and the API's allowed origins; use
`http://localhost:3000` consistently (or `http://127.0.0.1:3000` consistently).
Enable your selected login methods in Privy. Keep `PRIVY_APP_SECRET` in the API
only. `MANDATE_API_URL` points the server-side proxy at the API.
Restart Next after changing these values. Public configuration is embedded at build time.

Follow [API setup](../../docs/runbooks/api-local.md), run the API, then open `/`
without the preview query. The client uses Privy access tokens and the selected
linked wallet. It displays API errors and unavailable prices without substituting
sample data.

A real strategy requires a server-generated review and a signature over its exact
confirmation message. It starts paused in manual mode. Automatic mode additionally
requires the spending-permission flow, a compatible smart wallet, confirmed onchain
approval and explicit activation. The worker must be configured separately.
The approval UI exposes allowance, expiry and spender before requesting a signature.

## Build and verify

```sh
bun run check:structure:web
bun run test:web
bun run typecheck
bun run lint
bun run build:web
bun run start:web
```

Next runs on Node.js; Bun manages dependencies and commands. Styling is plain CSS,
with shared components and local SVG charts. Motion respects reduced-motion settings.

With the dev server running, run `bun run test:web:browser` for the committed
Chromium/axe suite. Install Chromium once with `bunx playwright install chromium`
from this directory, or supply `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an existing
installation. `MANDATE_WEB_URL` defaults to `http://127.0.0.1:3000`.
Screenshots are written to ignored `apps/web/test-results/`.

See [module ownership](../../docs/architecture/web.md),
[onboarding design](../../docs/product/onboarding.md), and [design and verification notes](../../docs/product/web-design.md).
Live price history is not yet provided by the API; only preview charts render.
The editor supports single-stock price rules and natural-language authoring through
the API compiler, with editable daily budget, order count, cooldown and slippage.
Details include execution/evaluation history and a permanent-stop control.
Immediate swaps, automatic sells and operator recovery are not exposed by this UI.
Privy login and funded smart-wallet execution still require end-to-end validation
with the project's configured credentials and wallet.
