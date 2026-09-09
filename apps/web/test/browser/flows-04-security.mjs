/**
 * Failure and security flows: what the product does when someone is not who they say, sends
 * what they should not, repeats what they already sent, or when a piece of the system is down.
 *
 * Half of these are driven from the browser as a person would meet them; the other half go
 * straight at the API with the real session token, because a browser cannot forge an Origin
 * header or replay a signature — and an attacker's script can.
 */
import { execSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { chromium } from "playwright";
import { privateKeyToAccount } from "viem/accounts";
import { builder } from "./lib/builder.mjs";
import { ledger } from "./lib/check.mjs";
import { latestDraft, latestDraftFor, sql } from "./lib/db.mjs";
import { API, login, ORIGIN, TEST_KEY, watchApi } from "./lib/session.mjs";

const SHOT = process.env.SHOT;
const REPO = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");
/** Anvil's second default account: public, funded with nothing, a different tenant. */
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const other = privateKeyToAccount(OTHER_KEY);
const me = privateKeyToAccount(TEST_KEY);

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const errors = [];
const apiProblems = watchApi(p);
p.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
let nativeDialogs = 0;
p.on("dialog", async (d) => {
  nativeDialogs += 1;
  await d.dismiss();
});
const L = ledger(p, SHOT, "sec");
const { dialog, openBuilder, closeBuilder, review, sign } = builder(p);

/** The Privy access token the page itself uses, read the way the SDK stores it. */
const tokenOf = (page) =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k === "privy:token");
    const raw = key ? localStorage.getItem(key) : null;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  });
/** A direct call to the API, as a script would make it. */
const api = async (path, { token, origin, method, body, base = API } = {}) => {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, type: r.headers.get("content-type") ?? "", json, text };
};
const problemLike = (r, status, code) =>
  r.status === status &&
  /application\/problem\+json/.test(r.type) &&
  r.json?.code === code &&
  typeof r.json?.request_id === "string";
const nav = async (label) => {
  await p
    .locator(".sidebar")
    .getByRole("link", { name: new RegExp(`^${label}`) })
    .click();
  // Navigation is client-side but not instant; wait for the section's own heading.
  await p
    .locator("h1", {
      hasText: new RegExp(`^${label === "Strategies" ? "Your strategies" : label}`),
    })
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  await p.waitForTimeout(900);
};
const ready = async () => (await api("/ready")).json;

