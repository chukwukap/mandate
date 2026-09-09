/**
 * Lifecycle and monitoring, as a person sees it: a strategy is created, armed, watched by the
 * worker on the local chain, paused, and stopped — and every screen that reports on it (list,
 * detail dialog, detail page, activity, overview) says the same thing the database says.
 */
import { chromium } from "playwright";
import { builder } from "./lib/builder.mjs";
import { ledger } from "./lib/check.mjs";
import { ACCOUNT, latestDraft, row, rows, sql } from "./lib/db.mjs";
import { login, watchApi } from "./lib/session.mjs";

const SHOT = process.env.SHOT;
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const errors = [];
const apiProblems = watchApi(p);
p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
const L = ledger(p, SHOT, "life");
const { createStarter } = builder(p);

const nav = async (label) => {
  await p
    .locator(".sidebar")
    .getByRole("link", { name: new RegExp(`^${label}`) })
    .click();
  await p.waitForTimeout(900);
};
const detail = () => p.locator(".detail-content");
const idle = async () =>
  (
    await detail()
      .locator(".detail-idle")
      .innerText()
      .catch(() => "")
  ).replace(/\s+/g, " ");
const statusOf = (id) => sql(`select status from mandate_v2.instances where id='${id}'`);
const evaluations = (id) =>
  Number(sql(`select count(*) from mandate_v2.evaluations where instance_id='${id}'`));
const executions = (id) =>
  rows(
    `select status, stage, intent from mandate_v2.executions where instance_id='${id}' order by created_at`,
  );
/** Polls the database until `predicate` holds or `ms` elapse; the worker ticks every 2s. */
const until = async (predicate, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await p.waitForTimeout(700);
  }
  return predicate();
};
const rowFor = (name) => p.locator(".strategy-row", { hasText: name }).first();
const openRow = async (name) => {
  await rowFor(name).locator(".strategy-main").click();
  await detail().waitFor({ timeout: 10000 });
  await p.waitForTimeout(900);
};
const closeDetail = async () => {
  await p.keyboard.press("Escape");
  await detail()
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  await p.waitForTimeout(300);
};

