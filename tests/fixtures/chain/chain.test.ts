import { expect, test } from "bun:test";
import { Problem } from "../../../packages/contracts/src/index.js";
import { ASSETS } from "../../../packages/evm/src/addresses/index.js";
import { MAX_FEED_AGE_SECONDS } from "../../../packages/evm/src/feeds/staleness.js";
import {
  deviationBps,
  impliedPrice,
  minOut,
  SANITY_BAND_BPS,
  selectRoute,
} from "../../../packages/evm/src/venues/sanity.js";
import { units } from "../../../packages/strategy/src/evaluation/money.js";
import {
  ACCOUNTS,
  AGES,
  assetOf,
  B20_ASSETS,
  CLOCKS,
  confirmationsOf,
  creditedTo,
  DECIMALS_TRAP,
  FakeChainClient,
  feedOf,
  marketRounds,
  NAV_USD,
  NVDA_SPLIT_MULTIPLIER,
  ORDER,
  plainAsset,
  quoteOf,
  readingOf,
  receiptOf,
  reorged,
  roundAt,
  splitProbes,
  USDC,
} from "./index.js";

const AAPL = assetOf("AAPLc");

function admitted(id: string) {
  const fixture = quoteOf(id);
  const { candidates, rejected } = splitProbes(fixture.probes);
  return {
    fixture,
    candidates,
    rejected,
    select: () =>
      selectRoute({
        side: fixture.side,
        amountIn: fixture.amountIn,
        assetDecimals: assetOf(fixture.symbol).decimals,
        reference: fixture.reference,
        candidates,
        rejected,
      }),
  };
}

test("the fixture catalogue and the shipped catalogue cannot drift apart", () => {
  const shipped = B20_ASSETS.filter((asset) => asset.shipped).map(plainAsset);
  // Same four, same addresses, same 8 decimals. If packages/evm adds MSFTc tomorrow this
  // fails, and it should: the "untradable asset" fixtures below rest on it being absent.
  expect(shipped).toEqual([...ASSETS]);
  expect(B20_ASSETS.filter((asset) => !asset.shipped).map((asset) => asset.symbol)).toEqual([
    "MSFTc",
    "AMZNc",
    "TSLAc",
  ]);
  for (const asset of B20_ASSETS) expect(asset.decimals).toBe(8);
  // Every token and feed address is distinct: two entries sharing either would make one
  // position spend another's balance, or two symbols read one price.
  expect(new Set(B20_ASSETS.map((a) => a.token.toLowerCase())).size).toBe(B20_ASSETS.length);
  expect(new Set(B20_ASSETS.map((a) => a.feed.toLowerCase())).size).toBe(B20_ASSETS.length);
});

test("8 decimals, not 18: the same integer is two positions ten orders of magnitude apart", () => {
  expect(units(DECIMALS_TRAP.shares, DECIMALS_TRAP.correctDecimals)).toBe(
    DECIMALS_TRAP.rawAtCorrect,
  );
  expect(units(DECIMALS_TRAP.shares, DECIMALS_TRAP.wrongDecimals)).toBe(DECIMALS_TRAP.rawAtWrong);
  expect(DECIMALS_TRAP.rawAtWrong / DECIMALS_TRAP.rawAtCorrect).toBe(DECIMALS_TRAP.factor);
  // Priced at the wrong scale the fill looks 1e10 cheaper, which is how an order gets sized
  // ten billion times too large before anything on chain has a chance to refuse it.
  const right = impliedPrice({
    side: "buy",
    amountIn: 10_000_000n,
    amountOut: 3_122_852n,
    assetDecimals: 8,
  });
  const wrong = impliedPrice({
    side: "buy",
    amountIn: 10_000_000n,
    amountOut: 3_122_852n,
    assetDecimals: 18,
  });
  expect(right.startsWith("320.22")).toBe(true);
  expect(Number(wrong) / Number(right)).toBeCloseTo(1e10, -5);
});

