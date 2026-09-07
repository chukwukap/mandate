import {
  type Asset,
  type BalanceReader,
  type ChainReader,
  type Hex,
  type Identity,
  type MarketFeed,
  type PermissionCheck,
  type PermissionPayload,
  type Position,
  Problem,
  type Quote,
  type WalletBalances,
} from "../../../packages/contracts/src/index.js";
import { assessRound } from "../../../packages/evm/src/feeds/staleness.js";
import { permissionHash } from "../../../packages/evm/src/permissions/index.js";
import { minOut, selectRoute } from "../../../packages/evm/src/venues/sanity.js";
import { Money, units, whole } from "../../../packages/strategy/src/evaluation/money.js";
import {
  B20_ASSETS,
  FEED_DECIMALS,
  type FixtureAsset,
  plainAsset,
  USDC,
  USDC_DECIMALS,
} from "./catalogue.js";
import {
  type BalanceSheet,
  balanceKey,
  balanceOf,
  balanceString,
  DEFAULT_BALANCES,
  tokenOf,
} from "./erc20.js";
import { CLOCKS, marketRounds, type RecordedRound } from "./feeds.js";
import { probesFor, splitProbes } from "./quotes.js";
import { RECEIPTS, type ReceiptFixture } from "./receipts.js";

/**
 * A deterministic stand-in for `BaseReader`, driven entirely by recorded fixtures.
 *
 * It implements `ChainReader`, so anything that takes the real reader — the market snapshot
 * service, the API routes, the worker's observation port — takes this instead with no change.
 * It never opens a socket.
 *
 * The important design choice: this fake does NOT hardcode its answers. Feed ages go through
 * the production `assessRound`, route selection goes through the production `selectRoute`, and
 * the slippage floor goes through the production `minOut`. A fixture that decided for itself
 * that the tick-spacing-200 pool is bad would keep passing after `selectRoute` stopped
 * refusing it, which is precisely the regression these fixtures exist to catch. Recorded chain
 * data in, real decisions out.
 */

/** Everything the fake knows about one spend permission. */
export type PermissionState = {
  readonly payload: PermissionPayload;
  readonly approved: boolean;
  readonly revoked: boolean;
  /** The signature that verifies against this payload. Any other signature is rejected. */
  readonly signature?: Hex;
};

/** A message signature the fake will accept. Matched on all three fields, case-insensitively. */
export type MessageSignature = {
  readonly address: Hex;
  readonly message: string;
  readonly signature: Hex;
};

export type ChainFaults = {
  /** The RPC endpoint is unreachable: `ready()` is false and `market()` degrades wholesale. */
  readonly network?: boolean;
  /**
   * The quoter answers nothing. Distinct from a pool that reverts, and the distinction is the
   * point: one is a degraded dependency, the other is an absent pair.
   */
  readonly quoter?: "upstream";
  /** Symbols whose feed cannot be read at all, as opposed to read and found stale. */
  readonly feeds?: readonly string[];
};

export type FakeChainOptions = {
  /** Injected clock in ms. Defaults to the fixed trading-hours instant, never `Date.now`. */
  readonly now?: () => number;
  readonly assets?: readonly FixtureAsset[];
  /** Recorded rounds keyed by lowercased feed address. Defaults to a fresh whole market. */
  readonly rounds?: ReadonlyMap<string, RecordedRound>;
  readonly balances?: BalanceSheet;
  readonly receipts?: readonly ReceiptFixture[];
  readonly permissions?: readonly PermissionState[];
  readonly signatures?: readonly MessageSignature[];
  readonly walletKinds?: Readonly<Record<string, Identity["walletKind"]>>;
  readonly faults?: ChainFaults;
};

/** What the fake was asked to do. Assert on it when the question is "was this cached?". */
export type ChainCalls = {
  ready: number;
  market: number;
  quote: { symbol: string; side: "buy" | "sell"; amount: string }[];
  verifyMessage: number;
  verifyPermission: number;
  permissionStatus: number;
  walletKind: number;
};

/** The size `GET /v1/market` probes tradability with, mirrored so `dex:` prices line up. */
const DEX_PROBE_USDC = "10";
const DEX_PROBE_SLIPPAGE_BPS = 50;

