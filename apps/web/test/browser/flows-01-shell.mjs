import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { ledger } from "./lib/check.mjs";
import { login, ORIGIN, watchApi } from "./lib/session.mjs";

const SHOT = process.env.SHOT;
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const p = await ctx.newPage();
const errors = [];
const apiProblems = watchApi(p);
p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const L = ledger(p, SHOT, "shell");
const text = async () => (await p.locator("body").innerText()).replace(/\s+/g, " ");
try {
  const wallet = await login(p);
  await L.check(
    "login via injected wallet (SIWE)",
    (await p.locator(".workspace").count()) === 1,
    `signed: ${wallet.log.filter((m) => m === "personal_sign").length} message`,
  );
  await L.check("wallet chip shows the address", /0x7099…79C8/.test(await text()));
  const balance = await p
    .getByText(/\$10,000\.00/)
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  await L.check("overview shows fork balance", balance, "Portfolio value from /v1/portfolio");
  const armed = Number(
    execSync(
      `psql "postgresql://mandate_admin@127.0.0.1:5432/mandate_fork" -tAc "select count(*) from mandate_v2.instances i join mandate_v2.drafts d on d.id=i.draft_id where d.account='0x70997970c51812dc3a010c7d01b50e0d17dc79c8' and i.status='armed'"`,
      { encoding: "utf8" },
    ).trim(),
  );
  await L.check(
    "overview headline counts what is watching",
    armed === 0
      ? /Nothing is watching yet/.test(await text())
      : new RegExp(`${armed} rules? (is|are) watching`).test(await text()),
    `${armed} armed in DB; page: ${(await text()).match(/(Nothing is watching yet|\d+ rules? (?:is|are) watching)/)?.[0]}`,
  );
  await L.shot("overview");

  // Every section, reached the way a user reaches it: through the sidebar.
  const pages = [
    ["Markets", /markets/],
    ["Portfolio", /portfolio/],
    ["Trade", /trade/],
    ["Strategies", /strategies/],
    ["Activity", /activity/],
    ["Discover", /discover/],
    ["Settings", /settings/],
    ["Overview", /\/$/],
  ];
  for (const [label, path] of pages) {
    const before = errors.length;
    await p
      .locator(".sidebar")
      .getByRole("link", { name: new RegExp(`^${label}`) })
      .click();
    await p.waitForURL(path, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(700);
    const h1 = (
      await p
        .locator("h1")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    await L.check(
      `nav → ${label}`,
      path.test(p.url()) && h1.length > 0 && errors.length === before,
      `h1="${h1}" url=${new URL(p.url()).pathname}`,
    );
    await L.shot(`page-${label.toLowerCase()}`);
  }
  await p.locator(".sidebar").getByRole("link", { name: "Portfolio", exact: true }).click();
  await p
    .locator(".stat-row")
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  await p.waitForTimeout(500);
  await L.check(
    "portfolio page shows cash from chain",
    /10,000/.test(await text()),
    (await text()).match(/Cash[^$]*\$[\d,.]+|Balances[^.]*\./)?.[0] ?? "no cash figure",
  );

  // Search: ⌘K opens, typing finds a ticker, Escape closes.
  await p.keyboard.press("Meta+k");
  await p.waitForTimeout(400);
  const search = p.getByLabel("Search company or ticker");
  if (await search.count()) {
    await search.fill("Apple");
    await p.waitForTimeout(400);
    await L.check(
      "⌘K search finds Apple",
      /AAPLc/.test(
        await p
          .locator(".command-results")
          .innerText()
          .catch(() => ""),
      ),
    );
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    await L.check("Escape closes search", (await p.locator("dialog[open]").count()) === 0);
  } else await L.fail("⌘K search opens", "no search input after Meta+k");

  // Theme: the control opens a menu; picking the other option flips data-theme; restore after.
  const themeBefore = await p.evaluate(() => document.documentElement.dataset.theme);
  await p.getByRole("button", { name: /change theme/i }).click();
  await p.waitForTimeout(300);
  const menu = p.locator(".theme-menu");
  await L.check("theme menu opens", (await menu.count()) === 1);
  const want = themeBefore === "dark" ? "light" : "dark";
  await menu
    .getByRole("button", { name: new RegExp(want, "i") })
    .first()
    .click();
  await p.waitForTimeout(400);
  const after1 = await p.evaluate(() => document.documentElement.dataset.theme);
  await p.getByRole("button", { name: /change theme/i }).click();
  await p.waitForTimeout(300);
  await menu
    .getByRole("button", { name: new RegExp(themeBefore ?? "system", "i") })
    .first()
    .click();
  await p.waitForTimeout(400);
  const after2 = await p.evaluate(() => document.documentElement.dataset.theme);
  await L.check(
    "theme choice flips and restores",
    after1 === want && after2 === themeBefore,
    `${themeBefore} → ${after1} → ${after2}`,
  );
  await L.check(
    "theme choice persists in storage",
    (await p.evaluate(() => localStorage.getItem("mandate:theme"))) !== null ||
      themeBefore === undefined,
  );

  // Sidebar: ⌘B collapses to the rail and back; the button does the same.
  const railWidth = async () =>
    Math.round(await p.locator(".sidebar").evaluate((e) => e.getBoundingClientRect().width));
  await p.keyboard.press("Meta+b");
  await p.waitForTimeout(400);
  const w1 = await railWidth();
  await p.keyboard.press("Meta+b");
  await p.waitForTimeout(400);
  const w2 = await railWidth();
  await L.check(
    "⌘B collapses sidebar to rail and back",
    w1 === 68 && w2 === 222,
    `${w1}px → ${w2}px`,
  );
  await p.getByRole("button", { name: /collapse sidebar/i }).click();
  await p.waitForTimeout(400);
  await L.check("Collapse button collapses", (await railWidth()) === 68);
  await L.check(
    "collapsed choice persists in storage",
    (await p.evaluate(() => localStorage.getItem("mandate:sidebar"))) === "collapsed",
  );
  await L.shot("rail");
  await p.getByRole("button", { name: /expand sidebar/i }).click();
  await p.waitForTimeout(400);
  await L.check("Expand button expands", (await railWidth()) === 222);

  // Account menu: full address, copy, settings, then sign out.
  await p.locator(".wallet-button.connected").click();
  await p.waitForTimeout(300);
  await L.check(
    "account menu opens with full address",
    /0x70997970C51812dc3A010C7d01b50e0d17dc79C8/i.test(
      await p
        .locator(".account-popover")
        .innerText()
        .catch(() => ""),
    ),
  );
  await p.getByRole("menuitem", { name: /copy address/i }).click();
  await p.waitForTimeout(400);
  const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  await L.check(
    "copy address writes the clipboard",
    /0x70997970C51812dc3A010C7d01b50e0d17dc79C8/i.test(clip),
    clip ? "" : "(clipboard empty)",
  );
  await p.keyboard.press("Escape");
  await p.waitForTimeout(200);
  await L.check("Escape closes account menu", (await p.locator(".account-popover").count()) === 0);
  await p.locator(".wallet-button.connected").click();
  await p.waitForTimeout(300);
  await p.getByRole("menuitem", { name: /^sign out$/i }).click();
  await p.waitForTimeout(2500);
  await L.check(
    "sign out leaves the workspace",
    (await p.locator(".workspace").count()) === 0 && /Make it mine|Log in/i.test(await text()),
  );
  await L.shot("signed-out");

  // Sign in again from the signed-out state (fresh onboarding is the honest first-run path).
  const again = await login(p);
  await L.check(
    "sign in again works",
    (await p.locator(".workspace").count()) === 1,
    `second SIWE: ${again.log.includes("personal_sign")}`,
  );

  // Mobile: the sidebar is a drawer.
  await p.setViewportSize({ width: 390, height: 844 });
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  const menuBtn = p.getByRole("button", { name: /open navigation/i });
  if (await menuBtn.count()) {
    await menuBtn.click();
    await p.waitForTimeout(400);
    await L.check("mobile drawer opens", (await p.locator(".sidebar.is-open").count()) === 1);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    await L.check(
      "Escape closes mobile drawer",
      (await p.locator(".sidebar.is-open").count()) === 0,
    );
  } else await L.fail("mobile menu button", "not found at 390px");
  await L.check(
    "no horizontal overflow on mobile",
    !(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await L.shot("mobile");
  await L.check(
    "no API errors across the run (upstream candle history outages excepted)",
    apiProblems.filter((l) => !/market\/candles.*(503|unavailable)/.test(l)).length === 0,
    apiProblems
      .filter((l) => !/market\/candles.*(503|unavailable)/.test(l))
      .slice(0, 3)
      .join(" || "),
  );
  // A sign-in service that never answers must not leave a person on a spinner forever.
  const blocked = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await blocked.route(/privy\.io/, (route) => route.abort());
  const q = await blocked.newPage();
  await q.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  const retry = q.getByRole("button", { name: /try again/i });
  await retry.waitFor({ timeout: 30000 }).catch(() => {});
  await L.check(
    "a blocked sign-in service ends in a message and a Try again, not an endless splash",
    (await retry.count()) === 1 &&
      /Still connecting to the sign-in service/.test(await q.locator(".boot").innerText()),
    (
      await q
        .locator(".boot")
        .innerText()
        .catch(() => "")
    )
      .replace(/\s+/g, " ")
      .slice(0, 100),
  );
  await blocked.close();

  await L.check(
    "no page errors across the run",
    errors.length === 0,
    errors.slice(0, 3).join(" || "),
  );
} catch (e) {
  await L.fail("run aborted", e.message.split("\n")[0].slice(0, 200));
}
const fails = L.report();
await b.close();
process.exit(fails ? 1 : 0);
