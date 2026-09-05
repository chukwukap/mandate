# Onboarding: from interest to a first rule

The welcome flow leads with the user's job: decide when to act without watching a
market continuously. It makes the product concrete before asking for a wallet.
The interface uses the workspace's warm canvas, green actions and dark brand panel;
a stock-rule illustration changes with the selected stock and execution preference.
It is labeled as an illustration and contains no fabricated returns or live signals.

## Journey

1. **Understand the value.** Three concise benefits explain conditions, limits and
   recorded activity. One primary action advances; preview and skip stay available.
2. **Make a small choice.** Pick a stock and signals or automatic buys. Signals are
   the initial choice because they need no spending authority. The automatic option
   states the smart-wallet and approval requirements beside the choice.
3. **Connect with context.** Recap the chosen stock and mode, explain that connecting
   grants no spending access, then offer Privy connection. After connection, carry
   those choices into the editor with price and budget still left for the user.

Wallet connection, signing a strategy, approving spending and starting a strategy
are separate actions. Onboarding performs no transaction, creates no signed strategy
and grants no permission. When Privy is unconfigured the interface says connection
is unavailable and offers the sample workspace; it never simulates a successful login.

## UX decisions

The primary action is singular at each step. Supporting text answers the immediate
question instead of introducing the full protocol. Progress, a back action and
preserved choices make the short flow reversible. Keyboard focus moves to the new
step's heading. Reduced-motion preferences disable step transitions. Mobile keeps
the wordmark and task content while removing the large desktop illustration.

Completion and skipping are persisted locally with a versioned, validated record.
Storage failure still permits the current session to proceed. Only the public stock
and execution preference are stored; no wallet token, signature or budget is kept.
A first visit to `/` opens `/welcome`; deep links and explicit preview remain directly
accessible. Settings can reopen onboarding later.

## Measurement and limits

Useful measures for a future analytics integration are welcome-to-stock-selection,
wallet connection completion and first signed strategy. These should be evaluated
alongside abandonment at the permission boundary, not just connection conversion.
No analytics service or tracking events are implemented here, and no conversion
improvement is claimed without user testing.

The browser suite exercises all three steps, selection, persisted skip, preview,
mobile overflow and accessibility. A real Privy session and funded smart-wallet
journey still require credentials and separate end-to-end verification.
