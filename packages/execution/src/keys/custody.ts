import type { Leg } from "../lifecycle.js";

/**
 * What custody actually looks like while an order runs, stated without euphemism.
 *
 * The product story is "you keep your funds; you grant a capped, revocable permission".
 * That is true of the authority and false of the money for one window of the execution
 * sequence, and this module exists so no other part of the system can quietly round the
 * second half off.
 *
 * The sequence for a buy is: `fund` pulls USDC from the user's account into the SPENDER
 * WALLET, which is an EOA whose private key this server process holds; `approve` lets the
 * Aerodrome router take that USDC; `swap` spends it and sends the shares directly to the
 * user's account. Between the fund receipt and the swap receipt the user's dollars sit in
 * a server-controlled wallet. In that window the system is CUSTODIAL. Not "effectively
 * non-custodial", not "non-custodial with a relayer" — a key on a server can move that
 * balance anywhere, and the only things standing between the user and a total loss are
 * this codebase behaving and that key not leaking.
 *
 * Two properties bound the damage and neither of them removes it:
 *
 *  - The spend permission caps what can EVER be pulled (per period, and until `end`), so
 *    the exposure is bounded by the cap the user signed, not by their whole balance.
 *  - The window is short by design — three transactions on a 2s chain — and the lifecycle
 *    drives a `reset`/`refund` pair whenever the swap cannot proceed.
 *
 * The route that would remove the window entirely is atomic: a single transaction that
 * pulls, swaps and delivers, so no intermediate balance is ever held. `SpendPermissionManager`
 * supports `spendWithWithdraw` / batched execution against a smart account, and doing this
 * properly means the spender never holds anything. It is not implemented here, and until it
 * is, the disclosure below is the honest description.
 */
export const CUSTODY_DISCLOSURE =
  "Automatic orders are not non-custodial end to end. To place a trade, the worker first " +
  "pulls the order's USDC out of your account into a wallet this service controls, then " +
  "swaps it and sends the shares back to you. Your money is under this service's control " +
  "between those two transactions — usually seconds, longer if a transaction is delayed or " +
  "a swap has to be unwound and returned. The spend permission caps how much can be pulled " +
  "and you can revoke it at any time, but during that window a failure or a compromise of " +
  "this service can lose the funds it is holding.";

/** The three-transaction sequence, in the order it runs, for anything that renders it. */
export const CUSTODY_SEQUENCE = [
  {
    leg: "fund",
    holder: "spender",
    plain: "Your USDC moves from your account into this service's wallet.",
  },
  {
    leg: "approve",
    holder: "spender",
    plain: "This service lets the Aerodrome router spend that USDC. Still holding it.",
  },
  {
    leg: "swap",
    holder: "account",
    plain: "The swap runs and the shares are delivered straight to your account.",
  },
  {
    leg: "reset",
    holder: "spender",
    plain: "The router's allowance is taken back before anything is returned.",
  },
  {
    leg: "refund",
    holder: "account",
    plain: "The unswapped USDC is sent back to your account.",
  },
] as const satisfies readonly { leg: Leg; holder: CustodyHolder; plain: string }[];

/** Who can move the order's input right now. */
export type CustodyHolder =
  /** The user's own account. Nothing this server holds can move it. */
  | "account"
  /** The server-controlled spender wallet. This service can move it. */
  | "spender"
  /**
   * Undetermined, and therefore to be treated as `spender`.
   *
   * A `fund` transaction that is signed and broadcast but has no settled receipt may
   * already have mined. Reporting "the user still holds it" because we have not yet seen
   * the receipt is the one answer that is never safe, so this state carries the full
   * exposure amount alongside it.
   */
  | "unknown";

/** One journal row, reduced to what custody depends on. `TransactionRow` satisfies it. */
export type CustodyLeg = {
  readonly leg: string;
  readonly status: string;
  readonly confirmedAt?: Date | null;
};

export type Custody = {
  readonly holder: CustodyHolder;
  /**
   * Input under this service's control, in the input token's minor units.
   *
   * Integer, never a float, and non-zero for `unknown` as well as `spender` — an unsettled
   * fund leg is accounted at its full value until a receipt says otherwise.
   */
  readonly exposure: bigint;
  /** When the fund leg settled, if it has. Null while the exposure is only possible. */
  readonly since: Date | null;
  /** True once a settled receipt puts the input somewhere definite. */
  readonly settled: boolean;
  /** One sentence for an operator or a user. Contains no addresses and no key material. */
  readonly plain: string;
};

const CONFIRMED = "confirmed";
const REVERTED = "reverted";

function find(legs: readonly CustodyLeg[], leg: Leg) {
  return legs.find((row) => row.leg === leg);
}

/**
 * Where an order's input actually is, from the durable journal alone.
 *
 * Deliberately derived from transaction rows rather than from `executions.status`. The
 * order status is a summary written by the lifecycle after the fact; the journal is the
 * record of what was signed and what settled. When the two disagree — which is exactly
 * what a crash between broadcast and the status write produces — the journal is right.
 *
 * A reverted fund leg moved nothing: the whole point of an EVM revert is that state is
 * unwound, so the user still holds their USDC. A reverted swap, by contrast, leaves the
 * input sitting in the spender wallet, which is why that case reports `spender` and not
 * some "failed, nothing happened" state.
 */
export function custody(legs: readonly CustodyLeg[], amountIn: bigint): Custody {
  const fund = find(legs, "fund");
  const swap = find(legs, "swap");
  const refund = find(legs, "refund");
  if (!fund || fund.status === REVERTED)
    return {
      holder: "account",
      exposure: 0n,
      since: null,
      settled: true,
      plain: fund
        ? "The funding transaction reverted, so the input never left the strategy account."
        : "No funding transaction has been signed; the input is still in the strategy account.",
    };
  if (fund.status !== CONFIRMED)
    return {
      holder: "unknown",
      exposure: amountIn,
      since: null,
      settled: false,
      plain:
        "A funding transaction is in flight. Until its receipt is read, the input must be " +
        "treated as already held by this service.",
    };
  const since = fund.confirmedAt ?? null;
  if (swap?.status === CONFIRMED)
    return {
      holder: "account",
      exposure: 0n,
      since,
      settled: true,
      plain: "The swap settled and the proceeds went straight to the strategy account.",
    };
  if (refund?.status === CONFIRMED)
    return {
      holder: "account",
      exposure: 0n,
      since,
      settled: true,
      plain: "The input was returned to the strategy account.",
    };
  // Funding confirmed, nothing has moved it back out. This is the custodial window, and it
  // is reported the same way whether the swap is mid-flight or the order is stuck: from the
  // user's point of view those are the same fact.
  return {
    holder: "spender",
    exposure: amountIn,
    since,
    settled: true,
    plain:
      swap?.status === REVERTED
        ? "The swap reverted and this service is holding the input until it is returned."
        : "This service is holding the input while the swap runs.",
  };
}

/** True when this service can currently move the order's money. The safe default is true. */
export function custodial(state: Custody): boolean {
  return state.holder !== "account";
}