test("the spacing-200 trap is refused on a buy AND on a sell", () => {
  const buy = admitted("aaplc-buy-10-usdc");
  expect(buy.select().best.tickSpacing).toBe(10);
  const sell = admitted("aaplc-sell-1-share");
  const selection = sell.select();
  expect(selection.best.tickSpacing).toBe(10);
  expect(selection.best.amountOut).toBe(320_220_000n);

  // The sell is the dangerous direction: unfiltered, max output picks the trap outright.
  const byOutput = [...sell.candidates].sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  expect(byOutput[0]?.tickSpacing).toBe(200);
  expect(byOutput[0]?.amountOut).toBe(37_861_000_000n);

  const trap = selection.rejected.find((r) => r.tickSpacing === 200);
  expect(trap?.reason).toBe("outside-band");
  // 11,729%. The measured magnitude, not a round number chosen to pass.
  expect(trap?.deviationBps ?? 0).toBeGreaterThan(1_172_000);
  expect(deviationBps("37861", "320.08")).toBeGreaterThan(1_172_000);
});

test("real price impact is admitted while the trap is not", () => {
  const selection = admitted("aaplc-buy-100k-usdc").select();
  expect(selection.best.tickSpacing).toBe(10);
  // A $100k order moves the healthy pool 0.17%: 21 bps from NAV, against a 500 bps band.
  expect(selection.best.deviationBps).toBeLessThan(SANITY_BAND_BPS);
  expect(selection.best.deviationBps).toBeGreaterThan(20);
  expect(selection.admitted).toHaveLength(1);
});

test("two live pools make selection a real comparison, not a lone survivor", () => {
  const selection = admitted("nvdac-buy-10-usdc").select();
  expect(selection.admitted.map((route) => route.tickSpacing)).toEqual([100, 2000]);
  // Both are inside the band; the better price wins on output.
  expect(selection.best.tickSpacing).toBe(100);
  expect(selection.best.amountOut).toBe(5_622_399n);
});

test("an absent pair and an unreachable RPC are different 503s", () => {
  expect(() => admitted("msftc-buy-10-usdc").select()).toThrow(/has liquidity/);
  expect(() => admitted("aaplc-buy-10-usdc-rpc-down").select()).toThrow(/could not be reached/);
  // Both are 503, and conflating them sends an operator hunting a healthy pool.
  for (const id of ["msftc-buy-10-usdc", "aaplc-buy-10-usdc-rpc-down"]) {
    try {
      admitted(id).select();
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(Problem);
      expect((error as Problem).status).toBe(503);
    }
  }
});

test("off-hours staleness: 15h is fine, a weekend is not", () => {
  expect(readingOf(feedOf("aaplc-fresh")).stale).toBe(false);
  const evening = readingOf(feedOf("aaplc-weekday-evening"));
  // 15.07h, measured. A five-minute freshness rule would refuse this and every other
  // overnight order, on feeds that only publish on deviation or heartbeat.
  expect(evening.ageSeconds).toBe(AGES.weekdayEvening);
  expect(evening.stale).toBe(false);
  expect(readingOf(feedOf("aaplc-at-bound")).ageSeconds).toBe(MAX_FEED_AGE_SECONDS);
  expect(readingOf(feedOf("aaplc-at-bound")).stale).toBe(false);
  expect(readingOf(feedOf("aaplc-past-bound")).stale).toBe(true);
  // 64h. The 26h bound halts the whole weekend on a token that trades 24/7 — recorded here
  // so the trade-off is a decision someone made, not a surprise on a Saturday.
  const weekend = readingOf(feedOf("aaplc-weekend"));
  expect(weekend.ageSeconds).toBe(AGES.weekend);
  expect(weekend.stale).toBe(true);
});

test("each structural feed fault is refused for its own reason", () => {
  const cases: [string, RegExp][] = [
    ["aaplc-zero-answer", /non-positive price/],
    ["aaplc-unanswered", /unanswered round/],
    ["aaplc-future", /future timestamp/],
    ["aaplc-carried-over", /carried-over answer/],
  ];
  for (const [id, message] of cases) expect(() => readingOf(feedOf(id))).toThrow(message);
});

