# Mandate demo script and recording guide

**Target length:** 4–5 minutes. Read only the quoted narration aloud, at about 125–140 words per minute. Pause briefly on each screen change. Screen directions and checklists are not narration.

**Recording title:** Mandate — trading strategies for tokenized stocks on Base

**Demo environment:** <https://mandate.up.railway.app>, a live deployment running against an **isolated Base fork with test funds**. Say that plainly on camera. Fork transactions do not appear on the public Base explorer, and claiming otherwise is the one thing that would undermine an otherwise honest demo.

## What this demo has to prove

Mandate is a **strategy platform**, not a scheduled-buy button. Several Base apps already let someone buy a tokenized stock. The thing to show is that a person can author the strategies traders actually run — dollar-cost averaging, martingale scale-ins, basket rebalancing, and a basis trade that only exists onchain — and run them from a wallet they control, inside limits they signed.

If a viewer comes away thinking "recurring purchases", the demo has failed, however polished it looks. Lead with the strategy chooser and the ladder, not with the weekly buy.

## Before you press Record

1. Sign in at <https://mandate.up.railway.app>. Privy creates the embedded wallet that is the strategy account.
2. **Portfolio → Get test USDC.** Do this before recording so you are not filming a loading state.
3. **Run one strategy to a fill in advance.** Create the weekly NVIDIA starter, choose *Buy it for me*, turn on automatic buying, and arm it. It fills in about a minute. You need a completed order to point at in section 5, and nobody should watch you wait.
4. Rehearse section 3 once: New strategy → **Step into Tesla as it falls** → look at the rung table → Review → close without signing. Know where the numbers sit before the take.
5. Confirm **Settings → Automatic buying** is on for your wallet. Leave it on; do not toggle it off just to demonstrate a click.
6. Browser on the external 1080p monitor, window maximised, page zoom 110%. Do Not Disturb on, dock hidden, unrelated tabs closed.
7. Return to **Overview** before starting.

## Spoken script

### 0:00–0:30 — What this actually is

**Screen:** Overview. Cursor still.

> Traders don't just buy and hold. They average in over time, they scale into a dip, they rebalance a basket, they trade a price gap. Running any of that has meant handing API keys to a centralised bot, or doing it by hand at the screen.
>
> Mandate is a strategy platform for Coinbase's tokenized stocks on Base. You author the strategy, you review exactly what it is allowed to spend, you sign it, and it runs from your own wallet.

### 0:30–1:15 — The strategies

**Screen:** New strategy. Rest on the shape chooser and move down the five options as you name them.

> These are the shapes it can run. Buy at a level you pick. Put the same amount in on a schedule. Step in progressively larger the further it falls, which is a martingale-style scale-in. Keep a basket of all seven names at an even weight. Or buy only when the onchain pool is trading below the reference price.
>
> That last one is worth a moment. It compares the Aerodrome pool against the Chainlink reference and buys the gap. It is a strategy that only exists because these are programmable equities — no broker can offer it, because off-chain there are no two prices to compare.

### 1:15–2:15 — Author a real strategy

**Screen:** Choose **Step into Tesla as it falls**. Show steps, step size, multiplier, then the rung table, then the money and expiry fields.

> Let's build one properly. Step into Tesla as it falls: four steps, each one four percent lower and one-point-six times larger than the last.
>
> As I set that, Mandate works out the actual ladder — the price every step triggers at, the size of every buy, and the largest single order. That last number is the one that surprises people about martingale sizing, so it is on screen rather than buried.
>
> Underneath are the limits: the most any single order can spend, the total budget, and the date it stops. That is the entire authority I am granting.

**Screen:** Review.

> Before signing, it reads the rule back in plain language, worst case first, and I can open the exact text I am about to sign. This is a forward projection from today's real prices, not a backtest — there is no price history here to invent one from.

**Action:** Close the builder without signing.

### 2:15–2:50 — The wallet, and staying in control

**Screen:** Settings → Account. Point at the wallet and the Automatic buying switch.

> Every account gets its own wallet. I fund it directly, and purchases leave from it. Nothing is pooled, and nothing is held by us in between.
>
> Automatic buying is a single switch, granted once for the wallet rather than per strategy, and it is revocable right here. Any individual strategy can also be paused on its own. Pausing stops new work; a transaction already submitted can still settle, and the app says so rather than pretending otherwise.

### 2:50–3:40 — Evidence that it runs

**Screen:** Strategies → the completed weekly NVIDIA strategy → Orders & signals. Then Activity.

> The Tesla ladder is waiting for a dip, so it hasn't fired. Here is one that has.
>
> Mandate signed two transactions from my wallet: an approval, then the swap. Fifty dollars of USDC left the wallet and tokenized NVIDIA arrived in it.
>
> The completed order is here, the same event appears in Activity, and every evaluation is recorded — including the checks that decided to do nothing. You should be able to answer what your strategy did, what it spent, and whether it finished.

### 3:40–4:15 — Where the assets are, and close

**Screen:** Portfolio, showing the NVDAc holding and reduced cash.

> And the holding is in the same wallet that paid for it.
>
> That's Mandate: the strategies traders actually run, expressed in language you can read, bounded by limits you sign, and executed from a wallet you keep control of.
>
> It's live at mandate dot up dot railway dot app, with test funds, so you can build one yourself.

## After recording

- Watch it once for anything that overstates the system. This is a fork, executions use test funds, and no claim about mainnet volume or real custody should survive the edit.
- Check that no credential, private key, or environment file appears in any frame.
- Post on X tagging **@buildonbase**, then submit the Builder Quest form.

## If something misbehaves mid-recording

| Symptom | Cause | What to do |
|---|---|---|
| **Get test USDC** does nothing | Wallet already funded above the threshold | Expected. It refuses to top up. Carry on. |
| Strategy says "Automatic buying is off" | Delegation is granted per wallet | Settings → Automatic buying, then reopen the strategy. |
| An armed strategy does not fill | Failure backoff from an earlier attempt | Pause and re-arm; that resets the next check to now. |
| Any action fails with a permission error | `APP_ORIGIN` no longer matches the domain | The API and worker must both carry the exact origin the browser uses. |
