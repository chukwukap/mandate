import { type Asset, type ChainReader, Problem } from "@mandate/contracts";
import { CHAIN_ID } from "@mandate/evm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { candlesFor, INTERVALS, isInterval } from "./candles.js";
import { DEVIATION_LIMIT_BPS, priceCheck } from "./catalogue.js";
import { MarketSnapshots } from "./snapshot.js";

export interface MarketDependencies {
  chain: ChainReader;
  assets: readonly Asset[];
  /** Worker heartbeat. Injected so this module needs no database handle of its own. */
  executionAvailable(): Promise<boolean>;
  /** Supplied by tests and by any caller that wants to share one refresh across routes. */
  snapshots?: MarketSnapshots | undefined;
}

const quoteInput = z.strictObject({
  symbol: z.string().max(24),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d{1,30}(\.\d{1,18})?$/),
  slippage_bps: z.int().min(1).max(500).default(50),
});

// Copied from modules/strategies/routes.ts, which does not export them. If a shared HTTP
// module lands under apps/api/src/plugins or apps/api/src/modules/shared, import from there
// and delete these three.
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7", io: "input" });
function definition(tag: string, summary: string, body?: z.ZodType, params?: z.ZodType) {
  return {
    schema: {
      tags: [tag],
      summary,
      security: [{ privy: [] }],
      ...(body ? { body: json(body) } : {}),
      ...(params ? { params: json(params) } : {}),
    },
  };
}
function requireEligible(request: FastifyRequest) {
  if (!request.eligible)
    throw new Problem(
      403,
      "not-eligible",
      "Trading unavailable",
      "Trading is unavailable for your verified jurisdiction.",
    );
}

/**
 * Preserved byte-for-byte from the route this module replaces. apps/web renders it verbatim,
 * and it is the only place the response admits that a reference feed can hold a stale close.
 */
export const REFERENCE_NOTICE =
  "Reference feeds can hold the last close during closed sessions or corporate-action pauses. A quote is not a trade authorization.";

export async function registerMarket(app: FastifyInstance, deps: MarketDependencies) {
  const snapshots =
    deps.snapshots ?? new MarketSnapshots(deps.chain, deps.assets, { log: app.log });
  // /v1/market is public (app.ts exempts exactly this path from authentication), so a database
  // outage must degrade the flag rather than 500 the page. This matches how app.ts already
  // treats worker availability on /ready and /v1/me.
  const executionAvailable = async () => {
    try {
      return await deps.executionAvailable();
    } catch {
      return false;
    }
  };

  app.get(
    "/v1/market",
    { schema: { tags: ["market"], summary: "Catalogue and observed market feeds" } },
    async () => {
      const snapshot = await snapshots.current();
      return {
        chain_id: CHAIN_ID,
        assets: deps.assets,
        feeds: snapshot.feeds,
        execution_available: await executionAvailable(),
        reference_notice: REFERENCE_NOTICE,
        // Everything below is additive. apps/web reads only the four keys above.
        as_of: snapshot.as_of,
        probe: snapshot.probe,
        catalogue: snapshot.catalogue,
      };
    },
  );

  app.get(
    "/v1/market/candles",
    {
      schema: {
        tags: ["market"],
        summary: "Observed OHLCV for a listed asset",
        querystring: {
          type: "object",
          required: ["symbol"],
          properties: {
            symbol: { type: "string", maxLength: 24 },
            interval: { type: "string", enum: Object.keys(INTERVALS) },
          },
        },
      },
      // Public, like /v1/market. A price chart is the first thing a visitor looks at, and
      // requiring a wallet to see one asks for a commitment before showing anything.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const query = request.query as { symbol?: string; interval?: string };
      const asset = deps.assets.find((candidate) => candidate.symbol === query.symbol);
      if (!asset) {
        throw new Problem(
          404,
          "unknown-asset",
          "Unknown asset",
          "That symbol is not in the catalogue.",
        );
      }
      const interval = query.interval && isInterval(query.interval) ? query.interval : "1H";
      const candles = await candlesFor(asset, interval);
      return {
        symbol: asset.symbol,
        interval,
        // Named so the chart can say where the marks came from. These are pool trades on
        // Aerodrome, not the Chainlink reference and not the equity's primary exchange.
        source: "aerodrome",
        candles,
      };
    },
  );

  app.post(
    "/v1/market/quote",
    definition("market", "Read-only exact-input quote", quoteInput),
    async (request) => {
      // Eligibility is decided before any catalogue lookup, so an ineligible caller cannot
      // probe which symbols exist. Fastify's own schema check still runs ahead of this and
      // answers 400 on a malformed body; that ordering is inherited, not chosen here.
      requireEligible(request);
      const input = quoteInput.parse(request.body);
      const asset = deps.assets.find((a) => a.symbol === input.symbol);
      if (!asset)
        throw new Problem(
          400,
          "unknown-asset",
          "Unknown asset",
          "Choose an asset from the catalogue.",
        );
      const quote = await deps.chain.quote(asset, input.side, input.amount, input.slippage_bps);
      // The router already rejects fills more than 5% from the Chainlink reference, so with
      // BaseReader this re-check never fires. It exists because this response is what a human
      // signs against: a reader that ever returned the tick-spacing-200 AAPLc pool's $37,861
      // print must not get it rendered as a price.
      const checked = priceCheck(
        asset,
        input.side,
        quote.amount_in,
        quote.amount_out,
        quote.reference,
      );
      if (!checked)
        throw Problem.unavailable(
          "The quote could not be checked against a verified reference price.",
        );
      if (!checked.within)
        throw new Problem(
          503,
          "quote-deviation",
          "Quote rejected",
          `The venue price is ${checked.deviation_bps} bps from the reference price, beyond the ${DEVIATION_LIMIT_BPS} bps limit. No usable route is available at this size.`,
        );
      return {
        ...quote,
        symbol: asset.symbol,
        decimals: asset.decimals,
        price: checked.price,
        deviation_bps: checked.deviation_bps,
      };
    },
  );
}