test("the total-return multiplier is already inside the answer", () => {
  const nav = readingOf(feedOf("nvdac-total-return")).value;
  expect(nav).toBe("177.85");
  expect(NAV_USD.NVDAc).toBe(nav);
  // As published, the venue sits half a basis point away and fills.
  const honest = admitted("nvdac-buy-10-usdc");
  expect(honest.select().best.deviationBps).toBeLessThan(1);
  // Apply the split multiplier a second time and the same healthy pool reads ~8,999 bps
  // below its own reference — 18x the sanity band — so a good market stops trading.
  const doubled = (Number(nav) * Number(NVDA_SPLIT_MULTIPLIER)).toFixed(2);
  expect(() =>
    selectRoute({
      side: "buy",
      amountIn: honest.fixture.amountIn,
      assetDecimals: 8,
      reference: doubled,
      candidates: honest.candidates,
      rejected: honest.rejected,
    }),
  ).toThrow(/reference price/);
  expect(deviationBps("177.86", doubled)).toBeGreaterThan(8_999);
  expect(deviationBps("177.86", doubled)).toBeGreaterThan(SANITY_BAND_BPS * 17);
});

test("a receipt's status is not the same thing as settlement", () => {
  const fund = receiptOf("fund-confirmed");
  const funded = fund.receipt;
  if (!funded) throw new Error("fund-confirmed must carry a receipt");
  expect(
    creditedTo(funded, { token: USDC, recipient: ACCOUNTS.spender, from: ACCOUNTS.user }),
  ).toBe(ORDER.amountInUsdc);
  expect(confirmationsOf(fund)).toBe(7);
  expect(reorged(fund)).toBe(false);

  // Success, and the value went to someone else. Amount-only matching would call this funded.
  const stranger = receiptOf("fund-to-stranger").receipt;
  if (!stranger) throw new Error("fund-to-stranger must carry a receipt");
  expect(stranger.status).toBe("success");
  expect(creditedTo(stranger, { token: USDC, recipient: ACCOUNTS.spender })).toBe(0n);

  // Success, and under the signed floor.
  const under = receiptOf("swap-underfilled").receipt;
  if (!under) throw new Error("swap-underfilled must carry a receipt");
  expect(creditedTo(under, { token: ORDER.token, recipient: ACCOUNTS.user })).toBeLessThan(
    ORDER.minOutShares,
  );
  const filled = receiptOf("swap-confirmed").receipt;
  if (!filled) throw new Error("swap-confirmed must carry a receipt");
  expect(
    creditedTo(filled, { token: ORDER.token, recipient: ACCOUNTS.user }),
  ).toBeGreaterThanOrEqual(ORDER.minOutShares);
  // The swap also moves USDC out of the spender; that leg must not be counted as the fill.
  expect(creditedTo(filled, { token: USDC, recipient: ACCOUNTS.user })).toBe(0n);

  // Success, one block deep, and orphaned respectively.
  expect(confirmationsOf(receiptOf("swap-unconfirmed"))).toBe(1);
  expect(reorged(receiptOf("fund-reorged"))).toBe(true);
  expect(receiptOf("swap-reverted").receipt?.status).toBe("reverted");
});

test("a missing receipt is pending or ambiguous depending on the nonce, never confirmed", () => {
  const pending = receiptOf("fund-pending");
  expect(pending.receipt).toBeNull();
  expect(pending.signerNonce).toBe(pending.nonce);
  const replaced = receiptOf("fund-replaced");
  expect(replaced.receipt).toBeNull();
  // The nonce is spent by something this process cannot account for. Inferring success from
  // a spent nonce is how a never-mined order gets marked filled.
  expect(replaced.signerNonce).toBeGreaterThan(replaced.nonce);
});

