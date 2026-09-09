# Browser flows

End-to-end runs of the web app as a person uses it: a real headless Chromium, the real Privy
login, a wallet injected into the page (EIP-1193 + EIP-6963) that signs in Node, and assertions
on three things at once — what the screen shows, what the database holds, and what the API
answered.

## What has to be running

The local fork stack (see `scripts/dev/fork-up.sh`): anvil on `:8545`, the API on `:8081` with
`.env.fork`, the worker with `.env.worker.fork`, Postgres with the `mandate_fork` database, and the
web app on `http://localhost:3000` pointed at the fork API. Drive the browser at **localhost**, not
`127.0.0.1`: Next's dev server refuses cross-origin dev resources and the page never hydrates.

## Running

```sh
SHOT=/tmp/shots node apps/web/test/browser/flows-01-shell.mjs      # login, navigation, menus, prefs
SHOT=/tmp/shots node apps/web/test/browser/flows-02-create.mjs     # every strategy shape, validation, review, signing
SHOT=/tmp/shots node apps/web/test/browser/flows-03-lifecycle.mjs  # arm → worker evaluates → signal → pause → stop
SHOT=/tmp/shots node apps/web/test/browser/flows-04-security.mjs   # auth, origin, replay, tenants, rate limit, worker outage
```

Each prints one line per check and exits non-zero on any failure; a failing check saves a
screenshot under `$SHOT`. Run them one at a time: the security suite restarts the worker and
deliberately trips a rate limit, which would show up as failures in a suite running beside it.

The suites create strategies for the test wallet on every run and never delete them, so the
fork database accumulates rows. Lookups by name therefore stamp each run's strategies with a
unique name.

## Wallets

`lib/session.mjs` holds anvil's public default keys #1 (the "user") and the security suite uses
key #2 as a second tenant. They exist on the fork only; nothing here touches a real wallet.