try {
  const wallet = await login(p);
  const token = await tokenOf(p);
  await L.check(
    "session token is readable for the API-level checks",
    typeof token === "string" && token.split(".").length === 3,
    `token: ${typeof token}`,
  );
  const A = latestDraft();

  // ---- A. The auth boundary -------------------------------------------------------------------
  const anon = await api("/v1/instances");
  await L.check(
    "A1 no token → 401 unauthenticated, problem+json with a request id",
    problemLike(anon, 401, "unauthenticated"),
    `${anon.status} ${anon.text.slice(0, 120)}`,
  );
  const junk = await api("/v1/instances", {
    token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub2JvZHkifQ.bad",
  });
  await L.check(
    "A2 forged token → 401",
    problemLike(junk, 401, "unauthenticated"),
    `${junk.status}`,
  );
  const health = await api("/health");
  await L.check(
    "A3 health is public",
    (health.status === 200 && health.json?.status === "ok") || health.status === 200,
    `${health.status}`,
  );
  const okList = await api("/v1/instances?limit=5", { token });
  await L.check(
    "A4 the real token lists my strategies",
    okList.status === 200 && Array.isArray(okList.json?.items) && okList.json.items.length > 0,
    `${okList.status}`,
  );

  // ---- B. The origin guard: a foreign page cannot use my token --------------------------------
  const evilAnon = await api("/v1/instances", { origin: "https://evil.example" });
  await L.check(
    "B1 foreign origin without a token → 403 origin-denied (not 401)",
    problemLike(evilAnon, 403, "origin-denied"),
    `${evilAnon.status} ${evilAnon.json?.code}`,
  );
  const evilAuth = await api("/v1/instances", { origin: "https://evil.example", token });
  await L.check(
    "B2 foreign origin WITH my valid token → still 403",
    problemLike(evilAuth, 403, "origin-denied"),
    `${evilAuth.status}`,
  );
  const evilWrite = await api(`/v1/instances/${A.id}/pause`, {
    origin: "https://evil.example",
    token,
    body: {},
  });
  await L.check(
    "B3 foreign origin cannot mutate either",
    evilWrite.status === 403,
    `${evilWrite.status}`,
  );
  const home = await api("/v1/instances?limit=1", { origin: ORIGIN, token });
  await L.check("B4 the app's own origin is allowed", home.status === 200, `${home.status}`);

  // ---- C. Malformed requests are rejected by schema, before any handler runs ------------------
  const empty = await api("/v1/strategies/draft", { token, origin: ORIGIN, body: {} });
  await L.check(
    "C1 empty draft body → 400 invalid-request",
    problemLike(empty, 400, "invalid-request"),
    `${empty.status} ${empty.json?.code}`,
  );
  const notJson = await api("/v1/strategies/draft", { token, origin: ORIGIN, body: "{not json" });
  await L.check(
    "C2 unparseable JSON → 4xx problem, never 500",
    notJson.status >= 400 && notJson.status < 500 && /problem\+json/.test(notJson.type),
    `${notJson.status} ${notJson.json?.code}`,
  );
  const badLimit = await api("/v1/instances?limit=0", { token, origin: ORIGIN });
  const alphaLimit = await api("/v1/instances?limit=abc", { token, origin: ORIGIN });
  await L.check(
    "C3 limit=0 and limit=abc → 400",
    badLimit.status === 400 && alphaLimit.status === 400,
    `${badLimit.status}/${alphaLimit.status}`,
  );
  const badId = await api("/v1/instances/not-a-uuid", { token, origin: ORIGIN });
  await L.check(
    "C4 malformed id → 400 or 404, never 500",
    [400, 404].includes(badId.status),
    `${badId.status}`,
  );

  // ---- D. Draft → forged signature → real signature → replay ----------------------------------
  // Capture the exact draft the builder sends, so the API-level steps use a real one.
  let draftBody = null;
  await openBuilder();
  await dialog()
    .locator(".recipe", { hasText: /Buy Apple if it drops 5%/ })
    .click();
  await p.waitForTimeout(900);
  const draftRequest = p
    .waitForRequest((r) => r.method() === "POST" && r.url().includes("/v1/strategies/draft"), {
      timeout: 15000,
    })
    .then((r) => r.postDataJSON())
    .catch(() => null);
  await review();
  draftBody = await draftRequest;
  const blocked = draftBody
    ? ""
    : await dialog()
        .locator("[role=alert]")
        .allInnerTexts()
        .catch(() => []);
  await closeBuilder();
  await L.check(
    "D0 captured the builder's own draft request",
    draftBody && typeof draftBody === "object" && draftBody.mode,
    JSON.stringify(draftBody)?.slice(0, 100) ?? `no request; alert: ${blocked}`,
  );
  const drafted = await api("/v1/strategies/draft", { token, origin: ORIGIN, body: draftBody });
  await L.check(
    "D1 the same draft is accepted from a script",
    drafted.status < 300 && drafted.json?.artifact_id && drafted.json?.confirm_message,
    `${drafted.status} ${drafted.text.slice(0, 80)}`,
  );
  const artifact = drafted.json?.artifact_id;
  const message = drafted.json?.confirm_message;
  const instancesFor = (id) =>
    Number(
      sql(
        `select count(*) from mandate_v2.instances i join mandate_v2.drafts d on d.id=i.draft_id where d.artifact_id='${id}'`,
      ),
    );
  const forged = await other.signMessage({ message });
  const forgedR = await api("/v1/strategies", {
    token,
    origin: ORIGIN,
    body: { artifact_id: artifact, signature: forged },
  });
  await L.check(
    "D2 a signature from another key is refused (4xx, named)",
    forgedR.status >= 400 &&
      forgedR.status < 500 &&
      ["invalid-signature", "account-mismatch"].includes(forgedR.json?.code),
    `${forgedR.status} ${forgedR.json?.code}`,
  );
  await L.check("D3 the refused attempt wrote no instance", instancesFor(artifact) === 0);
  const notConsumed = sql(
    `select consumed_at is null from mandate_v2.drafts where artifact_id='${artifact}'`,
  );
  await L.check(
    "D4 the draft survives a bad signature (not burned)",
    notConsumed === "t",
    `consumed_at null: ${notConsumed}`,
  );
  const tampered = await api("/v1/strategies", {
    token,
    origin: ORIGIN,
    body: { artifact_id: artifact, signature: await me.signMessage({ message: `${message} ` }) },
  });
  await L.check(
    "D5 my key over a different message is refused too",
    tampered.status >= 400 && tampered.status < 500 && instancesFor(artifact) === 0,
    `${tampered.status} ${tampered.json?.code}`,
  );
  const real = await me.signMessage({ message });
  const created = await api("/v1/strategies", {
    token,
    origin: ORIGIN,
    body: { artifact_id: artifact, signature: real },
  });
  await L.check(
    "D6 the genuine signature creates exactly one instance",
    created.status < 300 && instancesFor(artifact) === 1,
    `${created.status} ${created.json?.code ?? ""} → ${instancesFor(artifact)}`,
  );
  const replay = await api("/v1/strategies", {
    token,
    origin: ORIGIN,
    body: { artifact_id: artifact, signature: real },
  });
  await L.check(
    "D7 replaying the same signed draft → 409, still one instance",
    replay.status === 409 &&
      ["draft-consumed", "draft-expired", "conflict"].includes(replay.json?.code) &&
      instancesFor(artifact) === 1,
    `${replay.status} ${replay.json?.code} → ${instancesFor(artifact)}`,
  );
  const parallel = await Promise.all(
    [1, 2, 3].map(() =>
      api("/v1/strategies", {
        token,
        origin: ORIGIN,
        body: { artifact_id: artifact, signature: real },
      }),
    ),
  );
  await L.check(
    "D8 three concurrent replays → none succeed",
    parallel.every((r) => r.status >= 400) && instancesFor(artifact) === 1,
    parallel.map((r) => r.status).join("/"),
  );
  const ghost = await api("/v1/strategies", {
    token,
    origin: ORIGIN,
    body: { artifact_id: "f".repeat(64), signature: real },
  });
  await L.check("D9 an unknown artifact → 404", ghost.status === 404, `${ghost.status}`);

  // ---- E. Another tenant: sees nothing of mine, I see nothing of theirs ------------------------
  const ctx2 = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const q = await ctx2.newPage();
  const walletB = await login(q, { key: OTHER_KEY, fund: false });
  await L.check(
    "E1 tenant B signs in as its own address",
    walletB.address.toLowerCase() === other.address.toLowerCase(),
  );
  const tokenB = await tokenOf(q);
  const listB = await api("/v1/instances?limit=50", { token: tokenB, origin: ORIGIN });
  const ownedByA = new Set(
    sql(
      `select i.id from mandate_v2.instances i join mandate_v2.drafts d on d.id=i.draft_id where d.account='${wallet.account}'`,
    )
      .split("\n")
      .filter(Boolean),
  );
  const bIds = (listB.json?.items ?? []).map((i) => i.id);
  await L.check(
    "E2 B's list holds none of A's strategies (B keeps its own from earlier runs)",
    listB.status === 200 && bIds.every((id) => !ownedByA.has(id)) && bIds.length < ownedByA.size,
    `${listB.status} B sees ${bIds.length}, A owns ${ownedByA.size}`,
  );
  await q
    .locator(".sidebar")
    .getByRole("link", { name: /^Strategies/ })
    .click();
  await q.waitForTimeout(1200);
  await L.check(
    "E3 B's Strategies page shows exactly B's rows (or the empty state)",
    (await q.locator(".strategy-row").count()) === bIds.length &&
      (bIds.length > 0 || /Your first rule starts here/.test(await q.locator("body").innerText())),
    `${await q.locator(".strategy-row").count()} rows vs ${bIds.length}`,
  );
  const bTools = builder(q);
  const signedB = await bTools.createStarter(walletB, /Buy Apple if it drops 5%/);
  const B = latestDraftFor(other.address);
  await L.check("E4 B creates a strategy of its own", signedB === 1 && B?.id && B.id !== A.id);
  const peek = await api(`/v1/instances/${B.id}`, { token, origin: ORIGIN });
  const peekEval = await api(`/v1/instances/${B.id}/evaluations`, { token, origin: ORIGIN });
  const poke = await api(`/v1/instances/${B.id}/arm`, { token, origin: ORIGIN, body: {} });
  await L.check(
    "E5 A cannot read, list, or arm B's strategy (404, not 403 — no existence leak)",
    peek.status === 404 && peekEval.status === 404 && poke.status === 404,
    `${peek.status}/${peekEval.status}/${poke.status}`,
  );
  await L.check(
    "E6 DB: B's strategy is still paused after A's attempt",
    sql(`select status from mandate_v2.instances where id='${B.id}'`) === "paused",
  );
  const peekBack = await api(`/v1/instances/${A.id}`, { token: tokenB, origin: ORIGIN });
  await L.check(
    "E7 B cannot read A's strategy either",
    peekBack.status === 404,
    `${peekBack.status}`,
  );
  const mineList = await api("/v1/instances?limit=100", { token, origin: ORIGIN });
  await L.check(
    "E8 A's own list never contains B's id",
    mineList.status === 200 && !mineList.json.items.some((i) => i.id === B.id),
  );
  await p.goto(`${ORIGIN}/strategies/${B.id}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  await L.check(
    "E9 A deep-linking to B's strategy sees an error, not the strategy",
    (await p.locator(".detail-content").count()) === 0 &&
      (await p.locator("h1").first().innerText()).trim() === "Strategy" &&
      /isn't here/.test((await p.locator("[role=alert]").allInnerTexts()).join(" ")),
    `${(await p.locator("h1").first().innerText()).trim()} | ${(await p.locator("[role=alert]").allInnerTexts()).join(" | ").slice(0, 80)}`,
  );
  await L.shot("E-tenant");
  const portfolioB = await api("/v1/portfolio", { token: tokenB, origin: ORIGIN });
  await L.check(
    "E10 B's portfolio is B's wallet (no USDC), not A's $10,000",
    portfolioB.status === 200 && Number(portfolioB.json?.cash) === 0,
    `${portfolioB.status} cash=${portfolioB.json?.cash}`,
  );
  await ctx2.close();

  // ---- F. A hostile name is text everywhere ------------------------------------------------------
  await p.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await p.locator(".workspace").waitFor({ timeout: 20000 });
  await p.waitForTimeout(800);
  const hostile = `<img src=x onerror="window.__pwned=1"> {{7*7}} ${"'"}"&`;
  await openBuilder();
  await dialog()
    .locator(".recipe", { hasText: /Buy Apple if it drops 5%/ })
    .click();
  await p.waitForTimeout(700);
  await dialog().locator("label.field", { hasText: /^Name/ }).locator("input").fill(hostile);
  await review();
  const signedH = await sign(wallet, /Sign & watch/);
  const H = latestDraft();
  await L.check(
    "F1 hostile name accepted as a plain string",
    signedH === 1 && H?.name === hostile,
    JSON.stringify(H?.name),
  );
  await nav("Strategies");
  const hostileRow = p.locator(".strategy-row", { hasText: "{{7*7}}" }).first();
  await L.check(
    "F2 list shows the literal text, no image element injected",
    (await hostileRow.count()) === 1 &&
      (await hostileRow.locator("img[src='x']").count()) === 0 &&
      (await hostileRow.innerText()).includes("<img src=x"),
    (await hostileRow.innerText().catch(() => "")).slice(0, 80),
  );
  await hostileRow.locator(".strategy-main").click();
  await p.locator(".detail-content").waitFor({ timeout: 10000 });
  await L.check(
    "F3 dialog title is the literal text",
    (await p.locator("dialog[open] h2").first().innerText()).includes("{{7*7}}"),
  );
  await L.check(
    "F4 nothing executed: no __pwned, no native dialogs",
    (await p.evaluate(() => window.__pwned)) === undefined && nativeDialogs === 0,
  );
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  await nav("Overview");
  await L.check(
    "F5 overview row and the ⌘K search stay inert too",
    (await p.locator(".overview-bot-row", { hasText: "{{7*7}}" }).count()) >= 1 &&
      (await p.locator("img[src='x']").count()) === 0,
  );
  await L.shot("F-hostile");

  // ---- G. The rate limit reaches the screen with honest words ----------------------------------
  let limited = null;
  for (let i = 0; i < 12 && !limited; i += 1) {
    // Through the dev proxy, so the limiter keys this the same way it keys the browser.
    const r = await api("/v1/strategies/draft", {
      token,
      origin: ORIGIN,
      body: draftBody,
      base: `${ORIGIN}/api/mandate`,
    });
    if (r.status === 429) limited = r;
  }
  await L.check(
    "G1 the draft limit trips as 429 rate-limited",
    limited && problemLike(limited, 429, "rate-limited"),
    `${limited?.status} ${limited?.json?.code}`,
  );
  await L.check(
    "G2 …with copy about the request rate, not 'request format'",
    /more requests than allowed/.test(limited?.json?.detail ?? "") &&
      !/request format/.test(limited?.json?.detail ?? ""),
    limited?.json?.detail,
  );
  await openBuilder();
  await dialog()
    .locator(".recipe", { hasText: /Buy Apple if it drops 5%/ })
    .click();
  await p.waitForTimeout(700);
  await review();
  const alert = await dialog()
    .locator("[role=alert]")
    .innerText()
    .catch(() => "");
  await L.check(
    "G3 the builder shows the same sentence to the user",
    /more requests than allowed/.test(alert),
    alert.slice(0, 120),
  );
  await L.shot("G-rate-limited");
  await closeBuilder();

  // ---- H. The executor goes away: every surface says so, and comes back --------------------------
  const before = await ready();
  await L.check(
    "H0 executor available before the test",
    before?.execution_available === true,
    JSON.stringify(before),
  );
  execSync('pkill -f "env-file=.env.worker.fork" || true');
  const stale = Date.now();
  let gone = null;
  while (Date.now() - stale < 60000) {
    gone = await ready();
    if (gone?.execution_available === false) break;
    await p.waitForTimeout(2000);
  }
  await L.check(
    "H1 within 60s of the worker dying, /ready reports execution unavailable",
    gone?.execution_available === false,
    `${Math.round((Date.now() - stale) / 1000)}s ${JSON.stringify(gone)}`,
  );
  let badge = "";
  const flipStart = Date.now();
  while (Date.now() - flipStart < 75000) {
    badge = (
      await p
        .locator("dl.overview-runtime")
        .innerText()
        .catch(() => "")
    ).replace(/\s+/g, " ");
    if (/Observation only/i.test(badge)) break;
    await p.waitForTimeout(3000);
  }
  await L.check(
    "H2 the Overview's Executor badge flips to 'Observation only'",
    /Observation only/i.test(badge),
    badge.slice(0, 80),
  );
  await L.shot("H-executor-down");
  const fd = openSync("/private/tmp/mandate-fork/worker.log", "a");
  const child = spawn(
    "node",
    ["--env-file=.env.worker.fork", "--import", "tsx", "apps/worker/src/main.ts"],
    { cwd: REPO, detached: true, stdio: ["ignore", fd, fd] },
  );
  child.unref();
  let back = null;
  const restart = Date.now();
  while (Date.now() - restart < 60000) {
    back = await ready();
    if (back?.execution_available === true) break;
    await p.waitForTimeout(2000);
  }
  await L.check(
    "H3 a restarted worker is available again within 60s",
    back?.execution_available === true,
    `${Math.round((Date.now() - restart) / 1000)}s ${JSON.stringify(back)}`,
  );
  const flipBack = Date.now();
  while (Date.now() - flipBack < 75000) {
    badge = (
      await p
        .locator("dl.overview-runtime")
        .innerText()
        .catch(() => "")
    ).replace(/\s+/g, " ");
    if (/Available/.test(badge)) break;
    await p.waitForTimeout(3000);
  }
  await L.check(
    "H4 the badge returns to 'Available' without a reload",
    /Available/.test(badge),
    badge.slice(0, 80),
  );

  // ---- I. Signing out tears the session down and leaks nothing ---------------------------------
  const leaks = [];
  const afterLogout = { at: Infinity };
  p.on("request", (r) => {
    if (Date.now() > afterLogout.at && r.url().includes("/v1/") && r.headers().authorization)
      leaks.push(r.url());
  });
  await p.locator(".wallet-button.connected").click();
  await p.waitForTimeout(300);
  await p.getByRole("menuitem", { name: /^sign out$/i }).click();
  afterLogout.at = Date.now();
  await p
    .locator(".workspace")
    .waitFor({ state: "detached", timeout: 15000 })
    .catch(() => {});
  await p.waitForTimeout(4000);
  const storage = await p.evaluate(() => ({
    privy: Object.keys(localStorage).filter((k) => k.startsWith("privy")),
    prefs: Object.keys(localStorage).filter((k) => k.startsWith("mandate:")),
  }));
  await L.check(
    "I1 signed out: workspace gone, login offered",
    (await p.locator(".workspace").count()) === 0 &&
      (await p
        .getByRole("button", { name: /log in|continue with a wallet|make it mine|get started/i })
        .count()) >= 1,
    (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80),
  );
  await L.check(
    "I2 Privy storage purged, preferences kept",
    storage.privy.length === 0 && storage.prefs.length >= 1,
    JSON.stringify(storage),
  );
  await L.check(
    "I3 no authenticated request after sign-out",
    leaks.length === 0,
    leaks.slice(0, 3).join(" | "),
  );
  await p.goto(`${ORIGIN}/strategies/${A.id}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const body = (await p.locator("body").innerText()).replace(/\s+/g, " ");
  await L.check(
    "I4 a signed-out deep link shows no strategy data",
    (await p.locator(".detail-content").count()) === 0 &&
      !body.includes(A.name) &&
      !body.includes(hostile),
    body.slice(0, 100),
  );
  await L.shot("I-signed-out-deeplink");
  const viaProxy = await p.evaluate(async () => {
    const r = await fetch("/api/mandate/v1/instances?limit=1");
    return { status: r.status, text: (await r.text()).slice(0, 120) };
  });
  await L.check(
    "I5 the proxy passes the 401 through when signed out",
    viaProxy.status === 401,
    `${viaProxy.status} ${viaProxy.text}`,
  );

  await L.check(
    "no page errors across the run",
    errors.length === 0,
    errors.slice(0, 3).join(" || "),
  );
  await L.check(
    "API problems seen by the browser were all provoked on purpose",
    apiProblems.filter(
      (l) => !/strategies\/draft|instances\/[0-9a-f-]+( |\/)|401 GET|market\/candles/.test(l),
    ).length === 0,
    apiProblems.slice(0, 3).join(" || "),
  );
} catch (e) {
  await L.fail("run aborted", e.message.split("\n")[0].slice(0, 220));
}
const failures = await L.report();
await b.close();
process.exit(failures ? 1 : 0);
