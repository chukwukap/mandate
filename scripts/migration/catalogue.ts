import type { Asset } from "../../packages/contracts/src/index.js";
import { issue, Refused } from "./issues.js";

/**
 * Resolving legacy names against the catalogue this deployment actually trades.
 *
 * Nothing in a legacy row is trusted to describe an asset. The Rust `asset_registry` carried
 * its own `symbol`, `decimals` and `feed`, and copying those forward would import whatever
 * that table happened to believe — including a stale decimal count. Every B20 equity is 8
 * decimals; a row saying 18 misprices every order by 1e10, and it would do so silently,
 * because 18 is the number a reviewer's eye slides past. So the address is the only field
 * read as identity, everything else is taken from `@mandate/evm`'s `ASSETS`, and a
 * disagreement is a refusal rather than an overwrite: one of the two databases is wrong
 * about scale and a migration is not the place to decide which.
 */

/** CAIP-2 for Base mainnet. Legacy feed URIs and allowlist entries are namespaced by it. */
export const BASE_CAIP2 = "eip155:8453";

/** The two feed kinds the strategy grammar accepts, as `validatePlan` derives them. */
const FEED_KINDS = ["oracle", "dex"] as const;

/**
 * Find the catalogue entry for a legacy allowlist address.
 *
 * `legacyDecimals` is what the legacy row claimed. Pass `undefined` when the legacy row did
 * not record one — `allowlist_entry.decimals` is nullable — and the catalogue's value is
 * used without a cross-check, which is the best that can be done and is why the column is
 * optional rather than defaulted.
 */
export function resolveAsset(
  token: string,
  legacyDecimals: number | undefined,
  catalogue: readonly Asset[],
  subject: string,
): Asset {
  const wanted = token.toLowerCase();
  const found = catalogue.find((asset) => asset.token.toLowerCase() === wanted);
  if (!found)
    throw new Refused(
      issue(
        "asset.not-in-catalogue",
        subject,
        `${token} is not tradable in this deployment. The strategy names it by allowlist position, so it cannot be dropped from the list without repointing every later index.`,
      ),
    );
  if (legacyDecimals !== undefined && legacyDecimals !== found.decimals)
    throw new Refused(
      issue(
        "asset.decimals-disagree",
        subject,
        `The legacy registry records ${String(legacyDecimals)} decimals for ${found.symbol}, this deployment records ${String(found.decimals)}. One of them would misprice every order by 1e${String(Math.abs(legacyDecimals - found.decimals))}; resolve it before migrating.`,
      ),
    );
  return found;
}

/**
 * Translate a legacy feed URI into one this deployment publishes.
 *
 * Three forms are in the wild and they are not interchangeable:
 *
 *   `oracle:eip155:8453/AAPL`  the form the schema comment documents,
 *   `oracle:AAPL`              the form `mandate_evm::base` actually published, and
 *   `dex:AAPLc`                the form authoring promised.
 *
 * The Rust code carries a note about exactly this drift — the catalogue advertised
 * `oracle:AAPL` while authoring promised `oracle:AAPLc` — so a legacy plan may reference
 * either the bare ticker or the wrapped symbol, and `validatePlan` here accepts only
 * `oracle:<symbol>` / `dex:<symbol>` for a catalogued symbol. Hence the bare-ticker fallback.
 *
 * The chain prefix is checked rather than stripped. A plan referencing another chain's
 * oracle is not a naming difference, it is a different price, and quietly repointing it at
 * Base would change what the strategy watches while leaving the review card looking the same.
 */
export function translateFeed(uri: string, catalogue: readonly Asset[], subject: string): string {
  const separator = uri.indexOf(":");
  const kind = separator === -1 ? "" : uri.slice(0, separator);
  const rest = separator === -1 ? "" : uri.slice(separator + 1);
  if (!FEED_KINDS.includes(kind as (typeof FEED_KINDS)[number]) || rest.length === 0)
    throw new Refused(
      issue(
        "feed.unknown-kind",
        subject,
        `"${uri}" is not an oracle: or dex: feed; this deployment publishes no other kind.`,
      ),
    );
  const slash = rest.lastIndexOf("/");
  if (slash !== -1) {
    const chain = rest.slice(0, slash);
    if (chain !== BASE_CAIP2)
      throw new Refused(
        issue(
          "feed.foreign-chain",
          subject,
          `"${uri}" names chain ${chain}; this deployment only reads ${BASE_CAIP2} and must not silently substitute it.`,
        ),
      );
  }
  const named = rest.slice(slash + 1);
  return `${kind}:${resolveSymbol(named, catalogue, uri, subject)}`;
}

function resolveSymbol(
  named: string,
  catalogue: readonly Asset[],
  uri: string,
  subject: string,
): string {
  for (const candidate of [named, `${named}c`]) {
    const exact = catalogue.find((asset) => asset.symbol === candidate);
    if (exact) return exact.symbol;
    const folded = catalogue.filter(
      (asset) => asset.symbol.toLowerCase() === candidate.toLowerCase(),
    );
    // Two catalogue symbols differing only in case would make the fallback a coin flip
    // between two different tokens. It cannot happen with today's catalogue; it must not
    // become a silent mispoint if someone adds an entry that makes it possible.
    if (folded.length > 1)
      throw new Refused(
        issue(
          "feed.ambiguous-symbol",
          subject,
          `"${uri}" matches ${folded.map((a) => a.symbol).join(", ")} case-insensitively; the catalogue must not contain two symbols that differ only in case.`,
        ),
      );
    const single = folded[0];
    if (single) return single.symbol;
  }
  throw new Refused(
    issue(
      "feed.unknown-symbol",
      subject,
      `"${uri}" names ${named}, which this deployment does not publish a feed for. Tradable symbols: ${catalogue.map((a) => a.symbol).join(", ") || "(none)"}.`,
    ),
  );
}
