/**
 * Why a strategy has not traded, in words a user can act on.
 *
 * The worker records a reason for every tick, and the API has always exposed it — nothing in the
 * web app ever asked. So a strategy that was working perfectly and a strategy that could never
 * fire looked exactly the same on screen: a row with no orders. Everything below is a
 * translation of values the backend already produces.
 *
 * Refusals matter most for the recurring shape. Its rule is deliberately always true and its
 * cadence comes from the cooldown, so between two daily buys it records hundreds of "Cooldown
 * active" refusals. Shown raw that reads as hundreds of failures; it is the mechanism working,
 * and it should read as "waiting".
 */

/** One evaluation row as `/v1/instances/:id/evaluations` returns it. */
export type Evaluation = {
  id: string;
  at: string;
  outcome: string;
  admitted: number;
  refused: string | null;
};

export type Idle = {
  /** Short enough for a status line. */
  headline: string;
  /** What the user can do about it, or null when the answer is "nothing, this is normal". */
  action: string | null;
  tone: "ok" | "waiting" | "attention";
};

/**
 * `refused` carries the engine's own refusal strings from `REFUSALS` in the enforcement package.
 * They are stable values rather than prose, so matching on them is safe; anything unrecognised
 * falls through to the outcome, which is a closed enum.
 */
const REFUSALS: Record<string, Idle> = {
  "Cooldown active": {
    headline: "Waiting for the next scheduled buy",
    action: null,
    tone: "waiting",
  },
  "Order count limit reached": {
    headline: "Daily order limit reached",
    action: "It resumes when the period rolls over.",
    tone: "waiting",
  },
  "Period cap exceeded": {
    headline: "Daily budget spent",
    action: "It resumes when the period rolls over.",
    tone: "waiting",
  },
  "Lifetime cap exceeded": {
    headline: "Total budget spent",
    action: "Create a new strategy to keep going.",
    tone: "attention",
  },
  "Insufficient USDC balance": {
    headline: "Not enough USDC",
    action: "Add USDC to your wallet and it will buy on the next check.",
    tone: "attention",
  },
  "Insufficient stock balance": {
    headline: "Not enough of that stock held",
    action: null,
    tone: "attention",
  },
  "Per-order cap exceeded": {
    headline: "An order was larger than your per-order limit",
    action: "The rule wants to buy more than the limit you signed allows.",
    tone: "attention",
  },
  "Order resolves to zero": {
    headline: "The order rounded to nothing",
    action: "The size is too small to settle at this price.",
    tone: "attention",
  },
};

const OUTCOMES: Record<string, Idle> = {
  halted: { headline: "Stopped by its own rule", action: null, tone: "attention" },
  expired: {
    headline: "Expired",
    action: "Create a new strategy to keep going.",
    tone: "attention",
  },
  "execution-disabled": {
    headline: "Automatic execution is off",
    action: "Nothing will be bought until it is back on.",
    tone: "attention",
  },
  "eligibility-renewal-required": {
    headline: "Needs re-arming",
    action: "Arm it again to confirm you are still eligible.",
    tone: "attention",
  },
  // The honest catch-all. This one outcome covers a closed market, an unreachable price feed, a
  // permission that is not active, and a pool too far from its reference — the API does not say
  // which, so neither do we. Naming the most common cause first is more useful than a shrug.
  "observation-or-authority-unavailable": {
    headline: "Waiting for the market to open",
    action:
      "Automatic buys run 9:35am–3:55pm ET on weekdays. It also waits if prices cannot be read.",
    tone: "waiting",
  },
  "observation-expired": {
    headline: "Prices went stale mid-check",
    action: "It will try again on the next check.",
    tone: "waiting",
  },
  "invalid-commitment": {
    headline: "This strategy failed its signature check",
    action: "It will not run. Please report it.",
    tone: "attention",
  },
};

export function whyIdle(
  latest: Evaluation | null,
  status: string,
  mode?: string,
  requestedMode?: string,
): Idle | null {
  if (status === "paused")
    return { headline: "Paused", action: "Arm it to start buying.", tone: "waiting" };
  if (status === "ended") return { headline: "Stopped", action: null, tone: "attention" };
  /**
   * Asked for automatic, still running as signals.
   *
   * `mode` only becomes "auto" once the spending permission is activated; a strategy whose
   * permission was never approved arms happily and records signals instead. This has to be
   * checked BEFORE the admitted branch below, because a recorded signal counts as an admitted
   * order — so the page would otherwise show a green "Bought on the last check" to someone who
   * has bought nothing at all.
   */
  if (requestedMode === "auto" && mode && mode !== "auto")
    return {
      headline: "Approval needed before it can buy",
      action: "This is recording signals only. Approve spending to place real orders.",
      tone: "attention",
    };
  if (!latest)
    return {
      headline: "Not checked yet",
      action: "The first check happens within a minute of arming.",
      tone: "waiting",
    };
  if (latest.admitted > 0)
    return { headline: "Bought on the last check", action: null, tone: "ok" };
  if (latest.refused && REFUSALS[latest.refused]) return REFUSALS[latest.refused] as Idle;
  if (OUTCOMES[latest.outcome]) return OUTCOMES[latest.outcome] as Idle;
  // `evaluated` with nothing admitted and nothing refused is the ordinary case: the strategy
  // looked, and its conditions were not met. That is the system working, not a problem.
  if (latest.outcome === "evaluated")
    return { headline: "Watching — conditions not met yet", action: null, tone: "ok" };
  return null;
}
