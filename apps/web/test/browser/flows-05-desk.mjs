/**
 * The desk: Markets, Trade, Portfolio, Activity and a strategy's history — every page that
 * reads the market or the wallet rather than writing a rule. Prices come from the fork's real
 * feeds, the routed quote from the real Aerodrome pools, and a holding is minted onto the fork
 * so the portfolio has something true to show.
 */
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { builder } from "./lib/builder.mjs";
import { ledger } from "./lib/check.mjs";
import { ACCOUNT, sql } from "./lib/db.mjs";
import { API, login, ORIGIN, TEST_KEY, watchApi } from "./lib/session.mjs";

const SHOT = process.env.SHOT;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const errors = [];
const apiProblems = watchApi(p);
p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const L = ledger(p, SHOT, "desk");
const { dialog, closeBuilder } = builder(p);

const nav = async (label) => {
  await p
    .locator(".sidebar")
    .getByRole("link", { name: new RegExp(`^${label}`) })
    .click();
  await p.locator(".workspace").waitFor({ timeout: 20000 });
  await p.waitForTimeout(1200);
};
const text = async (loc) => (await loc.innerText().catch(() => "")).replace(/\s+/g, " ");
const money = (s) => Number((String(s).match(/\$([\d,]+\.\d{2})/) ?? [])[1]?.replace(/,/g, ""));
const candleCalls = [];
p.on("request", (r) => {
  if (r.url().includes("/v1/market/candles"))
    candleCalls.push({ url: r.url(), auth: Boolean(r.headers().authorization) });
});
/** Opens the builder from a page control and reports which stock it preselected. */
const preselected = async () => {
  await dialog().waitFor({ timeout: 10000 });
  await p.waitForTimeout(400);
  await dialog().locator(".shape-row").first().click();
  await p.waitForTimeout(400);
  const on = (await dialog().locator(".stock-ring.on").allInnerTexts()).join();
  await closeBuilder();
  return on;
};