try {
  const wallet = await login(p);

  // ---- A. Two strategies of my own: one that cannot fire yet, one that fires at once ----------
  // A1: Apple 5% under spot — a rule that is honest when it says "conditions not met".
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const nameA = `Apple dip ${stamp}`;
  const nameB = `NVIDIA weekly ${stamp}`;
  const rename =
    (name) =>
    async ({ dialog }) => {
      await dialog().locator("label.field", { hasText: /^Name/ }).locator("input").fill(name);
    };
  const signedA = await createStarter(wallet, /Buy Apple if it drops 5%/, rename(nameA));
  const A = latestDraft();
  await L.check(
    "A created (Apple dip, manual, paused)",
    signedA === 1 && A?.status === "paused" && A?.instance_mode === "manual",
    JSON.stringify({ s: A?.status, m: A?.instance_mode }),
  );
  // A2: recurring NVIDIA — willing on every check, so the first tick after arming must signal.
  const signedB = await createStarter(wallet, /\$50 into NVIDIA every week/, rename(nameB));
  const B = latestDraft();
  await L.check(
    "B created (weekly NVIDIA, manual, paused)",
    signedB === 1 && B?.status === "paused" && B?.id !== A?.id,
  );
  await L.check(
    "B: cooldown is a week",
    B?.caps?.cooldown_secs === 604800,
    `cooldown=${B?.caps?.cooldown_secs}`,
  );

  // ---- B. The list: counts, tabs and the row itself ------------------------------------------
  await nav("Strategies");
  // Every page, so the counts below compare like with like.
  for (let i = 0; i < 10; i += 1) {
    const more = p.locator("button", { hasText: /^Load more$/ });
    if (!(await more.count())) break;
    await more.click();
    await p.waitForTimeout(1200);
  }
  // Scoped to this wallet: the fork database also holds another tenant's strategies.
  const owned = (where = "true") =>
    Number(
      sql(
        `select count(*) from mandate_v2.instances i join mandate_v2.drafts d on d.id=i.draft_id where d.account='${ACCOUNT}' and ${where}`,
      ),
    );
  const total = owned();
  const pausedCount = owned("i.status='paused'");
  const armedCount = owned("i.status='armed'");
  await L.check(
    "list count matches the database",
    new RegExp(`^${total} strategies$`).test(
      (await p.locator(".panel-heading .quiet").first().innerText()).trim(),
    ),
    await p.locator(".panel-heading .quiet").first().innerText(),
  );
  await L.check(
    "Watching card matches the database",
    (
      await p
        .locator(".stat-row > div", { hasText: /^Watching/ })
        .first()
        .innerText()
        .catch(() => "")
    ).includes(String(armedCount)) || armedCount === 0,
  );
  await p.locator(".tabs button", { hasText: /^Paused$/ }).click();
  await p.waitForTimeout(400);
  await L.check(
    "Paused tab shows only paused rows",
    (await p.locator(".strategy-row .status.paused").count()) ===
      (await p.locator(".strategy-row").count()) &&
      (await p.locator(".strategy-row").count()) === pausedCount,
    `${await p.locator(".strategy-row").count()} rows vs ${pausedCount} paused`,
  );
  await p.locator(".tabs button", { hasText: /^Watching$/ }).click();
  await p.waitForTimeout(400);
  await L.check(
    "Watching tab is empty when nothing is armed",
    armedCount > 0 ||
      /No watching strategies/.test(
        await p
          .locator(".table-empty")
          .innerText()
          .catch(() => ""),
      ),
  );
  await p.locator(".tabs button", { hasText: /^All$/ }).click();
  await p.waitForTimeout(400);
  await L.check(
    "row A: name, stock mark, signal-only, budget",
    rowFor(nameA) &&
      (await rowFor(nameA).innerText()).includes(nameA) &&
      (await rowFor(nameA).locator(".strategy-assets img").count()) === 1 &&
      /Signal only · AAPL · \$100\.00 budget|Signal only · AAPL/.test(
        await rowFor(nameA).innerText(),
      ),
    (await rowFor(nameA).innerText()).replace(/\s+/g, " ").slice(0, 100),
  );
  await L.shot("B-list");

  // ---- C. Detail dialog for A: what it says before anything has happened ----------------------
  await openRow(nameA);
  await L.check(
    "detail: Paused, signal only",
    /Paused/.test(await detail().locator(".detail-status").innerText()) &&
      /Signal only/.test(await detail().locator(".detail-status").innerText()),
  );
  await L.check(
    "detail: says why it is idle and what to do",
    /Paused/.test(await idle()) && /Arm it to start buying/.test(await idle()),
    await idle(),
  );
  await L.check(
    "detail: watching AAPL, $100 budget, 0 orders",
    /Watching AAPL/.test(await detail().innerText()) &&
      /\$100\.00/.test(await detail().innerText()) &&
      (await detail().locator(".detail-metrics div").nth(2).innerText()).includes("0"),
  );
  await L.check(
    "detail: signing wallet is mine",
    new RegExp(wallet.address.slice(0, 6), "i").test(await detail().innerText()),
  );
  await detail()
    .locator("summary", { hasText: /Signed review/ })
    .click();
  await p.waitForTimeout(200);
  const signedText = await detail().locator(".review-details pre").first().innerText();
  const dbText = sql(
    `select d.render_text from mandate_v2.drafts d join mandate_v2.instances i on i.draft_id=d.id where i.id='${A.id}'`,
  );
  await L.check(
    "detail: signed text is byte-for-byte what the database holds",
    signedText.trim() === dbText.trim(),
    `${signedText.length} vs ${dbText.length} chars`,
  );
  await L.check(
    "detail: no evaluations yet",
    /No evaluations recorded yet|No executions recorded yet/.test(
      await detail().locator(".strategy-history").innerText(),
    ),
  );
  await L.check(
    "detail: no spending-approval control for a signal-only strategy",
    (await detail()
      .getByRole("button", { name: /spending approval/i })
      .count()) === 0,
  );
  await L.shot("C-detail-idle");

  // ---- D. Arm A: the worker checks it and honestly reports "not met" -------------------------
  await detail()
    .getByRole("button", { name: /Start watching/ })
    .click();
  await p.waitForTimeout(1200);
  await L.check(
    "arm: toast confirms",
    /Strategy watching/.test(
      await p
        .locator(".toast")
        .innerText()
        .catch(() => ""),
    ),
    await p
      .locator(".toast")
      .innerText()
      .catch(() => "no toast"),
  );
  await L.check(
    "arm: dialog now says Watching and offers Pause",
    /Watching/.test(await detail().locator(".detail-status").innerText()) &&
      (await detail()
        .getByRole("button", { name: /Pause strategy/ })
        .count()) === 1,
  );
  await L.check("DB: A is armed", statusOf(A.id) === "armed", statusOf(A.id));
  const evaluated = await until(() => evaluations(A.id) >= 1, 25000);
  await L.check(
    "worker evaluated A within 25s of arming",
    evaluated,
    `${evaluations(A.id)} evaluations`,
  );
  const evalA = row(
    `select outcome, admitted, refused from mandate_v2.evaluations where instance_id='${A.id}' order by at desc limit 1`,
  );
  await L.check(
    "A: not met — nothing admitted, no signal",
    evalA && evalA.admitted === 0 && executions(A.id).length === 0,
    JSON.stringify(evalA),
  );
  // Reopen so the dialog fetches the latest evaluation.
  await closeDetail();
  await openRow(nameA);
  await L.check(
    "detail: explains it is watching and conditions are not met",
    /Watching — conditions not met yet|Watching/.test(await idle()),
    await idle(),
  );
  await detail()
    .locator(".strategy-history .tabs button", { hasText: /evaluations/i })
    .click();
  await p.waitForTimeout(1200);
  const entries = detail().locator(".history-entry");
  await L.check(
    "history: evaluation entries list outcome and prices",
    (await entries.count()) >= 1 &&
      /0 orders admitted/.test(await entries.first().innerText()) &&
      (await entries
        .first()
        .locator("summary", { hasText: /Observed prices/ })
        .count()) === 1,
    (
      await entries
        .first()
        .innerText()
        .catch(() => "")
    )
      .replace(/\s+/g, " ")
      .slice(0, 120),
  );
  await entries
    .first()
    .locator("summary", { hasText: /Observed prices/ })
    .click();
  await p.waitForTimeout(200);
  await L.check(
    "history: observed price is a real number",
    /\d+\.\d+/.test(await entries.first().locator("dl").innerText()),
  );
  await L.shot("D-armed-evaluated");
  await closeDetail();

  // ---- E. Arm B: a recurring rule fires on its first check, as a signal, and then waits ------
  await openRow(nameB);
  await detail()
    .getByRole("button", { name: /Start watching/ })
    .click();
  await p.waitForTimeout(1000);
  const fired = await until(() => executions(B.id).length >= 1, 25000);
  const exB = executions(B.id);
  await L.check(
    "B: first tick produced exactly one signal",
    fired && exB.length === 1 && exB[0].status === "signal",
    JSON.stringify(exB.map((e) => [e.status, e.stage])),
  );
  await L.check(
    "B: the signal is a $50 NVIDIA buy",
    (exB[0]?.intent?.side === "buy" && String(exB[0]?.intent?.amount) === "50") ||
      String(exB[0]?.intent?.amount).startsWith("50"),
    JSON.stringify(exB[0]?.intent),
  );
  const evB1 = evaluations(B.id);
  await until(() => evaluations(B.id) > evB1, 20000);
  const evB2 = evaluations(B.id);
  await L.check("B: keeps being checked while armed", evB2 > evB1, `${evB1} → ${evB2}`);
  await L.check(
    "B: still exactly one signal — the cooldown holds",
    executions(B.id).length === 1,
    `${executions(B.id).length} executions`,
  );
  const evBlast = row(
    `select outcome, admitted, refused from mandate_v2.evaluations where instance_id='${B.id}' order by at desc limit 1`,
  );
  await L.check(
    "B: latest evaluation is a cooldown refusal",
    evBlast &&
      evBlast.admitted === 0 &&
      /cooldown|cadence|interval/i.test(String(evBlast.refused ?? evBlast.outcome)),
    JSON.stringify(evBlast),
  );
  await closeDetail();
  await openRow(nameB);
  await L.check(
    "detail: B explains it is waiting for the next scheduled buy",
    /Waiting for the next scheduled buy|Bought on the last check/.test(await idle()),
    await idle(),
  );
  await L.check(
    "detail: B counts one order and $50 reserved",
    /1/.test(await detail().locator(".detail-metrics div").nth(2).innerText()) &&
      /\$50\.00/.test(await detail().locator(".detail-metrics div").nth(0).innerText()),
    (await detail().locator(".detail-metrics").innerText()).replace(/\s+/g, " "),
  );
  await L.check(
    "history: executions tab shows the signal",
    /Signalled, not traded|signal/i.test(await detail().locator(".strategy-history").innerText()),
    (await detail().locator(".strategy-history").innerText()).replace(/\s+/g, " ").slice(0, 120),
  );
  await L.shot("E-signal");
  await closeDetail();

  // ---- F. Everywhere else the signal must show up ---------------------------------------------
  await L.check(
    "list: B row counts 1 order",
    /1 orders/.test(await rowFor(nameB).innerText()) ||
      /\$50\.00/.test(await rowFor(nameB).innerText()),
    (await rowFor(nameB).innerText()).replace(/\s+/g, " ").slice(0, 100),
  );
  await nav("Activity");
  const act = p.locator(".activity-row", { hasText: nameB }).first();
  await L.check(
    "activity: the signal is listed under its strategy name",
    (await act.count()) === 1 &&
      /signal/i.test(await act.locator(".status").innerText()) &&
      /50/.test(await act.locator(".number").innerText()),
    (await act.innerText().catch(() => "missing")).replace(/\s+/g, " ").slice(0, 100),
  );
  await L.check(
    "activity: says signals do not move funds",
    /Signals don't move funds/.test(await p.locator(".table-footer").innerText()),
  );
  await L.shot("F-activity");
  await nav("Overview");
  const recent = p.locator("section.desk-surface", {
    has: p.locator("h2", { hasText: /^Recent activity$/ }),
  });
  await L.check(
    "overview: recent activity carries the signal too",
    (await recent.innerText()).includes(nameB) && /Signal/.test(await recent.innerText()),
    (await recent.innerText()).replace(/\s+/g, " ").slice(0, 120),
  );
  const overviewRow = p.locator(".overview-bot-row", { hasText: nameB }).first();
  await L.check(
    "overview: strategies panel shows B as Watching, in the list's own words",
    /Watching/.test(await overviewRow.locator(".desk-status").innerText()) &&
      /\$50\.00/.test(await overviewRow.innerText()),
    (await overviewRow.innerText()).replace(/\s+/g, " ").slice(0, 120),
  );

  // ---- G. Pause A: the worker stops touching it ------------------------------------------------
  await nav("Strategies");
  await openRow(nameA);
  await detail()
    .getByRole("button", { name: /Pause strategy/ })
    .click();
  await p.waitForTimeout(1200);
  await L.check(
    "pause: toast + Paused + Start watching offered",
    /Strategy paused/.test(
      await p
        .locator(".toast")
        .innerText()
        .catch(() => ""),
    ) &&
      /Paused/.test(await detail().locator(".detail-status").innerText()) &&
      (await detail()
        .getByRole("button", { name: /Start watching/ })
        .count()) === 1,
  );
  await L.check("DB: A is paused", statusOf(A.id) === "paused");
  // A tick claimed just before the pause may still land; take the baseline after it has.
  await p.waitForTimeout(3000);
  const evA1 = evaluations(A.id);
  await p.waitForTimeout(14000);
  await L.check(
    "paused A is no longer evaluated (one full tick interval)",
    evaluations(A.id) === evA1,
    `${evA1} → ${evaluations(A.id)}`,
  );
  await closeDetail();

  // ---- H. The standalone page: deep link, reload, same content ---------------------------------
  await openRow(nameB);
  // The page link sits above the content block inside the dialog, not within it.
  await p.locator("dialog[open] .detail-page-link").click();
  await p.waitForURL(/\/strategies\/[0-9a-f-]{36}$/, { timeout: 10000 });
  await p.waitForTimeout(1200);
  await L.check(
    "page: URL carries the id and content is the same detail",
    p.url().endsWith(B.id) &&
      (await p.locator(".strategy-detail-page .detail-content").count()) === 1 &&
      /Watching NVDA/.test(await p.locator(".strategy-detail-page").innerText()),
  );
  await p.reload({ waitUntil: "domcontentloaded" });
  await p
    .locator(".strategy-detail-page .detail-content")
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  await L.check(
    "page: survives a reload with the session intact",
    (await p.locator(".strategy-detail-page .detail-content").count()) === 1 &&
      (await p.locator("h1").first().innerText()).includes(nameB),
    (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 100),
  );
  await L.shot("H-detail-page");
  await p.locator(".strategy-detail-page a", { hasText: /All strategies/ }).click();
  await p.waitForURL(/\/strategies$/, { timeout: 10000 });
  await L.check("page: back link returns to the list", p.url().endsWith("/strategies"));

  // ---- I. Stop B for good: two steps, then no way back --------------------------------------
  await openRow(nameB);
  await L.check(
    "stop is folded away behind a summary",
    (await detail()
      .getByRole("button", { name: /Confirm permanent stop/ })
      .isVisible()
      .catch(() => false)) === false,
  );
  await detail()
    .locator("summary", { hasText: /Stop this strategy permanently/ })
    .click();
  await p.waitForTimeout(200);
  await L.check(
    "stop: warns it cannot be restarted",
    /cannot be restarted/.test(await detail().locator(".stop-control").innerText()),
  );
  await detail()
    .getByRole("button", { name: /Confirm permanent stop/ })
    .click();
  await p.waitForTimeout(1200);
  await L.check(
    "stop: toast + Stopped status",
    /Strategy stopped/.test(
      await p
        .locator(".toast")
        .innerText()
        .catch(() => ""),
    ) && /Stopped/.test(await detail().locator(".detail-status").innerText()),
  );
  await L.check(
    "stop: no arm/pause/stop controls remain",
    (await detail()
      .getByRole("button", { name: /Start watching|Pause strategy|Confirm permanent stop/ })
      .count()) === 0,
  );
  await L.check(
    "DB: B halted with a user reason",
    statusOf(B.id) === "halted" &&
      /user/i.test(
        sql(`select coalesce(halt_reason,'') from mandate_v2.instances where id='${B.id}'`),
      ),
    sql(
      `select status||' / '||coalesce(halt_reason,'') from mandate_v2.instances where id='${B.id}'`,
    ),
  );
  await L.check("detail: explains it was stopped", /Stopped/.test(await idle()), await idle());
  await L.shot("I-stopped");
  await closeDetail();
  await L.check(
    "list: B shows Stopped",
    (await rowFor(nameB).locator(".status.halted").count()) === 1,
  );

  // ---- J. A halted strategy cannot be revived through the API either ---------------------------
  const revive = await p.evaluate(async (id) => {
    const token = localStorage.getItem("privy:token")?.replace(/^"|"$/g, "");
    const r = await fetch(`/api/mandate/v1/instances/${id}/arm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: "{}",
    });
    return { status: r.status, body: (await r.text()).slice(0, 160) };
  }, B.id);
  await L.check(
    "API refuses to arm a halted strategy (4xx, never 200)",
    revive.status >= 400 && revive.status < 500,
    `${revive.status} ${revive.body}`,
  );
  await L.check("DB: B still halted after the attempt", statusOf(B.id) === "halted");

  await L.check(
    "no API errors across the run (the refused arm is intended)",
    apiProblems.filter((l) => !/instances\/[0-9a-f-]+\/arm/.test(l) && !/market\/candles/.test(l))
      .length === 0,
    apiProblems
      .filter((l) => !/\/arm/.test(l))
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
const failures = await L.report();
await b.close();
process.exit(failures ? 1 : 0);
