/**
 * The demo, rehearsed against the deployed app before anyone records it.
 *
 * Every other suite in this directory asserts against a local Postgres and a local fork RPC,
 * neither of which exists from outside Railway's private network. This one proves the same
 * journey using only what a visitor has: the browser, and the API the browser is allowed to
 * call. If this passes, the flow in docs/product/demo-script.md can be filmed.
 *
 *   DEMO_ORIGIN=https://mandate.up.railway.app SHOT=/tmp/shots node apps/web/test/browser/remote-demo.mjs
 */
import { chromium } from "playwright";
import { builder } from "./lib/builder.mjs";
import { ledger } from "./lib/check.mjs";
import { login, ORIGIN } from "./lib/session.mjs";

const SHOT = process.env.SHOT ?? "/tmp";
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const L = ledger(p, SHOT, "remote");
const { dialog, openBuilder, review, sign } = builder(p);

const text = async (loc) => (await loc.innerText().catch(() => "")).replace(/\s+/g, " ");
const detail = () => p.locator(".detail-content");
/** The app's own API, called with the session the browser is holding. */
const api = (path) =>
  p.evaluate(async (target) => {
    const raw = localStorage.getItem("privy:token");
    const token = raw ? JSON.parse(raw) : null;
    const r = await fetch(`/api/mandate${target}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return r.ok ? r.json() : { error: r.status };
  }, path);
const until = async (predicate, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await p.waitForTimeout(2000);
  }
  return predicate();
};
const nav = async (label) => {
  await p
    .locator(".sidebar")
    .getByRole("link", { name: new RegExp(`^${label}`) })
    .click();
  await p.locator(".workspace").waitFor({ timeout: 30000 });
  await p.waitForTimeout(1200);
};

try {
  await L.check("target is the deployed app", ORIGIN.startsWith("https://"), ORIGIN);
  // fund:false — the shared helper funds through a local fork RPC that does not exist here.
  const wallet = await login(p, { fund: false });
  await L.check(
    "signed in, and the app picked an embedded wallet to trade from",
    /^0x[0-9a-f]{40}$/.test(wallet.account ?? ""),
    `signed in with ${wallet.address}; trades from ${wallet.account}`,
  );

  // ---- A. Fund it through the button a visitor actually presses -------------------------------
  await nav("Portfolio");
  const before = await api("/v1/portfolio");
  const fundButton = p.getByRole("button", { name: /Get test USDC/i });
  await L.check("the demo offers to fund the wallet", (await fundButton.count()) === 1);
  if (Number(before.cash ?? 0) < 1000) {
    await fundButton.click();
    await until(async () => Number((await api("/v1/portfolio")).cash ?? 0) >= 1000, 60000);
  }
  const funded = await api("/v1/portfolio");
  await L.check(
    "the wallet now holds test USDC",
    Number(funded.cash ?? 0) >= 1000,
    `cash ${funded.cash}`,
  );
  await L.shot("A-funded");

  // ---- B. Author the strategy the script describes ---------------------------------------------
  const name = `Demo rehearsal ${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  await openBuilder();
  await dialog()
    .locator(".recipe", { hasText: /\$50 into NVIDIA every week/ })
    .click();
  await p.waitForTimeout(900);
  await dialog()
    .getByRole("button", { name: /^Buy it for me$/ })
    .click();
  await p.waitForTimeout(400);
  await dialog()
    .locator("label.field", { hasText: /^Name/ })
    .locator("input")
    .fill(name);
  await review();
  await L.check(
    "review states the grant in the new terms, with no spend-permission jargon",
    /wallet/i.test(await text(dialog().locator(".review-block.grants"))) &&
      !/Coinbase|spending limit|spend permission/i.test(await text(dialog())),
    (await text(dialog().locator(".review-block.grants"))).slice(0, 120),
  );
  const signed = await sign(wallet, /Sign & turn it on|Sign & watch/);
  await L.check("signing the strategy asked the wallet for exactly one signature", signed === 1);

  // ---- C. Turn on automatic buying, then arm ------------------------------------------------------
  await nav("Strategies");
  await p.locator(".strategy-row", { hasText: name }).first().locator(".strategy-main").click();
  await detail().waitFor({ timeout: 20000 });
  await p.waitForTimeout(1000);
  const enable = detail().getByRole("button", { name: /Turn on automatic buying/ });
  if (await enable.count()) {
    const signsBefore = wallet.log.length;
    await enable.click();
    await until(async () => /Buys automatically from your wallet/.test(await text(detail())), 60000);
    await L.check(
      "one click enabled automatic buying, with no wallet prompt",
      /Buys automatically from your wallet/.test(await text(detail())) &&
        wallet.log.length === signsBefore,
      `wallet calls during enable: ${wallet.log.length - signsBefore}`,
    );
  } else
    await L.check(
      "automatic buying was already on for this wallet",
      /Buys automatically from your wallet/.test(await text(detail())),
    );
  await detail()
    .getByRole("button", { name: /Start watching/ })
    .click();
  await p.waitForTimeout(1500);
  await L.check("armed", /Watching/.test(await text(detail().locator(".detail-status"))));
  await L.shot("C-armed");

  // ---- D. The centrepiece: the worker buys from the user's own wallet ---------------------------
  const instance = new URL(p.url()).pathname.split("/").pop();
  const orders = async () => {
    const page = await api(`/v1/executions?limit=20`);
    return (page.items ?? []).filter((o) => o.instance === instance || o.instanceId === instance);
  };
  const filled = await until(async () => (await orders()).some((o) => o.status === "confirmed"), 240000);
  const final = await orders();
  await L.check(
    "the strategy executed a real trade on the deployed fork",
    filled,
    final.map((o) => `${o.status}/${o.stage ?? ""}`).join(", ") || "no orders recorded",
  );
  const after = await api("/v1/portfolio");
  await L.check(
    "USDC left the wallet and the stock arrived in it",
    Number(after.cash) < Number(funded.cash) &&
      (after.holdings ?? []).some((h) => h.symbol === "NVDAc" && Number(h.quantity) > 0),
    `cash ${funded.cash} -> ${after.cash}; holdings ${(after.holdings ?? []).map((h) => `${h.symbol}:${h.quantity}`).join(",")}`,
  );
  await nav("Portfolio");
  await L.shot("D-filled");
  await L.check("no page errors across the run", errors.length === 0, errors.slice(0, 3).join(" || "));
} catch (e) {
  await L.fail("run aborted", e.message.split("\n")[0].slice(0, 220));
}
const failures = await L.report();
await b.close();
process.exit(failures ? 1 : 0);
