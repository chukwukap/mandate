# Mandate demo script and recording guide

**Target length:** 4–5 minutes. Read only the quoted narration aloud, at about 125–140 words per minute. Pause briefly on each screen change. Screen directions and checklists are not narration.

**Recording title:** Mandate — automated tokenized-stock strategies on Base

**Demo environment:** <https://mandate.up.railway.app>

This is a live deployment anyone can open, running against an **isolated Base fork with test funds**. Say that plainly on camera. Fork transactions will not appear on the public Base explorer, and claiming otherwise is the one thing that would undermine an otherwise honest demo.

Because it is live and self-serve, a judge can follow the same path you record. That is the point of demoing here rather than on a laptop.

## Before you press Record

1. Open <https://mandate.up.railway.app> and sign in. Privy creates an embedded wallet for the account on first login; that wallet is the strategy account.
2. Go to **Portfolio** and press **Get test USDC**. The balance should land at 10,000 test USDC. Do this before recording so you are not filming a loading state — you will point at the button during the demo rather than pressing it.
3. Decide which story you are telling, and prepare accordingly:
   - **Recommended — show a completed trade.** Before recording, run one strategy all the way through (steps 4–7 of the script) so a filled order already exists in Activity. During the recording you build a second strategy and stop at review, then cut to the completed one. Nobody waits on camera.
   - **Riskier — execute live.** Arm during the recording and wait for the fill. It usually lands in well under a minute, but it is a live system and you are betting the take on it.
4. Confirm **Settings → Automatic buying** is on for your wallet. If it is already on, leave it on and explain it; do not toggle it off just to demonstrate a click.
5. Use a window at least 1,000 pixels tall. Pick one theme, close developer tools and unrelated tabs, and keep environment files and credentials off camera.
6. Enable Do Not Disturb, check your microphone, and record only the browser window.
7. Return to **Overview** before starting.

## Spoken script

### 0:00–0:35 — The problem

**Screen:** Overview. Keep the cursor still.

> Buying a stock is one decision. Following a plan over the next few weeks is a whole series of them: watching the price, remembering your budget, and deciding whether today is the day.
>
> Mandate is a trading workspace for Coinbase tokenized stocks on Base. You write a rule, review exactly what it can spend, and sign it. Mandate watches the market and executes from your own wallet when you have turned automatic buying on.
>
> This is running live. I'll show you funding, a strategy, and a completed trade.

### 0:35–1:05 — Be honest about the environment, and fund the wallet

**Screen:** Portfolio. Point at the wallet address and the **Get test USDC** button.

> This demo runs against an isolated fork of Base with test funds, so nothing here touches real money, and these transactions won't show up on a public explorer.
>
> Every account gets its own wallet. This is it — deposits arrive here, and buys leave from here. On the demo, this button funds it with test dollars, so you can try the whole flow yourself at this URL.
>
> What matters is that the money stays in the user's wallet. There is no shared account holding funds in between.

### 1:05–2:00 — Build a strategy

**Screen:** New strategy → the weekly NVIDIA recipe → **Buy it for me** → Review.

> Here's the example: fifty dollars of tokenized NVIDIA every week.
>
> I pick the NVIDIA recipe and choose automatic buying. I set what each purchase spends, the total budget, and when it expires — so the instruction has a stopping point rather than running forever.
>
> Before signing, Mandate shows the rule back to me: what it will do, the most it can ever spend, and the exact text I'm signing. Signing records the instruction. It does not hand over the wallet.
>
> I'll leave this one at review and show you a strategy that has already run.

**Action:** Close the builder. Do not imply this unsigned example is the completed strategy you show next.

### 2:00–2:40 — Wallet and user control

**Screen:** Settings → Account. Point at the wallet and the Automatic buying control.

> Automatic buying is a single, separate switch. Turning it on lets Mandate's signer execute from this wallet while I'm away — one decision, once, rather than an approval for every strategy.
>
> There's no shared spender wallet and no smart-wallet requirement. And it's reversible: this switch turns it off, and any individual strategy can be paused on its own.
>
> Pausing stops new work. A transaction already submitted can still settle, and the interface says so rather than pretending otherwise.

### 2:40–3:35 — Evidence that it executed

**Screen:** Strategies → the completed strategy → Orders & signals. Then Activity.

> This is the strategy that already ran.
>
> Mandate signed two transactions from my wallet: an approval, then the swap. Fifty test dollars left the wallet and tokenized NVIDIA arrived in the same wallet.
>
> The completed order is here, and the same event appears in Activity. That link between the instruction and the result is the part I care about — you should be able to answer what your strategy did, what it spent, and whether it finished.
>
> Because this ran on a fork, I'm showing the result in the app rather than presenting it as a mainnet explorer transaction.

### 3:35–4:15 — Where the assets are

**Screen:** Portfolio, showing the NVDAc holding and the reduced cash balance.

> And here's the holding, in the same wallet that paid for it. Cash went down, the position appeared.
>
> That's the whole loop: fund a wallet, write a rule, review the limits, sign, and let it run — with the assets ending up somewhere the user controls.

### 4:15–4:45 — Close

**Screen:** Overview.

> Mandate makes tokenized equities useful beyond a single swap: a plan you can express, limits you can read, and a record of what actually happened.
>
> It's live at mandate dot up dot railway dot app, with test funds, so you can run this exact flow yourself.

## After recording

- Watch it once for anything that overstates the system: this is a fork, executions are test funds, and no claim about mainnet volume or real custody should survive the edit.
- Confirm no credential, private key, or environment file appears in any frame.
- Post the demo on X tagging **@buildonbase**, then submit via the Builder Quest form.

## If something misbehaves mid-recording

| Symptom | Cause | What to do |
|---|---|---|
| **Get test USDC** does nothing | Wallet already funded above the threshold | Expected — it refuses to top up. Carry on. |
| A strategy stays "Automatic buying is off" | Delegation not registered yet | Settings → toggle Automatic buying, then reopen the strategy. |
| An armed strategy does not fill | Worker or fork restarting | Check `/api/mandate/ready` shows `execution_available: true`, then re-arm. |
| Any action fails with a permission error | `APP_ORIGIN` no longer matches the domain | The API and worker must both carry the exact origin the browser uses. |
