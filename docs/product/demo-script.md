# Mandate demo script and recording guide

**Target length:** 4–5 minutes. Read only the quoted narration aloud, at about 125–140 words per minute. Allow a short pause for each screen change. The screen directions and checklist are not part of the narration.

**Recording title:** Mandate — automated tokenized-stock strategies on Base

**Demo environment:** http://localhost:3000. The last verified setup uses a local Base fork and test funds. Say this clearly. Fork transaction hashes will not appear as confirmed transactions on the public Base explorer.

## Before you press Record

1. Open Mandate and make sure you are signed in. Use the embedded Mandate wallet that ends in **27d3** for the verified test results.
2. Open Portfolio and confirm the balances load. After the two verified test trades, that wallet held **9,900 test USDC** and approximately **0.432561 NVDAc**. Those are preparation references, not figures to promise if the wallet has changed. Read what the screen actually shows.
3. Find the completed strategy **Auto NVIDIA 215841**. The earlier **Auto NVIDIA 215058** also contains a completed trade. Both were left paused after testing. Open the newer strategy once so you know where its history is.
4. Check Settings and the Automatic buying control. If it is already on, leave it on during recording and explain it. Do not accidentally switch it off just to demonstrate a click.
5. Rehearse the builder: New strategy → NVIDIA weekly recipe → Buy it for me → Review. For this recording, stop at review and close the builder; show the already completed trade afterward. This avoids waiting for another wallet signature or order.
6. Use a window at least 1,000 pixels tall where possible. Keep the text readable, select one theme, and close developer tools, terminal windows, and unrelated tabs.
7. Enable Do Not Disturb, check your microphone, and record only the application window. Keep every credential and environment file off camera.
8. Return to Overview before starting. Keep this script on a second screen or your phone.

## Spoken script

### 0:00–0:35 — Start with the problem

**Screen:** Overview. Keep the cursor still while introducing the product.

> Buying a stock is one decision. Following a plan over the next few weeks is a whole series of decisions: checking the market, remembering your budget, and deciding whether to act.
>
> I built Mandate to make that process easier to follow. It is a trading workspace for tokenized stocks on Base. You set a rule, review the limits, and sign your instructions. Mandate watches for the conditions and can execute from your wallet when automatic buying is enabled.
>
> I’ll show you the setup, a completed automated trade, and where the resulting holdings live.

### 0:35–1:00 — Make the environment clear

**Screen:** Markets briefly, then click New strategy.

> This demonstration uses a local fork of Base with test funds. The completed trade I’ll show was executed on that fork, rather than on mainnet.
>
> The goal is to make tokenized equities useful beyond a one-time swap. Someone should be able to express a repeatable plan, understand what it can spend, and come back to see what actually happened.

### 1:00–1:55 — Build a concrete strategy

**Screen:** Select the weekly NVIDIA recipe. Choose Buy it for me. Show the amount and budget fields, then open Review.

> Here’s a simple example: I want to buy fifty dollars of tokenized NVIDIA every week.
>
> I start with the NVIDIA recipe and choose automatic buying. I can review the amount for each purchase, the total budget, and when the strategy expires. These are the boundaries of the instruction, so the plan has a defined stopping point.
>
> Before I sign, Mandate presents the rule for review. I can inspect what it will do and the maximum amount it can spend. There is also an option to inspect the exact text being signed.
>
> Signing the strategy records my instructions. Enabling wallet automation is a separate account setting. That distinction matters: I should understand both the plan I’m creating and the access I’m giving the application.
>
> I’ll leave this example at review and show you a strategy we already executed, so you can see the result without waiting for another order.

**Action:** Close the builder. Do not imply that this unsigned example is the completed strategy shown later.

### 1:55–2:40 — Explain the wallet and user control

**Screen:** Settings → Account. Point to the wallet and Automatic buying control. No toggle click is required.

> Each user has a Privy embedded wallet. Funds are deposited directly into that wallet, and the strategy’s purchases are made from it.
>
> Automatic buying gives the application’s server signer access to execute from the wallet while the user is offline. It does not require a separate shared spender wallet.
>
> This control is where the user can turn that access on or off. A strategy can also be paused independently. Pausing stops new work; a transaction that has already been submitted may still settle.
>
> For me, the important part of this experience is that the user can see which wallet is involved, what the strategy is allowed to do, and how to stop future buying.

