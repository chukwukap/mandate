import { chromium } from "playwright";
import { builder } from "./lib/builder.mjs";
import { ledger } from "./lib/check.mjs";
import { latestDraft, mine } from "./lib/db.mjs";
import { login, watchApi } from "./lib/session.mjs";

const SHOT = process.env.SHOT;
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const errors = [];
const apiProblems = watchApi(p);
p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const L = ledger(p, SHOT, "create");
const { dialog, title, openBuilder, closeBuilder, money, preview, review, sign } = builder(p);

try {
  const wallet = await login(p);
  const start = mine();
  await L.check("logged in, strategies baseline", true, `${start} existing`);

  // ---- A. Starter: Buy Apple if it drops 5% (levels, manual) --------------------------------
  await openBuilder();
  await L.check("builder opens on the question", (await title()) === "What should it do?");
  await L.check(
    "four starters, five shapes",
    (await dialog().locator(".recipe").count()) === 4 &&
      (await dialog().locator(".shape-row").count()) === 5,
  );
  await dialog()
    .locator(".recipe", { hasText: /Buy Apple if it drops 5%/ })
    .click();
  await p.waitForTimeout(600);
  await L.check(
    "starter lands on step 2",
    (await title()) === "Set it up." &&
      /Buy it if the price drops/.test(await dialog().locator(".chosen").innerText()),
  );
  await L.check(
    "Apple selected, alone",
    (await dialog().locator(".stock-ring.on").allInnerTexts()).join() === "AAPL",
  );
  const spotText = await dialog().locator(".price-now").innerText();
  const spot = Number((spotText.match(/\$([\d.]+)/) ?? [])[1]);
  const priceVal = Number(await dialog().locator(".price .field.big input").inputValue());
  await L.check(
    "price field shows spot and prefills 5% under it",
    spot > 0 && Math.abs(priceVal / spot - 0.95) < 0.002,
    `${spotText} → ${priceVal}`,
  );
  await L.check(
    "delta badge says −5.0%",
    /-5\.0%/.test(await dialog().locator(".price-delta").innerText()),
  );
  await L.check(
    "money prefilled from starter",
    (await money(0).inputValue()) === "100" && (await money(1).inputValue()) === "100",
  );
  await L.check(
    "live sentence names the numbers",
    /Buy \$100\.00 of AAPL whenever it falls below/.test(await preview()),
  );
  await L.check("today: waiting, not firing", /Nothing meets this yet/.test(await preview()));
  await dialog()
    .locator(".price-field-steps, .chips")
    .locator("button", { hasText: /^-10%$/ })
    .click();
  await p.waitForTimeout(300);
  await L.check(
    "−10% chip rewrites the price",
    /-10\.0%/.test(await dialog().locator(".price-delta").innerText()),
  );
  await L.shot("A-setup");
  await review();
  await L.check(
    "review: worst case leads",
    (await title()) === "One last look." &&
      /\$100/.test(await dialog().locator(".review-worst strong").innerText()),
  );
  await L.check(
    "review: one rule, manual grant",
    (await dialog().locator(".review-rules li").count()) === 1 &&
      /Nothing else/.test(await dialog().locator(".review-block.grants").innerText()),
  );
  await L.check(
    "review: exact text collapsed by default",
    !(await dialog()
      .locator(".review-exact")
      .evaluate((d) => d.open)),
  );
  await L.shot("A-review");
  const sigA = await sign(wallet, /Sign & watch/);
  await L.check(
    "Sign & watch requests one signature and closes",
    sigA === 1 && (await dialog().count()) === 0,
  );
  await L.check("toast confirms the save", (await p.getByText(/Strategy saved/).count()) > 0);
  const dA = latestDraft();
  await L.check(
    "DB: manual instance, AAPLc only",
    mine() === start + 1 &&
      dA?.mode === "manual" &&
      dA?.instance_mode === "manual" &&
      JSON.stringify(dA?.assets).includes("AAPLc"),
    `${dA?.status}`,
  );

  // ---- B. Recurring (DCA) on NVDA + MSFT, weekly ---------------------------------------------
  await openBuilder();
  await dialog()
    .locator(".shape-row", { hasText: /same amount in on a schedule/ })
    .click();
  await p.waitForTimeout(500);
  await L.check(
    "recurring: weekly preselected",
    /Weekly/.test(
      await dialog().locator('.segment button[aria-pressed="true"]').first().innerText(),
    ),
  );
  await dialog()
    .locator(".stock-ring", { hasText: /^MSFT$/ })
    .click();
  await p.waitForTimeout(200);
  await L.check(
    "recurring: basket of two",
    (await dialog().locator(".stock-ring.on").count()) === 2,
  );
  await money(0).fill("25");
  await money(1).fill("300");
  await p.waitForTimeout(400);
  await L.check(
    "recurring sentence + budget horizon",
    /every week/.test(await preview()) && /Budget lasts about 84 days/.test(await preview()),
  );
  await L.check(
    "recurring: warns budget outlasts 30-day run",
    /outlasts the strategy/.test(await preview()),
  );
  await L.check(
    "recurring: no cooldown row in guardrails summary",
    !/min apart/.test(await dialog().locator(".guardrails summary").innerText()),
  );
  await review();
  await L.check(
    "recurring review: two rules (one per stock)",
    (await dialog().locator(".review-rules li").count()) === 2,
  );
  await L.check(
    "recurring review: simultaneous-firing caution present",
    /rules can trigger in the same evaluation/.test(
      await dialog()
        .locator(".review-block.cautions")
        .innerText()
        .catch(() => ""),
    ),
  );
  await sign(wallet, /Sign & watch/);
  const dB = latestDraft();
  await L.check(
    "DB: recurring cadence became the cooldown (604800s)",
    dB?.caps?.cooldown_secs === 604800,
    `cooldown_secs=${dB?.caps?.cooldown_secs}`,
  );

  // ---- C. Ladder on TSLA (single-stock enforced, largest rung = per_order) ---------------------
  await openBuilder();
  await dialog()
    .locator(".shape-row", { hasText: /Buy more, and bigger/ })
    .click();
  await p.waitForTimeout(500);
  await dialog()
    .locator(".stock-ring", { hasText: /^TSLA$/ })
    .click();
  await p.waitForTimeout(200);
  await dialog()
    .locator(".stock-ring", { hasText: /^AAPL$/ })
    .click();
  await p.waitForTimeout(200);
  await L.check(
    "ladder: picking another stock replaces, never adds",
    (await dialog().locator(".stock-ring.on").allInnerTexts()).join() === "AAPL",
  );
  await dialog()
    .locator(".stock-ring", { hasText: /^TSLA$/ })
    .click();
  await p.waitForTimeout(300);
  const tslaSpot = Number(
    ((await dialog().locator(".price-now").innerText()).match(/\$([\d.]+)/) ?? [])[1],
  );
  await L.check(
    "ladder: first step prefilled at spot",
    Math.abs(Number(await dialog().locator(".price .field.big input").inputValue()) - tslaSpot) <
      0.01,
  );
  // No money typed yet: the pane must still read the steps back, in rule-mode words.
  await L.check(
    "ladder: reads back before money is typed",
    /in 4 steps as it falls, starting under/.test(await preview()) &&
      !/Describe what you want/.test(await preview()),
    (await preview()).slice(0, 90),
  );
  await L.check(
    "ladder: at spot the first step is 0.0% away, nothing crossed",
    /right at the first step/.test(await preview()) &&
      !/would trigger at once/.test(await preview()),
  );
  // Set above today's price so that even the deepest of 4 steps at −4% sits above spot.
  await dialog()
    .locator(".price .field.big input")
    .fill((tslaSpot * 1.2).toFixed(2));
  await p.waitForTimeout(300);
  await L.check(
    "ladder: whole ladder above spot warns every step triggers at once",
    /all 4 would trigger at once/.test(await preview()),
  );
  await dialog()
    .locator(".price .field.big input")
    .fill((tslaSpot * 0.97).toFixed(2));
  await p.waitForTimeout(300);
  await L.check(
    "ladder: 3% below spot clears the warning",
    !/would trigger at once/.test(await preview()),
  );
  await money(0).fill("40");
  await money(1).fill("500");
  await p.waitForTimeout(400);
  const rungAmounts = (await dialog().locator(".rungs li strong").allInnerTexts()).map((s) =>
    Number(s.replace(/[$,]/g, "")),
  );
  await L.check(
    "ladder: four escalating rungs",
    rungAmounts.length === 4 && rungAmounts.every((v, i) => i === 0 || v > rungAmounts[i - 1]),
    rungAmounts.join(" → "),
  );
  await L.check(
    "ladder: preview states largest single buy and no-exit",
    new RegExp(`Largest single buy \\$${rungAmounts.at(-1)?.toFixed(2)}`).test(await preview()) &&
      /Nothing sells this back/.test(await preview()),
  );
  await review();
  await L.check(
    "ladder review: four rules",
    (await dialog().locator(".review-rules li").count()) === 4,
  );
  await sign(wallet, /Sign & watch/);
  const dC = latestDraft();
  await L.check(
    "DB: per_order is the largest rung, not the first",
    Number(dC?.caps?.per_order) === rungAmounts.at(-1),
    `per_order=${dC?.caps?.per_order}`,
  );

  // ---- D. Rebalance across three ----------------------------------------------------------
  await openBuilder();
  await dialog()
    .locator(".shape-row", { hasText: /even weight/ })
    .click();
  await p.waitForTimeout(500);
  for (const s of ["AAPL", "TSLA"]) {
    await dialog()
      .locator(".stock-ring", { hasText: new RegExp(`^${s}$`) })
      .click();
    await p.waitForTimeout(150);
  }
  await money(0).fill("20");
  await money(1).fill("200");
  await p.waitForTimeout(400);
  await L.check(
    "rebalance: 33% each and the no-sell ceiling stated",
    /33% each/.test(await preview()) && /never sells/.test(await preview()),
  );
  await review();
  await L.check(
    "rebalance review: three rules + index caution",
    (await dialog().locator(".review-rules li").count()) === 3 &&
      /0=/.test(
        await dialog()
          .locator(".review-block.cautions")
          .innerText()
          .catch(() => ""),
      ),
  );
  await sign(wallet, /Sign & watch/);

  // ---- E. Discount via chip ----------------------------------------------------------------
  await openBuilder();
  await dialog()
    .locator(".shape-row", { hasText: /cheaper here than the reference/ })
    .click();
  await p.waitForTimeout(500);
  await dialog().locator(".chips button", { hasText: "0.50%" }).click();
  await p.waitForTimeout(200);
  await L.check(
    "discount: chip writes the bps field",
    (await dialog()
      .locator(".field-input input")
      .filter({ hasNot: p.locator("x") })
      .nth(0)
      .inputValue()
      .catch(() => "")) !== "",
  );
  await money(0).fill("30");
  await money(1).fill("90");
  await p.waitForTimeout(300);
  await L.check(
    "discount sentence carries 50 bps",
    /50 bps below the Chainlink reference/.test(await preview()),
  );
  await review();
  await sign(wallet, /Sign & watch/);
  await L.check("five strategies created so far", mine() === start + 5, `${mine() - start}`);

  // ---- F. Validation: native required blocks an empty price; JS catches caps ----------------
  await openBuilder();
  await dialog()
    .locator(".shape-row", { hasText: /drops to a level/ })
    .click();
  await p.waitForTimeout(400);
  await money(0).fill("10");
  await money(1).fill("10");
  await dialog().locator('button[type="submit"]').click();
  await p.waitForTimeout(600);
  await L.check(
    "empty price: form blocks submit, nothing created",
    (await dialog().count()) === 1 &&
      (await title()) === "Set it up." &&
      mine() === start + 5 &&
      (await dialog().locator("input:invalid").count()) > 0,
  );
  await dialog().locator(".price .field.big input").fill("100");
  await money(0).fill("500");
  await money(1).fill("100");
  await review();
  await L.check(
    "per-buy above budget: explained in the error banner",
    /Keep the per-order limit within/.test(
      await dialog()
        .locator(".form-error")
        .innerText()
        .catch(() => ""),
    ),
  );
  await closeBuilder();
  await L.check(
    "Escape closes without creating",
    (await dialog().count()) === 0 && mine() === start + 5,
  );

  // ---- G. Text mode with no compiler configured: honest 503, calm banner ---------------------
  await openBuilder();
  await dialog().locator(".describe-link").click();
  await p.waitForTimeout(400);
  await L.check(
    "text mode: prompt shown, preview placeholder",
    (await dialog().locator("textarea.prompt").count()) === 1 &&
      /compiled rule will appear here/.test(await preview()),
  );
  await dialog()
    .locator("textarea.prompt")
    .fill("Buy $50 of Apple whenever it falls 5% below where it is now, up to $400.");
  await money(0).fill("50");
  await money(1).fill("400");
  await review();
  await L.check(
    "text mode: compiler unconfigured is said plainly",
    /text authoring requires a configured compiler/i.test(
      await dialog()
        .locator(".form-error")
        .innerText()
        .catch(() => ""),
    ),
  );
  await L.shot("G-text-503");
  await closeBuilder();

  // ---- H. Back keeps the form; Change returns to the question --------------------------------
  await openBuilder();
  await dialog()
    .locator(".shape-row", { hasText: /same amount/ })
    .click();
  await p.waitForTimeout(400);
  await dialog()
    .locator(".stock-ring", { hasText: /^META$/ })
    .click();
  await dialog().locator(".chosen").click();
  await p.waitForTimeout(300);
  await L.check("Change goes back to the question", (await title()) === "What should it do?");
  await dialog()
    .locator(".shape-row", { hasText: /drops to a level/ })
    .click();
  await p.waitForTimeout(400);
  await L.check(
    "stocks survive a shape change",
    (await dialog().locator(".stock-ring.on").count()) === 2,
  );
  await closeBuilder();

  // ---- J. Automatic mode: signs, and the detail explains the one switch that makes it buy ------
  await openBuilder();
  await dialog()
    .locator(".recipe", { hasText: /\$50 into NVIDIA every week/ })
    .click();
  await p.waitForTimeout(500);
  await dialog()
    .getByRole("button", { name: /^Buy it for me$/ })
    .click();
  await p.waitForTimeout(200);
  await L.check(
    "auto: consequence line says it buys from my wallet, no per-strategy approval",
    /Buys from your wallet automatically/.test(
      await dialog()
        .locator(".block", { hasText: /When it fires/ })
        .innerText(),
    ),
  );
  await review();
  await L.check(
    "auto review: the grant is buying from my wallet",
    /Buying from your wallet automatically/.test(
      await dialog().locator(".review-block.grants").innerText(),
    ),
  );
  const sigJ = await sign(wallet, /Sign & turn it on|Sign & watch/);
  const dJ = latestDraft();
  const delegated = wallet.automation?.delegated === true;
  await L.check(
    "DB: requested auto; the instance is auto only if this wallet already delegated",
    sigJ === 1 && dJ?.mode === "auto" && dJ?.instance_mode === (delegated ? "auto" : "manual"),
    `draft=${dJ?.mode} instance=${dJ?.instance_mode} delegated=${delegated}`,
  );
  await p
    .locator(".sidebar")
    .getByRole("link", { name: /^Strategies/ })
    .click();
  await p.waitForTimeout(1000);
  const rows = p.locator(".strategy-row");
  await L.check(
    "strategies list shows six rows with stock marks",
    (await rows.count()) >= 6 && (await p.locator(".strategy-assets img").count()) >= 6,
  );
  await rows
    .filter({ hasText: /\$50 into NVIDIA every week/ })
    .first()
    .locator(".strategy-main")
    .click();
  await p.waitForTimeout(1200);
  const detail = p.locator(".detail-content");
  const detailText = await detail.innerText().catch(() => "");
  await L.check(
    "detail: either automatic buying is on for this wallet, or one button turns it on",
    (await detail.count()) === 1 &&
      (delegated
        ? /Buys automatically from your wallet/.test(detailText)
        : /Automatic buying is off/.test(detailText) &&
          (await detail.getByRole("button", { name: /Turn on automatic buying/ }).count()) === 1),
    detailText.replace(/\s+/g, " ").slice(0, 140),
  );
  await L.check(
    "no smart-wallet or spending-limit jargon anywhere on the detail",
    !/Coinbase|spending limit|spend permission/i.test(detailText),
  );
  await L.shot("J-automatic");
  await L.check(
    "no API errors across the run (text-mode 503 is provoked on purpose)",
    apiProblems.filter((line) => !/strategies\/draft .*compiler/.test(line)).length === 0,
    apiProblems
      .filter((line) => !/strategies\/draft .*compiler/.test(line))
      .slice(0, 3)
      .join(" || "),
  );
  await L.check(
    "no page errors across the run",
    errors.length === 0,
    errors.slice(0, 3).join(" || "),
  );
} catch (e) {
  await L.fail("run aborted", e.message.split("\n")[0].slice(0, 220));
}
const fails = L.report();
await b.close();
process.exit(fails ? 1 : 0);