/** BaseReader's own input bounds, restated so the fake refuses exactly what the reader refuses. */
const AMOUNT_PATTERN = /^\d{1,30}(\.\d{1,18})?$/;
const MIN_SLIPPAGE_BPS = 1;
const MAX_SLIPPAGE_BPS = 500;

export class FakeChainClient implements ChainReader, BalanceReader {
  readonly calls: ChainCalls = {
    ready: 0,
    market: 0,
    quote: [],
    verifyMessage: 0,
    verifyPermission: 0,
    permissionStatus: 0,
    walletKind: 0,
  };
  private readonly assets: readonly FixtureAsset[];
  private readonly rounds: Map<string, RecordedRound>;
  private readonly sheet: BalanceSheet;
  private readonly receipts: readonly ReceiptFixture[];
  private readonly permissions = new Map<string, PermissionState>();
  private readonly signatures: readonly MessageSignature[];
  private readonly walletKinds: Readonly<Record<string, Identity["walletKind"]>>;
  private faults: ChainFaults;
  private clock: number;

  constructor(options: FakeChainOptions = {}) {
    this.clock = options.now?.() ?? CLOCKS.tradingHours;
    this.assets = options.assets ?? B20_ASSETS;
    this.rounds = new Map(options.rounds ?? marketRounds({ observedAt: this.clock }));
    this.sheet = options.balances ?? new Map(DEFAULT_BALANCES);
    this.receipts = options.receipts ?? RECEIPTS;
    this.signatures = options.signatures ?? [];
    this.walletKinds = options.walletKinds ?? {};
    this.faults = options.faults ?? {};
    for (const permission of options.permissions ?? []) this.grant(permission);
  }

  /** Milliseconds since epoch, as this fake sees them. */
  now(): number {
    return this.clock;
  }

  /** Move the clock forward. Feed ages are measured against it, so this ages the whole market. */
  advance(ms: number): this {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Time only moves forward here");
    this.clock += ms;
    return this;
  }

  setNow(ms: number): this {
    this.clock = ms;
    return this;
  }

  setFaults(faults: ChainFaults): this {
    this.faults = faults;
    return this;
  }

  /** Replace one asset's recorded round without disturbing the rest of the market. */
  setRound(feed: Hex, round: RecordedRound): this {
    this.rounds.set(feed.toLowerCase(), round);
    return this;
  }

  grant(permission: PermissionState): this {
    this.permissions.set(permissionHash(permission.payload).toLowerCase(), permission);
    return this;
  }

  /** Revoke onchain, the way a user clicking "revoke" does: approved stays true, revoked flips. */
  revoke(payload: PermissionPayload): this {
    const key = permissionHash(payload).toLowerCase();
    const existing = this.permissions.get(key);
    this.permissions.set(key, { ...(existing ?? { payload, approved: true }), revoked: true });
    return this;
  }

  balance(token: Hex, holder: Hex): bigint {
    return balanceOf(this.sheet, holder, token);
  }

  /** Balance as a decimal string at the token's real scale — 8 for a B20 share, 6 for USDC. */
  balanceOf(token: Hex, holder: Hex): string {
    return whole(this.balance(token, holder), tokenOf(token).decimals);
  }

  receipt(hash: string): ReceiptFixture | undefined {
    return this.receipts.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
  }

  /**
   * Credit one holding, so a test can give an address a position to read back.
   *
   * DEFAULT_BALANCES is keyed to the fixed fixture accounts, but identities in the contract
   * harness get freshly generated wallets — without this, every portfolio test would be a test
   * of the empty case.
   */
  credit(holder: Hex, token: Hex, amount: string): void {
    this.sheet.set(balanceKey(holder, token), units(amount, tokenOf(token).decimals));
  }
  /**
   * Balances for an address, from the same sheet `balanceOf` reads.
   *
   * Shares the sheet on purpose rather than taking a second fixture: a test that credits an
   * account through the existing helpers must see the change here too, or the portfolio surface
   * would be testable only against numbers nothing else in the suite agrees with.
   */
  async balances(address: Hex, assets: readonly Asset[]): Promise<WalletBalances> {
    const positions: Position[] = assets.map((asset) => ({
      symbol: asset.symbol,
      token: asset.token,
      decimals: asset.decimals,
      // balanceString, not balanceOf: the raw integer is at the token's own scale, and every
      // B20 equity is 8 decimals. Publishing the integer would overstate a holding by 1e8.
      quantity: balanceString(this.sheet, address, asset.token),
    }));
    return { at: Date.now(), cash: balanceString(this.sheet, address, USDC), positions };
  }
  async ready(): Promise<boolean> {
    this.calls.ready += 1;
    return !this.faults.network;
  }

