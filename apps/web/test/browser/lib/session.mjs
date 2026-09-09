import { execSync } from "node:child_process";
import { setAccount } from "./db.mjs";
import { attachWallet } from "./wallet.mjs";

/** anvil account #1. Funded on the fork by apps/api/fork/fund-user.ts; a plain EOA by design. */
export const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const ORIGIN = "http://localhost:3000";
const REPO = new URL("../../../../..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Sign in the way a person does: through the onboarding, Privy's modal, and a SIWE signature
 * from an injected wallet. Returns the wallet log so a test can assert on what was signed.
 *
 * Every Playwright context is a fresh browser profile, so onboarding shows every time — which
 * is also the honest first-run experience and worth walking each run.
 */
export async function login(page, { key = TEST_KEY, fund = true } = {}) {
  let selectedMe = null;
  const observeMe = async (response) => {
    if (new URL(response.url()).pathname !== "/api/mandate/v1/me" || !response.ok()) return;
    const value = await response.json().catch(() => null);
    if (value?.wallet) selectedMe = value;
  };
  page.on("response", observeMe);
  const wallet = await attachWallet(page, key);
  // Not networkidle: the overview keeps market polls in flight that take seconds each, and
  // networkidle wants half a second of silence it may never get. Wait for the thing itself.
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: /make it mine|^log ?in$/i })
    .first()
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  // Onboarding: "Make it mine" then Continue until "Log in" appears. Bounded so a changed
  // flow fails loudly rather than clicking forever.
  for (let i = 0; i < 8; i++) {
    const login = page.getByRole("button", { name: /^log ?in$/i }).first();
    if (await login.count()) {
      await login.click();
      break;
    }
    const next = page.getByRole("button", { name: /make it mine|^continue$/i }).first();
    if (!(await next.count()))
      throw new Error(
        `login: no way forward at step ${i}; buttons: ${(await page.getByRole("button").allInnerTexts()).join(" | ")}`,
      );
    await next.click();
    await page.waitForTimeout(700);
  }
  await page.getByRole("button", { name: /continue with a wallet/i }).click({ timeout: 15000 });
  await page
    .getByText(/Mandate Test Wallet/i)
    .first()
    .click({ timeout: 15000 });
  await page.locator(".workspace").waitFor({ timeout: 30000 });
  if (!wallet.log.includes("personal_sign"))
    throw new Error(`login: no SIWE signature requested; log=${wallet.log.join(",")}`);
  // Privy leaves a "Successfully connected" card over the page. A person closes it; left up, it
  // intercepts the next click and every later step times out for a reason that looks unrelated.
  const done = page.locator("#privy-modal-content, [id^='privy-dialog']").first();
  if (await done.count()) {
    const close = done.getByRole("button").first();
    if (await close.count()) await close.click().catch(() => {});
    await done.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  }
  // The account the app trades from is the Privy embedded wallet, read the way the app reads
  // it. On the fork it starts empty, so a fresh one is given USDC before the balance is read.
  // Observe the app's authenticated request, including its selected-wallet header.
  // An unqualified /me request intentionally has no selected account for multi-wallet users.
  for (let i = 0; i < 100 && !selectedMe?.automation?.wallet; i++) await page.waitForTimeout(200);
  page.off("response", observeMe);
  const me = selectedMe;
  if (!me?.wallet) throw new Error("login: the app did not select a wallet");
  wallet.account = me.wallet.toLowerCase();
  wallet.automation = me.automation ?? null;
  setAccount(wallet.account);
  if (fund) {
    const held = BigInt(
      execSync(
        `cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 'balanceOf(address)(uint256)' ${wallet.account} --rpc-url http://127.0.0.1:8545`,
        { encoding: "utf8" },
      )
        .trim()
        .split(" ")[0],
    );
    if (held < 1_000_000_000n)
      execSync(`${REPO}/scripts/dev/fork-fund.sh ${wallet.account} 10000`, { stdio: "ignore" });
  }
  // The overview reads balances after mount; assert on a loaded page, not a loading one.
  await page
    .getByText(/\$[\d,]+\.\d{2}/)
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  return wallet;
}

/** The API the web app proxies to, for asserting backend state directly. */
export const API = "http://127.0.0.1:8081";

/**
 * Every API response that was not a success, with its body, in order.
 *
 * A failed check says what the screen showed; this says what the server said. Attach before
 * login so the first request of the session is covered too.
 */
export function watchApi(page) {
  const problems = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/v1/") || response.status() < 400) return;
    let body = "";
    try {
      body = (await response.text()).slice(0, 300);
    } catch {}
    problems.push(
      `${response.status()} ${response.request().method()} ${response.url().replace(/^https?:\/\/[^/]+/, "")} ${body}`,
    );
  });
  return problems;
}
