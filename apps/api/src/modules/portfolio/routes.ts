import {
  type Asset,
  type BalanceReader,
  type Hex,
  type Position,
  Problem,
} from "@mandate/contracts";
import { CHAIN_ID } from "@mandate/evm";
import { Decimal } from "decimal.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { principal } from "../auth/principal.js";
import type { MarketSnapshots } from "../market/snapshot.js";

/**
 * What the caller's wallet actually holds, valued at the prices the market page is showing.
 *
 * # Why this reads the chain rather than the order history
 *
 * The obvious cheaper implementation is to sum this user's filled executions. It would be wrong.
 * The account is the user's own wallet, not a custodial ledger: they can buy the same tokens on
 * any venue, receive them as a transfer, or sell them somewhere else entirely, and none of that
 * passes through this database. A portfolio derived from our order history would silently
 * disagree with the user's wallet, and would disagree in the direction that flatters us — showing
 * only what we did. The token contracts are the authority on what someone owns, so they are what
 * this asks.
 *
 * # Why the prices come from the market snapshot and not from a fresh read
 *
 * So that one number does not contradict another. The market page, the strategy review card and
 * this endpoint all quote the same asset, and a user comparing two screens a second apart must
 * not see two prices. Sharing `MarketSnapshots` means they share a cache entry and therefore an
 * answer, and it also means the portfolio inherits the staleness bounds that were argued out in
 * base.ts rather than inventing a second, looser opinion about what counts as a live price.
 */

export interface PortfolioDependencies {
  chain: BalanceReader;
  assets: readonly Asset[];
  /** Shared with the market module so both surfaces quote identical prices. */
  snapshots: MarketSnapshots;
}

export type Holding = {
  symbol: string;
  token: Hex;
  decimals: number;
  quantity: string;
  /** The reference price used for `value`, or null when no live price was available. */
  price: string | null;
  value: string | null;
  /** True when the price backing `value` is a held close rather than a live quote. */
  stale: boolean;
};

export type PortfolioResponse = {
  chain_id: number;
  as_of: string;
  wallet: Hex;
  cash: string;
  holdings: Holding[];
  /**
   * Cash plus the value of every priced holding, or null when any held asset could not be
   * priced. Deliberately all-or-nothing: a total that silently omits one position is worse than
   * no total, because it looks like a total.
   */
  equity: string | null;
  /** Set when `equity` is null, naming the assets that could not be priced. */
  unpriced: string[];
  notice: string;
};

const query = z.strictObject({
  /** Optional; defaults to the caller's first linked wallet. */
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

const NOTICE =
  "Balances are read directly from the token contracts on Base. Values use the same reference prices as the market page, which can hold the last close during closed sessions. A value is not a quote and not a trade authorization.";

export async function registerPortfolio(app: FastifyInstance, deps: PortfolioDependencies) {
  app.get(
    "/v1/portfolio",
    {
      schema: {
        tags: ["portfolio"],
        summary: "Onchain balances for a linked wallet, valued at reference prices",
        security: [{ privy: [] }],
        querystring: z.toJSONSchema(query, { target: "draft-7", io: "input" }),
      },
      // Every miss is a paced RPC batch. Tighter than the global 120/min for the same reason
      // /v1/me/wallets is: this endpoint is refreshed by a screen, not polled by a heartbeat.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request): Promise<PortfolioResponse> => {
      const user = principal(request);
      const parsed = query.safeParse(request.query ?? {});
      if (!parsed.success)
        throw new Problem(
          400,
          "invalid-wallet",
          "Invalid wallet",
          "Wallet must be a 0x-prefixed 40-character address.",
        );

      // Authorization, not validation. Without this check any authenticated user could read any
      // address's holdings through our RPC — public data, but served under their session and
      // presented as "your portfolio", which is a different claim.
      const requested = parsed.data.wallet?.toLowerCase();
      const wallet = requested
        ? user.wallets.find((w) => w.toLowerCase() === requested)
        : user.wallets[0];
      if (!wallet) {
        throw requested
          ? new Problem(
              403,
              "wallet-not-linked",
              "Wallet not linked",
              "That wallet is not linked to your account.",
            )
          : new Problem(
              409,
              "no-wallet",
              "No wallet linked",
              "Link a wallet before viewing a portfolio.",
            );
      }

      const [balances, snapshot] = await Promise.all([
        // An RPC that cannot be reached is an outage, not a bug. Left unguarded this rejected
        // into the generic 500 "internal-error", which tells an operator to look for a defect in
        // this code while the chain is simply down — and it is the one failure this route can
        // do nothing about except say so.
        deps.chain.balances(wallet, deps.assets).catch(() => {
          throw Problem.unavailable("Balances could not be read from the chain right now.");
        }),
        // A price failure must not hide the balances. Quantities are the part the user cannot
        // get anywhere else in this app; an unpriced holding is still worth showing.
        deps.snapshots.current().catch(() => undefined),
      ]);

      const priceOf = (symbol: string) =>
        snapshot?.feeds.find((feed) => feed.uri === `oracle:${symbol}`);

      const unpriced: string[] = [];
      const holdings = balances.positions
        // Zero balances are omitted rather than listed at zero. A portfolio is what you hold,
        // and eight rows of 0.00 buries the two that are real.
        .filter((position: Position) => new Decimal(position.quantity).greaterThan(0))
        .map((position: Position): Holding => {
          const feed = priceOf(position.symbol);
          const price = feed?.value ?? null;
          if (price === null) unpriced.push(position.symbol);
          return {
            symbol: position.symbol,
            token: position.token,
            decimals: position.decimals,
            quantity: position.quantity,
            price,
            value:
              price === null
                ? null
                : new Decimal(position.quantity).mul(price).toDecimalPlaces(2).toFixed(2),
            stale: feed?.stale ?? true,
          };
        });

      const equity = unpriced.length
        ? null
        : holdings
            .reduce((total, holding) => total.plus(holding.value ?? 0), new Decimal(balances.cash))
            .toDecimalPlaces(2)
            .toFixed(2);

      return {
        chain_id: CHAIN_ID,
        as_of: new Date(balances.at).toISOString(),
        wallet,
        cash: balances.cash,
        holdings,
        equity,
        unpriced,
        notice: NOTICE,
      };
    },
  );
}