  async verifyMessage(address: Hex, message: string, signature: Hex): Promise<boolean> {
    this.calls.verifyMessage += 1;
    return this.signatures.some(
      (entry) =>
        entry.address.toLowerCase() === address.toLowerCase() &&
        entry.message === message &&
        entry.signature.toLowerCase() === signature.toLowerCase(),
    );
  }

  /**
   * A permission signature verifies only against the payload it was registered for.
   *
   * Registration is keyed by the EIP-712 digest, so mutating any field of the payload — a
   * larger allowance, a different spender — produces a different hash and the signature stops
   * verifying. That is the property the funding gate depends on, and a fake that answered
   * `true` unconditionally would hide the one check that makes a stored row untrustworthy.
   */
  async verifyPermission(payload: PermissionPayload, signature: Hex): Promise<boolean> {
    this.calls.verifyPermission += 1;
    const state = this.permissions.get(permissionHash(payload).toLowerCase());
    return (
      state?.signature !== undefined && state.signature.toLowerCase() === signature.toLowerCase()
    );
  }

  async walletKind(address: Hex): Promise<Identity["walletKind"]> {
    this.calls.walletKind += 1;
    return this.walletKinds[address.toLowerCase()] ?? "base_account";
  }

  async permissionStatus(payload: PermissionPayload): Promise<PermissionCheck> {
    this.calls.permissionStatus += 1;
    const state = this.permissions.get(permissionHash(payload).toLowerCase());
    return { approved: state?.approved ?? false, revoked: state?.revoked ?? false };
  }

  /**
   * The reference reading for one asset, or undefined when the feed cannot be read.
   *
   * Structural faults — a zero answer, an unanswered round, a future timestamp — come back as
   * undefined rather than propagating, because that is what an unreadable feed is: an absent
   * observation, not a crash in the caller.
   */
  private reference(
    asset: Asset,
  ): { value: string; updatedAt: number; stale: boolean } | undefined {
    if (this.faults.network) return undefined;
    if (this.faults.feeds?.includes(asset.symbol)) return undefined;
    const round = this.rounds.get(asset.feed.toLowerCase());
    if (!round) return undefined;
    try {
      const reading = assessRound({
        round,
        decimals: FEED_DECIMALS,
        nowSeconds: Math.floor(this.clock / 1000),
      });
      return { value: reading.value, updatedAt: reading.updatedAt, stale: reading.stale };
    } catch {
      return undefined;
    }
  }

  private known(asset: Asset): FixtureAsset | undefined {
    return this.assets.find(
      (entry) =>
        entry.token.toLowerCase() === asset.token.toLowerCase() &&
        entry.feed.toLowerCase() === asset.feed.toLowerCase() &&
        entry.symbol === asset.symbol &&
        entry.decimals === asset.decimals,
    );
  }

