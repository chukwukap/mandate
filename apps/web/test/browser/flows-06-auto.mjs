/**
 * The whole point, end to end: a strategy that buys by itself from the user's own wallet.
 *
 * Sign in → the embedded wallet is funded → a weekly NVIDIA strategy asks for automatic
 * buying → one click delegates the wallet to the app's signer → arm → the worker signs
 * approve and swap from that wallet through Privy, broadcasts to the fork, and the shares land
 * in the wallet. Every screen that reports on it is checked against the database and the chain.
 */
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { builder } from "./lib/builder.mjs";
import { ledger } from "./lib/check.mjs";
import { latestDraft, row, rows, sql } from "./lib/db.mjs";
import { login, watchApi } from "./lib/session.mjs";

const SHOT = process.env.SHOT ?? mkdtempSync(join(tmpdir(), "mandate-auto-"));
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const errors = [];
const apiProblems = watchApi(p);
p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const L = ledger(p, SHOT, "auto");
const { dialog, openBuilder, review, sign } = builder(p);

const text = async (loc) => (await loc.innerText().catch(() => "")).replace(/\s+/g, " ");
let testInstance = null;
const detail = () => p.locator(".detail-content");
const idle = async () => text(detail().locator(".detail-idle"));
const erc20 = (token, who) =>
  BigInt(
    execSync(
      `cast call ${token} 'balanceOf(address)(uint256)' ${who} --rpc-url http://127.0.0.1:8545`,
      { encoding: "utf8" },
    )
      .trim()
      .split(" ")[0],
  );
const until = async (predicate, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await p.waitForTimeout(1500);
  }
  return predicate();
};
const nav = async (label) => {
  await p
    .locator(".sidebar")
    .getByRole("link", { name: new RegExp(`^${label}`) })
    .click();
  await p.locator(".workspace").waitFor({ timeout: 20000 });
  await p.waitForTimeout(1000);
};