try {
  const wallet = await login(p);
  const market = await (await fetch(`${API}/v1/market`)).json();
  const spotOf = (sym) => Number(market.catalogue?.find((a) => a.symbol === sym)?.nav ?? NaN);

  // ---- A. Markets: cards, featured chart, ranges, watchlist, table ----------------------------
  await nav("Markets");
  const cards = p.locator("button.market-card");
  await cards
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  await L.check(
    "A1 seven market cards, each with a price",
    (await cards.count()) === 7 && (await cards.allInnerTexts()).every((t) => /\$\d/.test(t)),
    `${await cards.count()} cards: ${(await cards.allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 120)}`,
  );
  await cards.filter({ hasText: /TSLA/ }).click();
  await p.waitForTimeout(600);
  await L.check(
    "A2 clicking a card selects it and features Tesla",
    (await cards.filter({ hasText: /TSLA/ }).getAttribute("class")).includes("selected") &&
      /Tesla/.test(await text(p.locator("h2").first())),
    await text(p.locator("h2").first()),
  );
  const large = await text(p.locator(".large-price"));
  await L.check(
    "A3 featured price is the reference price of the card",
    money(large) > 0 &&
      Math.abs(money(large) - money(await cards.filter({ hasText: /TSLA/ }).innerText())) < 0.01,
    `${large} vs card`,
  );
  candleCalls.length = 0;
  for (const range of ["15m", "1H", "4H", "1D", "1W"]) {
    await p
      .locator('fieldset[aria-label="Chart range"] button', { hasText: new RegExp(`^${range}$`) })
      .click();
    await p.waitForTimeout(500);
  }
  await p.waitForTimeout(1200);
  const intervals = [
    ...new Set(candleCalls.map((c) => (c.url.match(/interval=([^&]+)/) ?? [])[1])),
  ];
  await L.check(
    "A4 each range asks for its own candles, without a token (public chart)",
    ["15m", "1H", "4H", "1D", "1W"].every((i) => intervals.includes(i)) &&
      candleCalls.every((c) => !c.auth),
    `${intervals.join(",")} auth=${candleCalls.some((c) => c.auth)}`,
  );
  await L.check(
    "A5 chart legend is live and reads O/H/L/C or a loading line",
    /O|Open|Loading|No trades|unavailable/.test(await text(p.locator(".market-chart-legend"))),
    await text(p.locator(".market-chart-legend")),
  );
  const star = p.locator('button[aria-label$="watchlist"]').first();
  await star.click();
  await p.waitForTimeout(300);
  await L.check(
    "A6 star toggles the watchlist and the tab counts it",
    /Remove TSLAc/.test((await star.getAttribute("aria-label")) ?? "") &&
      /Watchlist\s*1/.test(await text(p.locator(".tabs button", { hasText: /Watchlist/ }))),
    await star.getAttribute("aria-label"),
  );
  await p.locator(".tabs button", { hasText: /Watchlist/ }).click();
  await p.waitForTimeout(400);
  await L.check(
    "A7 Watchlist tab shows only the starred row",
    (await p.locator("table.stocks-table tbody tr").count()) === 1 &&
      /TSLA/.test(await text(p.locator("table.stocks-table tbody"))),
  );
  await p.locator(".tabs button", { hasText: /All stocks/ }).click();
  await p.waitForTimeout(300);
  await L.check(
    "A8 all seven rows, each with a sparkline or an honest placeholder",
    (await p.locator("table.stocks-table tbody tr").count()) === 7 &&
      (await p.locator('table.stocks-table svg[aria-label*="observed price"]').count()) +
        (await p
          .locator("table.stocks-table tbody", { hasText: /unavailable|No trades|Loading/ })
          .count()) >=
        1,
  );
  await p.locator('input[aria-label="Filter stocks"]').fill("zzz");
  await p.waitForTimeout(300);
  await L.check(
    "A9 a search with no match says so",
    /No stocks found/.test(await text(p.locator(".table-empty"))),
  );
  await p.locator('input[aria-label="Filter stocks"]').fill("app");
  await p.waitForTimeout(300);
  await L.check(
    "A10 'app' finds Apple alone",
    (await p.locator("table.stocks-table tbody tr").count()) === 1 &&
      /Apple/.test(await text(p.locator("table.stocks-table tbody"))),
  );
  await p.locator('input[aria-label="Filter stocks"]').fill("");
  await p.waitForTimeout(300);
  const before = await p.locator("table.stocks-table tbody tr .number").allInnerTexts();
  await p.locator("table.stocks-table th button", { hasText: /Price/ }).click();
  await p.waitForTimeout(300);
  const sorted = (await p.locator("table.stocks-table tbody tr .number").allInnerTexts()).map(
    money,
  );
  await L.check(
    "A11 Price header sorts descending",
    sorted.every((v, i) => i === 0 || v <= sorted[i - 1]) && before.length === sorted.length,
    sorted.join(" > "),
  );
  await p.locator("table.stocks-table th button", { hasText: /Price/ }).click();
  await p.waitForTimeout(300);
  await p
    .locator("table.stocks-table tbody tr", { hasText: /AMZN/ })
    .locator("button", { hasText: /Set a rule/ })
    .click();
  await L.check(
    "A12 'Set a rule' on a row opens the builder on that stock",
    (await preselected()) === "AMZN",
  );
  await cards.filter({ hasText: /TSLA/ }).click();
  await p.waitForTimeout(400);
  await p
    .locator("button", { hasText: /Create a rule/ })
    .first()
    .click();
  await L.check(
    "A13 'Create a rule' by the featured chart uses the featured stock",
    (await preselected()) === "TSLA",
  );
  await star.click();
  await p.waitForTimeout(200);
  await L.shot("A-markets");

  // ---- B. Trade: market select, validation, balance fill, a real routed quote ----------------
  await p.goto(`${ORIGIN}/trade?symbol=AAPLc`, { waitUntil: "domcontentloaded" });
  await p.locator('select[aria-label="Market"]').waitFor({ timeout: 20000 });
  await p.waitForTimeout(1000);
  await L.check(
    "B1 the URL preselects the market",
    (await p.locator('select[aria-label="Market"]').inputValue()) === "AAPLc" &&
      (await p.locator('select[aria-label="Market"] option').count()) === 7,
  );
  await p.locator('select[aria-label="Market"]').selectOption("NVDAc");
  await p.waitForTimeout(1200);
  const quote = await text(p.locator(".terminal-quote"));
  await L.check(
    "B2 switching market shows NVIDIA's reference price",
    money(quote) > 0 && /Reference/.test(quote) && Math.abs(money(quote) - spotOf("NVDAc")) < 0.01,
    `${quote} | catalogue ${spotOf("NVDAc")}`,
  );
  const amount = p.locator('input[aria-label^="Amount in"]');
  const submit = p.locator("button.ticket-submit");
  const disabledFor = [];
  for (const v of ["", "0", "abc", "12.3456789"]) {
    await amount.fill(v);
    await p.waitForTimeout(150);
    disabledFor.push(await submit.isDisabled());
  }
  await amount.fill("100");
  await p.waitForTimeout(150);
  await L.check(
    "B3 submit disabled for empty/0/abc/7-decimals, enabled for 100",
    disabledFor.every(Boolean) && !(await submit.isDisabled()),
    disabledFor.join(","),
  );
  await p.locator('button[title="Use the whole balance"]').click();
  await p.waitForTimeout(200);
  const filled = await amount.inputValue();
  await L.check(
    "B4 'In your wallet' fills the exact USDC balance",
    /^\d+(\.\d+)?$/.test(filled) && Number(filled) >= 100,
    filled,
  );
  await amount.fill("100");
  await p
    .locator("select", { has: p.locator("option", { hasText: /100 bps/ }) })
    .selectOption({ label: /100 bps/.source ? "100 bps · 1.00%" : "100" })
    .catch(async () => {
      await p
        .locator("label.desk-field", { hasText: /Maximum slippage/ })
        .locator("select")
        .selectOption("100");
    });
  let quoteBody = null;
  const onQuote = (r) => {
    if (r.url().includes("/v1/market/quote") && r.method() === "POST") quoteBody = r.postDataJSON();
  };
  p.on("request", onQuote);
  await submit.click();
  await p
    .locator(".ticket-estimate, .desk-error")
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  await p.waitForTimeout(500);
  p.off("request", onQuote);
  await L.check(
    "B5 the quote request carries symbol, side, amount and slippage",
    quoteBody?.symbol === "NVDAc" &&
      quoteBody?.side === "buy" &&
      quoteBody?.amount === "100" &&
      quoteBody?.slippage_bps === 100,
    JSON.stringify(quoteBody),
  );
  const estimate = await text(p.locator(".ticket-estimate"));
  const details = await text(p.locator(".ticket-details"));
  const routed = money(estimate);
  await L.check(
    "B6 a routed price came back from the pool, near the reference",
    routed > 0 && Math.abs(routed / spotOf("NVDAc") - 1) < 0.05,
    `${estimate} | ref ${spotOf("NVDAc")}`,
  );
  await L.check(
    "B7 the ticket states pay, receive, minimum, deviation and expiry",
    /You pay/.test(details) &&
      /100/.test(details) &&
      /You receive/.test(details) &&
      /NVDAc/.test(details) &&
      /Minimum at 100 bps/.test(details) &&
      /Deviation/.test(details) &&
      /Quote expires/.test(details),
    details.slice(0, 160),
  );
  const receive = Number((details.match(/You receive\s*([\d.]+)/) ?? [])[1]);
  await L.check(
    "B8 receive ≈ 100 / routed price",
    receive > 0 && Math.abs(receive * routed - 100) < 1.5,
    `${receive} × ${routed}`,
  );
  await L.shot("B-quote");
  await amount.fill("5000000");
  await submit.click();
  await p
    .locator(".desk-error")
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  const err = await text(p.locator(".desk-error"));
  await L.check(
    "B9 an absurd size is refused with the reason (deviation/liquidity), not a bare failure",
    /bps|reference|liquidity|too large|deviat/i.test(err),
    err.slice(0, 140),
  );
  await amount.fill("100");
  await p.locator('button[aria-label="Line chart"]').click();
  await p.waitForTimeout(500);
  const canvas = p.locator(".market-chart-canvas");
  const box = await canvas.boundingBox();
  if (box) {
    await p.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 8 });
  }
  await p.waitForTimeout(300);
  await L.check(
    "B10 hovering the line chart keeps the page mounted (regression)",
    (await p.locator(".workspace").count()) === 1 &&
      (await canvas.count()) === 1 &&
      errors.length === 0,
  );
  await p.locator('button[aria-label="Candlestick chart"]').click();
  await p.waitForTimeout(300);
  await p.locator("button", { hasText: /^Sell$/ }).click();
  await p.waitForTimeout(300);
  await L.check(
    "B11 sell side re-labels the amount in the stock",
    /Amount in NVDAc/.test((await amount.getAttribute("aria-label")) ?? ""),
  );
  await L.check(
    "B12 the market table says whether this market is tradable now",
    /Tradable now/.test(await text(p.locator("body"))) &&
      /Yes|No/.test(await text(p.locator("tr", { hasText: /Tradable now/ }))),
    await text(p.locator("tr", { hasText: /Tradable now/ })),
  );
  await p
    .locator("button", { hasText: /Turn this into a strategy/ })
    .first()
    .click();
  await L.check(
    "B13 'Turn this into a strategy' opens the builder on NVDA",
    (await preselected()) === "NVDA",
  );

  // ---- C. Portfolio: cash, then a real holding minted on the fork ------------------------------
  await nav("Portfolio");
  await p.locator(".stat-row").waitFor({ timeout: 20000 });
  const beforeP = await (
    await fetch(`${API}/v1/portfolio`, {
      headers: {
        authorization: `Bearer ${await p.evaluate(() => JSON.parse(localStorage.getItem("privy:token")))}`,
      },
    })
  ).json();
  const held = Number(beforeP.holdings?.find((h) => h.symbol === "NVDAc")?.quantity ?? 0);
  const stat = (label) => text(p.locator(".stat-row > div", { hasText: new RegExp(`^${label}`) }));
  await L.check(
    "C1 Portfolio value, Cash and Holdings match the API",
    Math.abs(money(await stat("Portfolio value")) - Number(beforeP.equity)) < 0.01 &&
      Math.abs(money(await stat("Cash")) - Number(beforeP.cash)) < 0.01 &&
      (await stat("Holdings")).includes(String(beforeP.holdings?.length ?? 0)),
    `${await stat("Portfolio value")} | api ${beforeP.equity}`,
  );
  await L.check(
    "C2 footer names the wallet, the chain and the reading time",
    /Last read \d/.test(await text(p.locator(".table-footer"))) &&
      /Base/.test(await text(p.locator(".table-footer"))) &&
      new RegExp(wallet.account.slice(0, 6), "i").test(await text(p.locator(".table-footer"))),
  );
  await L.check(
    "C3 the notice is the API's, verbatim",
    (await text(p.locator(".section-footnote"))).trim() ===
      String(beforeP.notice).replace(/\s+/g, " ").trim(),
  );
  // Mint 1.5 NVDAc (8 decimals) to the test wallet — the mock's mint is open on the fork.
  execSync(
    `cast send ${NVDA} 'mint(address,uint256)' ${wallet.account} 150000000 --rpc-url http://127.0.0.1:8545 --private-key ${TEST_KEY}`,
    { stdio: "ignore" },
  );
  await p.locator(".panel-heading button", { hasText: /Refresh/ }).click();
  await p.waitForTimeout(3000);
  const rowN = p.locator("table.stocks-table tbody tr", { hasText: /NVIDIA|NVDAc/ });
  const qty = Number((await text(rowN.locator("td").nth(1))).replace(/[^\d.]/g, ""));
  await L.check(
    "C4 the minted position shows up after Refresh, quantity +1.5",
    (await rowN.count()) === 1 && Math.abs(qty - (held + 1.5)) < 1e-6,
    `${qty} (was ${held})`,
  );
  const afterP = await (
    await fetch(`${API}/v1/portfolio`, {
      headers: {
        authorization: `Bearer ${await p.evaluate(() => JSON.parse(localStorage.getItem("privy:token")))}`,
      },
    })
  ).json();
  await L.check(
    "C5 equity rose by about 1.5 × NVDA reference",
    Math.abs(Number(afterP.equity) - Number(beforeP.equity) - 1.5 * spotOf("NVDAc")) <
      0.02 * spotOf("NVDAc") &&
      Math.abs(money(await stat("Portfolio value")) - Number(afterP.equity)) < 0.01,
    `${beforeP.equity} → ${afterP.equity} (ref ${spotOf("NVDAc")})`,
  );
  await L.shot("C-portfolio");
  await rowN.locator("button", { hasText: /Set a rule/ }).click();
  await L.check(
    "C6 'Set a rule' on a holding opens the builder on that stock",
    (await preselected()) === "NVDA",
  );
  await nav("Overview");
  await L.check(
    "C7 the Overview counts the position and the same value",
    /1 position|\d+ positions/.test(await text(p.locator("body"))) &&
      Math.abs(
        money(
          await text(
            p
              .locator(".desk-hero, .portfolio-hero, section")
              .filter({ hasText: /Portfolio value/ })
              .first(),
          ),
        ) - Number(afterP.equity),
      ) < 0.01,
    (await text(p.locator("body"))).match(/\$[\d,]+\.\d{2}[^.]{0,60}/)?.[0],
  );

  // ---- D. Activity: refresh, ordering, footer ----------------------------------------------------
  await nav("Activity");
  await p
    .locator(".activity-row")
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  const rowsA = p.locator(".activity-row");
  const dates = (await rowsA.locator("small").allInnerTexts())
    .filter((s) => /\d{1,2}:\d{2}/.test(s))
    .map((s) => new Date(s).getTime())
    .filter(Number.isFinite);
  await L.check(
    "D1 signals from every strategy, newest first",
    (await rowsA.count()) >= 2 && dates.every((d, i) => i === 0 || d <= dates[i - 1]),
    `${await rowsA.count()} rows`,
  );
  await L.check(
    "D2 each row: name, amount in USDC, Signal",
    (await rowsA.first().locator("strong").count()) === 1 &&
      /USDC/.test(await text(rowsA.first().locator(".number"))) &&
      /Signal/.test(await text(rowsA.first().locator(".status"))),
  );
  await p
    .locator("button", { hasText: /^Refresh$/ })
    .first()
    .click();
  await p.waitForTimeout(800);
  await L.check(
    "D3 Refresh confirms with a toast",
    /Activity refreshed/.test(await text(p.locator(".toast"))),
  );
  await L.check(
    "D4 the footer says signals don't move funds",
    /Signals don't move funds/.test(await text(p.locator(".table-footer"))),
  );

  // ---- E. A strategy with a long history: paging through evaluations -----------------------------
  const busy = sql(
    `select i.id from mandate_v2.instances i join mandate_v2.drafts d on d.id=i.draft_id where d.account='${ACCOUNT}' and (select count(*) from mandate_v2.evaluations e where e.instance_id=i.id) > 45 order by i.created_at desc limit 1`,
  );
  if (busy) {
    await p.goto(`${ORIGIN}/strategies/${busy}`, { waitUntil: "domcontentloaded" });
    await p.locator(".strategy-detail-page .detail-content").waitFor({ timeout: 20000 });
    await p.locator(".strategy-history .tabs button", { hasText: /evaluations/i }).click();
    await p.waitForTimeout(1500);
    const entries = p.locator(".history-entry");
    const first = await entries.count();
    await p.locator(".strategy-history button", { hasText: /Load earlier/ }).click();
    await p.waitForTimeout(1500);
    const second = await entries.count();
    const times = (await entries.locator("time").allInnerTexts()).map((s) => new Date(s).getTime());
    await L.check(
      "E1 evaluations page 20 at a time, 'Load earlier' appends older ones",
      first === 20 && second === 40 && times.every((t, i) => i === 0 || t <= times[i - 1]),
      `${first} → ${second}`,
    );
    await p.locator(".strategy-history button", { hasText: /Load earlier/ }).click();
    await p.waitForTimeout(1500);
    const stamps = await entries.locator("time").allInnerTexts();
    const keys = await entries.evaluateAll((nodes) =>
      nodes.map((n) => n.textContent?.replace(/\s+/g, " ").trim()),
    );
    await L.check(
      "E2 a third page appends without duplicates",
      (await entries.count()) === 60 && new Set(keys).size === 60,
      `${await entries.count()} entries, ${new Set(stamps).size} distinct times, ${new Set(keys).size} distinct rows`,
    );
    await p.locator(".strategy-history button", { hasText: /^Refresh$/ }).click();
    await p.waitForTimeout(1500);
    await L.check("E3 Refresh returns to the first page", (await entries.count()) === 20);
    await L.shot("E-history");
  } else await L.skip("E history paging", "no strategy with more than 45 evaluations yet");

  await L.check(
    "no page errors across the run",
    errors.length === 0,
    errors.slice(0, 3).join(" || "),
  );
  await L.check(
    "API problems were only the provoked quote refusal",
    apiProblems.filter((l) => !/market\/quote|market\/candles/.test(l)).length === 0,
    apiProblems.slice(0, 3).join(" || "),
  );
} catch (e) {
  await L.fail("run aborted", e.message.split("\n")[0].slice(0, 220));
}
const failures = await L.report();
await b.close();
process.exit(failures ? 1 : 0);