### 2:40–3:30 — Show evidence of execution

**Screen:** Strategies → Auto NVIDIA 215841 → Orders & signals. Point to the completed order, then show Activity.

> This is the strategy from our completed test. It is paused now because the test is finished, but its execution history is still visible.
>
> The worker signed two transactions from the embedded wallet: an approval and the swap. Fifty test USDC left that wallet, and tokenized NVIDIA arrived in the same wallet.
>
> You can see the completed order here, and the same event appears in Activity. That connection between the instruction and the result is important. The product should help someone answer: what did my strategy do, how much did it spend, and did it complete?
>
> The transaction link is present too. Because this particular execution happened on a local fork, I’m showing its result here rather than presenting it as a mainnet explorer transaction.

### 3:30–4:15 — Show where the assets ended up

**Screen:** Portfolio. Point to the deposit address, cash balance, and NVIDIA holding. Pause briefly so viewers can read them.

> Here is the portfolio for that same embedded wallet. The funding card shows where deposits go, and below it are the remaining cash balance and the NVIDIA position.
>
> These balances are read from the chain. They are not calculated only from Mandate’s order history. That means the portfolio reflects what the wallet holds, including assets that may have arrived outside a strategy.
>
> The portfolio value is a reference valuation. It is not a promise of the price a future sale would receive.
>
> The complete loop is visible: a rule with limits, wallet access for automation, an executed order, and the resulting assets in the user’s wallet.

### 4:15–4:40 — Close on the product

**Screen:** Stay on Portfolio, or return to the completed strategy. Avoid opening another feature.

> That is Mandate: a way to turn tokenized stocks on Base into a plan you can review, automate, and pause.
>
> The direct-wallet execution path has been verified end to end on the local fork, including the trade, activity history, and portfolio display. Live mainnet trading is the next validation step.
>
> Thanks for watching. I’d love feedback on whether the strategy setup and execution history make the experience clear enough to trust and use.

## How to deliver it well

- **Demonstrate one story:** fifty dollars into NVIDIA on a schedule. Resist adding unrelated features midway through.
- **Speak before moving:** introduce the next screen, navigate, then allow a second for the viewer to orient themselves.
- **Point to evidence:** amount, cap, completed status, wallet address, and holding. Avoid sweeping the cursor around the page.
- **Keep the technical explanation short:** “server signer access” is enough. Do not explain environment variables, private keys, database tables, or the application framework.
- **Use the prepared result honestly:** say “the completed test” instead of claiming an order is executing live while showing a previous trade.
- **Do not claim returns:** this demo demonstrates execution and user controls, not profitability, guaranteed prices, or risk-free trading.
- **Let the last screen breathe:** stop speaking for two seconds before ending the recording.

## If something is slow or unavailable

| What happens | What to do and say |
| --- | --- |
| A historical chart does not load | Continue to the strategy. “Historical chart data is temporarily unavailable; I’ll show the strategy and completed execution.” |
| A balance is still loading | Wait briefly, then use Refresh or Try again once. If it still fails, show the completed order and say the live balance read is unavailable. Do not claim the balance is currently verified on screen. |
| A wallet prompt takes too long | Close the unsigned example and continue with the prepared trade. “I’ll use the completed test for the rest of the walkthrough.” |
| The test strategy is paused | This is expected. Explain that it was paused after verification; its completed history remains visible. |
| A transaction link opens an empty public explorer result | Return to Mandate and explain that local-fork transactions are not published to mainnet. Prefer not to open that link during the demo. |
| You lose your place | Pause, find the next screen, and resume. Trim the pause afterward if your recording tool allows it. |

## After recording

Watch the beginning, the completed-trade segment, and the ending once. Check that the text is legible, audio is clear, and no secrets are visible. Ensure the Loom link is viewable by your intended audience.

Based on the quest instructions you supplied, post the Loom demo on X tagging **@buildonbase**, then submit the project through the official entry form. Confirm the current deadline and form on the organizer’s post before submitting; do not rely on the recording itself as your submission.