try {
  const wallet = await login(p);
  await L.check(
    "the account is the embedded wallet, not the wallet I signed in with",
    wallet.account !== wallet.address.toLowerCase() && /^0x[0-9a-f]{40}$/.test(wallet.account),
    `${wallet.address} signs in; strategies use ${wallet.account}`,
  );
  const usdcBefore = erc20(USDC, wallet.account);
  const nvdaBefore = erc20(NVDA, wallet.account);
  await L.check(
    "the embedded wallet holds USDC on the fork",
    usdcBefore >= 1_000_000_000n,
    `${usdcBefore} units`,
  );

  // Exercise enabling access on every run, including when a previous run added the signer.
  if (wallet.automation?.delegated) {
    await nav("Settings");
    const toggle = p.getByRole("switch", { name: "Automatic buying", exact: true });
    await toggle.click();
    if (!(await until(async () => (await toggle.getAttribute("aria-checked")) === "false", 30000)))
      throw new Error("Could not turn off the test wallet's automation before the test");
  }

  // ---- A. Ask for automatic buying on a strategy that fires on its first check --------------
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const name = `Auto NVIDIA ${stamp}`;
  await openBuilder();
  await dialog()
    .locator(".recipe", { hasText: /\$50 into NVIDIA every week/ })
    .click();
  await p.waitForTimeout(700);
  await dialog()
    .getByRole("button", { name: /^Buy it for me$/ })
    .click();
  await p.waitForTimeout(300);
  await L.check(
    "the automatic mode explains itself without a per-strategy approval",
    /Buys from your wallet automatically/.test(await text(dialog())) &&
      !/Coinbase|spending limit/i.test(await text(dialog())),
  );
  await dialog().locator("label.field", { hasText: /^Name/ }).locator("input").fill(name);
  await review();
  await L.check(
    "review: the grant is buying from my wallet, once",
    /Buying from your wallet automatically/.test(
      await text(dialog().locator(".review-block.grants")),
    ),
    await text(dialog().locator(".review-block.grants")),
  );
  await sign(wallet, /Sign & turn it on|Sign & watch/);
  const A = latestDraft();
  if (A?.name === name) testInstance = A.id;
  if (!testInstance) throw new Error("Strategy signature did not create the test instance");
  await L.check(
    "created: asked for auto, account is the embedded wallet",
    A?.mode === "auto" && A?.name === name,
    JSON.stringify({ mode: A?.mode, instance: A?.instance_mode, status: A?.status }),
  );

  // ---- B. Turn on automatic buying: one click, no signing --------------------------------------
  await nav("Strategies");
  await p.locator(".strategy-row", { hasText: name }).first().locator(".strategy-main").click();
  await detail().waitFor({ timeout: 10000 });
  await p.waitForTimeout(800);
  const enableButton = detail().getByRole("button", { name: /Turn on automatic buying/ });
  const alreadyOn = /Buys automatically from your wallet/.test(await text(detail()));
  await L.check(
    "detail offers to turn on automatic buying, or already has it on",
    (await enableButton.count()) === 1 || alreadyOn,
  );
  if (!alreadyOn) {
    const signsBefore = wallet.log.length;
    await enableButton.click();
    await until(
      async () => /Buys automatically from your wallet/.test(await text(detail())),
      45000,
    );
    await L.check(
      "one click delegated the wallet: no wallet prompt, and the detail confirms it",
      /Buys automatically from your wallet/.test(await text(detail())) &&
        wallet.log.length === signsBefore,
      `${(await text(detail())).slice(0, 120)} | wallet calls ${wallet.log.length - signsBefore}`,
    );
  }
  const modeOk = await until(
    () => sql(`select mode from mandate_v2.instances where id='${A.id}'`) === "auto",
    15000,
  );
  await L.check(
    "DB: the instance is in auto mode",
    modeOk,
    sql(`select mode||'/'||status from mandate_v2.instances where id='${A.id}'`),
  );
  await L.shot("B-automation-on");

  // ---- C. Arm it: the worker buys from the wallet through Privy ----------------------------------
  await detail()
    .getByRole("button", { name: /Start watching/ })
    .click();
  await p.waitForTimeout(1200);
  await L.check(
    "armed",
    await until(
      () => sql(`select status from mandate_v2.instances where id='${A.id}'`) === "armed",
      20000,
    ),
  );
  const legs = () =>
    rows(
      `select t.leg, t.status, t.signer from mandate_v2.transactions t join mandate_v2.executions e on e.id=t.execution_id where e.instance_id='${A.id}' order by t.nonce`,
    );
  const order = () =>
    row(
      `select status, stage, tx_hash from mandate_v2.executions where instance_id='${A.id}' order by created_at desc limit 1`,
    );
  const filled = await until(() => order()?.status === "confirmed", 150000);
  await L.check(
    "the order filled: approve then swap, both signed by the embedded wallet",
    filled &&
      legs().length === 2 &&
      legs().every((l) => l.status === "confirmed" && l.signer === wallet.account) &&
      legs()[0].leg === "approve" &&
      legs()[1].leg === "swap",
    JSON.stringify({ order: order(), legs: legs().map((l) => `${l.leg}:${l.status}`) }),
  );
  const usdcAfter = erc20(USDC, wallet.account);
  const nvdaAfter = erc20(NVDA, wallet.account);
  await L.check(
    "chain: $50 of USDC left the wallet and NVIDIA shares arrived",
    usdcBefore - usdcAfter === 50_000_000n && nvdaAfter > nvdaBefore,
    `USDC ${usdcBefore} → ${usdcAfter}; NVDAc ${nvdaBefore} → ${nvdaAfter}`,
  );

  // ---- D. Every screen tells the same story ------------------------------------------------------
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  await p.locator(".strategy-row", { hasText: name }).first().locator(".strategy-main").click();
  await detail().waitFor({ timeout: 10000 });
  await p.waitForTimeout(1200);
  await L.check(
    "detail: bought on the last check, one order, $50 reserved",
    /Bought on the last check|Waiting for the next scheduled buy/.test(await idle()) &&
      /\$50\.00/.test(await text(detail().locator(".detail-metrics"))),
    `${await idle()} | ${await text(detail().locator(".detail-metrics"))}`,
  );
  await L.check(
    "history: the fill is listed with its transaction",
    /Filled|confirmed|Completed/i.test(await text(detail().locator(".strategy-history"))),
    (await text(detail().locator(".strategy-history"))).slice(0, 140),
  );
  await L.shot("D-filled");
  await p.keyboard.press("Escape");
  await nav("Activity");
  const act = p.locator(".activity-row", { hasText: name }).first();
  await L.check(
    "activity: the fill shows under the strategy with a transaction link",
    (await act.count()) === 1 &&
      /Completed|Filled/i.test(await text(act.locator(".status"))) &&
      (await act.locator("a[aria-label='View transaction']").count()) === 1,
    (await text(act)).slice(0, 120),
  );
  await nav("Portfolio");
  await p.locator(".stat-row").waitFor({ timeout: 20000 });
  await p.locator(".panel-heading button", { hasText: /Refresh/ }).click();
  await p.waitForTimeout(3000);
  await L.check(
    "portfolio: NVIDIA is now held in the wallet",
    (await p.locator("table.stocks-table tbody tr", { hasText: /NVIDIA|NVDAc/ }).count()) === 1,
  );
  await L.check(
    "portfolio: the deposit card shows this wallet",
    (await text(p.locator(".deposit-card, [class*='deposit']").first()))
      .toLowerCase()
      .includes(wallet.account.slice(2, 10)),
  );
  await L.shot("D-portfolio");

  await L.check(
    "no page errors across the run",
    errors.length === 0,
    errors.slice(0, 3).join(" || "),
  );
  await L.check(
    "no API errors across the run",
    apiProblems.filter((l) => !/market\/candles/.test(l)).length === 0,
    apiProblems.slice(0, 3).join(" || "),
  );
} catch (e) {
  await L.fail("run aborted", e.message.split("\n")[0].slice(0, 220));
}
// Leave only this run's strategy paused, even when later assertions fail.
if (testInstance) sql(`update mandate_v2.instances set status='paused' where id='${testInstance}'`);
const failures = await L.report();
await b.close();
process.exit(failures ? 1 : 0);
