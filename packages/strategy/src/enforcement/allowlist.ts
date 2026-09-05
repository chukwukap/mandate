import type { Asset, Envelope } from "../validation/schema.js";

/**
 * Positions are keyed by lowercase token address everywhere: the observer writes
 * them that way (apps/worker/src/chain.ts) and EIP-55 checksummed catalogue entries
 * would otherwise miss the balance and size every sell against zero. One normaliser
 * instead of an ad-hoc `.toLowerCase()` at each lookup.
 */
export function positionKey(token: string): string {
  return token.toLowerCase();
}

/**
 * The signed envelope is the allowlist. Plan actions address assets by integer
 * index into it, so this is the one place an index becomes a token: if the envelope
 * were ever rebuilt from symbols in a different order, every order would silently
 * retarget to a different stock. The token is checked, not just the index, so a
 * malformed entry cannot be routed.
 */
export function resolveAsset(envelope: Envelope, index: number): Asset {
  const asset = envelope.assets[index];
  if (!asset)
    throw new Error(
      `Asset ${index} is outside the signed allowlist of ${envelope.assets.length} asset(s)`,
    );
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset.token))
    throw new Error(`Signed allowlist entry ${index} has no usable token address`);
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36)
    throw new Error(`Signed allowlist entry ${asset.symbol} has unusable decimals`);
  return asset;
}
