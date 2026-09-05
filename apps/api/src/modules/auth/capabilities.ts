import type { ChainReader, Hex, Identity } from "@mandate/contracts";

export type WalletKind = Identity["walletKind"];
export type WalletCapability = {
  address: Hex;
  /** null when the chain could not be read for this address on this request. */
  kind: WalletKind | null;
  can_authorize_spending: boolean;
  checked: boolean;
  checked_at: string | null;
};
type Entry = { kind: WalletKind; at: number };

/**
 * A capability answer is a cache of an onchain fact, not an authorization.
 *
 * `can_authorize_spending` is true only for a Base account whose owner set contains
 * SpendPermissionManager. That can stop being true — an owner is removable — and the inverse can
 * become true after the fact, because a counterfactual account deploys on first use and an EOA can
 * gain code through an EIP-7702 delegation. So this value is safe for deciding what to *offer* and
 * never safe for deciding what to *allow*: POST /v1/permissions/prepare re-reads walletKind at the
 * moment it matters and is the only check that gates automatic execution.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 512;
/**
 * Chain lookups issued per request. Each walletKind is getCode + one readContract, and the shared
 * BaseReader transport paces HTTP at 1.2s with at most 12 in flight (packages/evm paced-fetch).
 * Eight addresses is 16 eth_ calls, which viem batches into 4 requests (~4.8s worst case) and
 * leaves two thirds of the pacing queue for market and quote traffic. Without a bound, one account
 * with fifty linked wallets would drain that queue and make every other caller's RPC fail.
 * Addresses past the bound come back unchecked; the 60s cache fills them in on the next poll.
 */
const MAX_LOOKUPS = 8;

export class WalletCapabilities {
  private readonly cache = new Map<Hex, Entry>();
  private readonly inflight = new Map<Hex, Promise<Entry | null>>();

  constructor(
    private readonly chain: ChainReader,
    private readonly ttlMs: number = TTL_MS,
    private readonly maxEntries: number = MAX_ENTRIES,
    private readonly maxLookups: number = MAX_LOOKUPS,
  ) {}

  /**
   * Resolve one row per supplied wallet, in the order supplied. Never rejects: an address whose
   * lookup failed or was not attempted comes back with kind null and checked false, because a
   * degraded RPC must not turn the signed-in user's wallet list into a 500.
   */
  async kinds(wallets: readonly Hex[], now: number = Date.now()): Promise<WalletCapability[]> {
    let budget = this.maxLookups;
    const resolved = new Map<Hex, Entry | null>();
    const waits: Promise<void>[] = [];
    for (const address of new Set(wallets)) {
      const cached = this.cache.get(address);
      if (cached && now - cached.at < this.ttlMs) {
        resolved.set(address, cached);
        continue;
      }
      // Two tabs polling at once, or the same address twice in a list, must not double the RPC
      // cost: join the in-flight read instead of starting a second one.
      let running = this.inflight.get(address);
      if (!running) {
        if (budget === 0) {
          resolved.set(address, null);
          continue;
        }
        budget -= 1;
        running = this.lookup(address, now);
      }
      waits.push(
        running.then((entry) => {
          resolved.set(address, entry);
        }),
      );
    }
    await Promise.all(waits);
    return wallets.map((address) => capability(address, resolved.get(address) ?? null));
  }

  private lookup(address: Hex, now: number): Promise<Entry | null> {
    const request = this.chain
      .walletKind(address)
      .then((kind) => {
        const entry: Entry = { kind, at: now };
        this.remember(address, entry);
        return entry;
      })
      // A reverting contract, a full RPC queue or a network timeout degrades exactly one row.
      // The error object is dropped rather than logged: viem attaches the request URL and body,
      // and the RPC URL can carry a provider key.
      .catch((): Entry | null => null)
      .finally(() => {
        this.inflight.delete(address);
      });
    this.inflight.set(address, request);
    return request;
  }

  private remember(address: Hex, entry: Entry) {
    // Re-insert so Map order is write recency; the oldest write is then also the entry closest to
    // expiring, which makes eviction and the TTL agree. Failures are deliberately not stored — a
    // cached "unknown" would pin a wrong answer for 60s across every tab the user has open.
    this.cache.delete(address);
    this.cache.set(address, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

function capability(address: Hex, entry: Entry | null): WalletCapability {
  return {
    address,
    kind: entry?.kind ?? null,
    can_authorize_spending: entry?.kind === "base_account",
    checked: entry !== null,
    checked_at: entry ? new Date(entry.at).toISOString() : null,
  };
}