test("the fake reader quotes through the real route selection", async () => {
  const chain = new FakeChainClient();
  const quote = await chain.quote(plainAsset(AAPL), "buy", "10", 50);
  expect(quote).toEqual({
    token_in: USDC,
    token_out: AAPL.token,
    amount_in: "10000000",
    amount_out: "3122852",
    min_out: minOut(3_122_852n, 50).toString(),
    tick_spacing: 10,
    expires_at: new Date(CLOCKS.tradingHours + 20_000).toISOString(),
    reference: "320.08",
  });
  expect(chain.calls.quote).toEqual([{ symbol: "AAPLc", side: "buy", amount: "10" }]);
});

test("the fake reader refuses exactly what BaseReader refuses", async () => {
  const chain = new FakeChainClient();
  const asset = plainAsset(AAPL);
  const rejects = async (work: Promise<unknown>, status: number, code: string) => {
    try {
      await work;
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(Problem);
      expect((error as Problem).status).toBe(status);
      expect((error as Problem).code).toBe(code);
    }
  };
  await rejects(chain.quote({ ...asset, decimals: 18 }, "buy", "10", 50), 400, "unknown-asset");
  // A buy is denominated in USDC's six decimals; seven is not representable.
  await rejects(chain.quote(asset, "buy", "10.0000001", 50), 400, "invalid-amount");
  await rejects(chain.quote(asset, "buy", "10", 0), 400, "invalid-amount");
  await rejects(chain.quote(asset, "buy", "10", 501), 400, "invalid-amount");
  await rejects(chain.quote(asset, "buy", "0", 50), 400, "zero-amount");
  // A sell is denominated in the share's eight decimals, so the same string is fine there.
  expect((await chain.quote(asset, "sell", "1.00000001", 50)).token_in).toBe(AAPL.token);
});

test("a weekend market cannot quote, and says so as a reference problem", async () => {
  const weekend = new FakeChainClient({
    now: () => CLOCKS.weekend,
    rounds: marketRounds({ observedAt: CLOCKS.weekend, ageSeconds: AGES.weekend }),
  });
  try {
    await weekend.quote(plainAsset(AAPL), "buy", "10", 50);
    throw new Error("expected a refusal");
  } catch (error) {
    expect((error as Problem).status).toBe(503);
    expect((error as Error).message).toMatch(/too old/);
  }
  const feeds = await weekend.market();
  const oracle = feeds.find((feed) => feed.uri === "oracle:AAPLc");
  // The oracle reading is still published — with its real timestamp and stale: true — so a
  // user can see WHY nothing is tradable instead of an empty page.
  expect(oracle?.value).toBe("320.08");
  expect(oracle?.stale).toBe(true);
  expect(feeds.find((feed) => feed.uri === "dex:AAPLc")).toEqual({
    uri: "dex:AAPLc",
    value: null,
    updated_at: 0,
    stale: true,
  });
});

test("a tradable asset and an untradable one are told apart by the dex feed, not the oracle", async () => {
  const feeds = await new FakeChainClient().market();
  expect(feeds).toHaveLength(B20_ASSETS.length * 2);
  const msftOracle = feeds.find((feed) => feed.uri === "oracle:MSFTc");
  const msftDex = feeds.find((feed) => feed.uri === "dex:MSFTc");
  // A live reference and no route at any spacing. Reporting this as "no reference price"
  // would send a user looking at Chainlink for a liquidity problem.
  expect(msftOracle?.value).toBe(NAV_USD.MSFTc);
  expect(msftOracle?.stale).toBe(false);
  expect(msftDex?.value).toBeNull();
  const aaplDex = feeds.find((feed) => feed.uri === "dex:AAPLc");
  expect(aaplDex?.value?.startsWith("320.22")).toBe(true);
  expect(aaplDex?.stale).toBe(false);
});

