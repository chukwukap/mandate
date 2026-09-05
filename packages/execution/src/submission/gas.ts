import type { Leg } from "../lifecycle.js";

/**
 * Can the spender still pay its way out of this order?
 *
 * The failure this prevents is specific and nasty. A buy is five possible transactions and
 * the user's USDC sits in the spender wallet from the second one onward. Gas is paid in ETH
 * by the spender, and users never top it up. If the key runs dry after `fund` and before
 * `refund`, the money cannot move in either direction: the swap cannot run, the allowance
 * cannot be reset, and the input cannot be returned. The order strands in the custodial
 * window until an operator funds the wallet by hand.
 *
 * So the check is not "can we afford the next transaction" — that is the naive version and
 * it is exactly wrong, because it happily signs the funding leg with just enough ETH for
 * the funding leg. It is "can we afford every transaction this order could still need,
 * including the unwind path we hope not to take".
 *
 * These numbers are a FLOOR on the balance required, never an estimate of what will be
 * spent. The node's own gas estimation still decides the real limit on each transaction;
 * this is a refusal to begin a sequence that might not be finishable.
 */

/** The full sequence, in the order the lifecycle can walk it. */
export const LEG_SEQUENCE = ["fund", "approve", "swap", "reset", "refund"] as const;

/**
 * Conservative upper bounds on gas per leg, in units.
 *
 * Deliberately generous. Being 2x over-cautious costs a slightly larger ETH float in an
 * operator's wallet; being under costs a stranded user balance. The swap allowance is the
 * largest because Slipstream can cross several initialised ticks and the B20 tokens run
 * transfer-policy checks against an onchain registry on every move, which a plain ERC-20
 * transfer does not.
 */
export const LEG_GAS_LIMITS: Readonly<Record<Leg, bigint>> = {
  fund: 250_000n,
  approve: 70_000n,
  swap: 500_000n,
  reset: 50_000n,
  refund: 80_000n,
};

/**
 * Per-transaction allowance for Base's L1 data fee, in wei.
 *
 * Base is an OP-stack rollup: every transaction pays an L2 execution fee AND an L1 fee for
 * posting its calldata, and the second one does not appear in `gasUsed * gasPrice` at all.
 * A budget built only from L2 gas understates the cost of a transaction, and understating
 * it here is what leaves the wallet a few thousand wei short on the refund. The allowance
 * is flat because these are all small, fixed-shape calls; it is generous because the L1
 * component moves with Ethereum blob prices and is not knowable in advance.
 */
export const L1_FEE_ALLOWANCE_WEI = 20_000_000_000_000n;

export type GasBudgetInput = {
  /** The leg about to be signed. Everything after it in the sequence is also budgeted. */
  readonly leg: Leg;
  /** The spender's native balance, in wei. */
  readonly balance: bigint;
  /** Current fee ceiling, wei per gas unit. */
  readonly maxFeePerGas: bigint;
  readonly limits?: Readonly<Record<Leg, bigint>> | undefined;
  readonly l1FeeAllowanceWei?: bigint | undefined;
};

export type GasBudget = {
  readonly sufficient: boolean;
  /** Legs budgeted for, this one included. */
  readonly legs: readonly Leg[];
  /** Wei the key must hold before this leg may be signed. */
  readonly required: bigint;
  readonly balance: bigint;
  /** Zero when the balance covers the requirement. */
  readonly shortfall: bigint;
};

/**
 * Every leg that could still be needed, starting from this one.
 *
 * `reset` and `refund` are included from `fund` onward even though a successful order never
 * runs them. They are the unwind path, and the whole argument for this check is that the
 * unwind path must be affordable at the moment the money moves — not merely at the moment
 * we discover we need it.
 *
 * A `reset` or `refund` already in progress budgets only for what is left of the unwind:
 * the swap is no longer reachable from there, and demanding its gas would refuse to return
 * a user's money over a transaction that will never be signed.
 */
export function remainingLegs(leg: Leg): readonly Leg[] {
  const index = LEG_SEQUENCE.indexOf(leg as (typeof LEG_SEQUENCE)[number]);
  if (index < 0) return [leg];
  return LEG_SEQUENCE.slice(index);
}

/** Wei required to sign `leg` and everything that could follow it. */
export function gasReserve(input: Omit<GasBudgetInput, "balance">): bigint {
  const limits = input.limits ?? LEG_GAS_LIMITS;
  const l1 = input.l1FeeAllowanceWei ?? L1_FEE_ALLOWANCE_WEI;
  const fee = input.maxFeePerGas > 0n ? input.maxFeePerGas : 0n;
  let total = 0n;
  for (const leg of remainingLegs(input.leg)) total += (limits[leg] ?? 0n) * fee + l1;
  return total;
}

/**
 * Decide whether the key may start or continue this sequence.
 *
 * A zero or negative `maxFeePerGas` — an RPC that answered nonsense — produces a reserve of
 * just the L1 allowances rather than zero, so an unreadable fee can never be read as "this
 * transaction is free".
 */
export function checkGas(input: GasBudgetInput): GasBudget {
  const required = gasReserve(input);
  const shortfall = required > input.balance ? required - input.balance : 0n;
  return {
    sufficient: shortfall === 0n,
    legs: remainingLegs(input.leg),
    required,
    balance: input.balance,
    shortfall,
  };
}

/** One operator-readable sentence. Wei, not ether: no float ever touches a balance here. */
export function describeGasShortfall(budget: GasBudget): string {
  return `The spender key holds ${budget.balance} wei but needs ${budget.required} wei to cover ${budget.legs.join(", ")}; it is short by ${budget.shortfall} wei.`;
}