  async quote(
    asset: Asset,
    side: "buy" | "sell",
    amount: string,
    slippageBps: number,
  ): Promise<Quote> {
    this.calls.quote.push({ symbol: asset.symbol, side, amount });
    if (!this.known(asset))
      throw new Problem(400, "unknown-asset", "Unknown asset", "Choose a catalogue asset.");
    // A buy spends USDC and a sell sends shares, so the input scale flips with the side.
    // Getting this backwards is a 10^2 error on every order.
    const decimals = side === "buy" ? USDC_DECIMALS : asset.decimals;
    if (
      !AMOUNT_PATTERN.test(amount) ||
      (amount.split(".")[1]?.length ?? 0) > decimals ||
      !Number.isInteger(slippageBps) ||
      slippageBps < MIN_SLIPPAGE_BPS ||
      slippageBps > MAX_SLIPPAGE_BPS
    )
      throw new Problem(
        400,
        "invalid-amount",
        "Invalid quote amount",
        "Use a positive amount within the input token's precision and valid slippage.",
      );
    const amountIn = units(amount, decimals);
    if (amountIn === 0n)
      throw new Problem(400, "zero-amount", "Amount is zero", "Enter a positive amount.");
    const reference = this.reference(asset);
    if (!reference) throw Problem.unavailable("A verified reference price is unavailable.");
    if (reference.stale) throw Problem.unavailable("Reference price is too old for a quote.");

    const probes =
      this.faults.quoter === "upstream"
        ? [...probesFor({ symbol: asset.symbol, side, amountIn })].map(
            (probe) => ({ tickSpacing: probe.tickSpacing, kind: "upstream" }) as const,
          )
        : probesFor({ symbol: asset.symbol, side, amountIn });
    const { candidates, rejected } = splitProbes(probes);
    // selectRoute admits every candidate against the reference BEFORE comparing outputs, and
    // throws a 503 when nothing survives. Both behaviours are the real ones.
    const best = selectRoute({
      side,
      amountIn,
      assetDecimals: asset.decimals,
      reference: reference.value,
      candidates,
      rejected,
    }).best;
    const tokenIn = side === "buy" ? USDC : asset.token;
    const tokenOut = side === "buy" ? asset.token : USDC;
    return {
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: amountIn.toString(),
      amount_out: best.amountOut.toString(),
      min_out: minOut(best.amountOut, slippageBps).toString(),
      tick_spacing: best.tickSpacing,
      expires_at: new Date(this.clock + 20_000).toISOString(),
      reference: reference.value,
    };
  }

  /**
   * The `oracle:` and `dex:` observations, two per asset.
   *
   * Never throws. A degraded chain produces a degraded market — `{ value: null, updated_at: 0,
   * stale: true }` — because the market endpoint is the one page a user loads when something
   * looks wrong, and failing it wholesale tells them nothing.
   */
  async market(): Promise<MarketFeed[]> {
    this.calls.market += 1;
    const feeds: MarketFeed[] = [];
    for (const asset of this.assets) {
      const reference = this.reference(asset);
      if (!reference) {
        feeds.push(this.absent(asset, "oracle"), this.absent(asset, "dex"));
        continue;
      }
      feeds.push({
        uri: `oracle:${asset.symbol}`,
        value: reference.value,
        updated_at: reference.updatedAt,
        stale: reference.stale,
      });
      if (reference.stale) {
        // A stale reference cannot admit a route, so there is no venue price to publish.
        feeds.push(this.absent(asset, "dex"));
        continue;
      }
      try {
        const quote = await this.quote(
          plainAsset(asset),
          "buy",
          DEX_PROBE_USDC,
          DEX_PROBE_SLIPPAGE_BPS,
        );
        feeds.push({
          uri: `dex:${asset.symbol}`,
          value: dexPrice(DEX_PROBE_USDC, quote.amount_out, asset.decimals),
          updated_at: Math.floor(this.clock / 1000),
          stale: false,
        });
      } catch {
        // No route, or a route outside the reference band. The oracle reading above still
        // stands: "we cannot fill this" and "we cannot price this" are different failures.
        feeds.push(this.absent(asset, "dex"));
      }
    }
    return feeds;
  }

  private absent(asset: Asset, kind: "oracle" | "dex"): MarketFeed {
    return { uri: `${kind}:${asset.symbol}`, value: null, updated_at: 0, stale: true };
  }
}

/**
 * USDC per whole share implied by a probe, as a decimal string.
 *
 * Ten USDC over a share amount is a long quotient — around 75 fraction digits at the shared
 * 78-digit precision — and that is exactly what `BaseReader` publishes, so the strategy
 * evaluator's wider `FEED_PATTERN` accepts it. Rounding it to something prettier here would
 * make fixture prices and live prices two different kinds of number.
 */
function dexPrice(usdcIn: string, sharesOutRaw: string, decimals: number): string {
  const shares = new Money(whole(BigInt(sharesOutRaw), decimals));
  if (shares.lte(0)) throw new Error("A dex price needs a positive share amount");
  return new Money(usdcIn).div(shares).toFixed();
}