test("a degraded RPC degrades the market instead of failing it", async () => {
  const down = new FakeChainClient({ faults: { network: true } });
  expect(await down.ready()).toBe(false);
  const feeds = await down.market();
  expect(feeds).toHaveLength(B20_ASSETS.length * 2);
  expect(feeds.every((feed) => feed.value === null && feed.stale)).toBe(true);

  // A quoter that never answers is not an absent pool, and the message has to say so.
  const rateLimited = new FakeChainClient({ faults: { quoter: "upstream" } });
  try {
    await rateLimited.quote(plainAsset(AAPL), "buy", "10", 50);
    throw new Error("expected a refusal");
  } catch (error) {
    expect((error as Error).message).toMatch(/could not be reached/);
  }
  // One broken feed must not blank the other six.
  const oneBad = new FakeChainClient({ faults: { feeds: ["AAPLc"] } });
  const partial = await oneBad.market();
  expect(partial.find((feed) => feed.uri === "oracle:AAPLc")?.value).toBeNull();
  expect(partial.find((feed) => feed.uri === "oracle:NVDAc")?.value).toBe(NAV_USD.NVDAc);
});

test("the fake has no hidden clock: the same fixtures give byte-identical answers", async () => {
  const first = await new FakeChainClient().market();
  const second = await new FakeChainClient().market();
  expect(first).toEqual(second);
  // Ageing the clock ages the market, and nothing else does.
  const aged = new FakeChainClient();
  aged.advance(AGES.weekend * 1000);
  expect((await aged.market()).find((feed) => feed.uri === "oracle:AAPLc")?.stale).toBe(true);
  expect(() => aged.advance(-1)).toThrow();
});

test("balances are read at each token's own scale", () => {
  const chain = new FakeChainClient();
  expect(chain.balanceOf(USDC, ACCOUNTS.user)).toBe("2500");
  expect(chain.balance(USDC, ACCOUNTS.user)).toBe(2_500_000_000n);
  expect(chain.balanceOf(AAPL.token, ACCOUNTS.user)).toBe("5");
  expect(chain.balance(AAPL.token, ACCOUNTS.user)).toBe(500_000_000n);
  // The spender holds nothing between orders; a resting balance there means a stranded fund.
  expect(chain.balance(USDC, ACCOUNTS.spender)).toBe(0n);
  expect(chain.balanceOf(AAPL.token, ACCOUNTS.stranger)).toBe("0");
});

test("a permission signature verifies against its payload and nothing else", async () => {
  const payload = {
    account: ACCOUNTS.user,
    spender: ACCOUNTS.spender,
    token: USDC,
    allowance: "250000000",
    period: 86_400,
    start: Math.floor(CLOCKS.tradingHours / 1000) - 60,
    end: Math.floor(CLOCKS.tradingHours / 1000) + 86_400,
    salt: "1",
    extraData: "0x" as const,
  };
  const signature = `0x${"cd".repeat(65)}` as const;
  const chain = new FakeChainClient({
    permissions: [{ payload, approved: true, revoked: false, signature }],
  });
  expect(await chain.verifyPermission(payload, signature)).toBe(true);
  expect(await chain.permissionStatus(payload)).toEqual({ approved: true, revoked: false });
  // Widen the allowance and the digest changes, so the signature stops verifying and the
  // permission is unknown onchain. That is the whole security property of the grant.
  const widened = { ...payload, allowance: "999000000" };
  expect(await chain.verifyPermission(widened, signature)).toBe(false);
  expect(await chain.permissionStatus(widened)).toEqual({ approved: false, revoked: false });
  chain.revoke(payload);
  expect(await chain.permissionStatus(payload)).toEqual({ approved: true, revoked: true });
});

test("a fixture round can be aged without rewriting the market", () => {
  const chain = new FakeChainClient();
  chain.setRound(
    AAPL.feed,
    roundAt({ price: "320.08", observedAt: CLOCKS.tradingHours, ageSeconds: AGES.pastBound }),
  );
  return chain.market().then((feeds) => {
    expect(feeds.find((feed) => feed.uri === "oracle:AAPLc")?.stale).toBe(true);
    expect(feeds.find((feed) => feed.uri === "oracle:GOOGLc")?.stale).toBe(false);
  });
});
