import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const origin = process.env.MANDATE_WEB_URL ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("apps/web/test-results", { recursive: true });
async function accessibility(label) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.target) })),
  );
  assert.deepEqual(violations, [], `${label}: ${JSON.stringify(violations)}`);
}
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForURL("**/welcome");
  await accessibility("Welcome");
  await page.screenshot({ path: "apps/web/test-results/onboarding-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Make it mine" }).click();
  await page.getByRole("button", { name: "Apple AAPLc" }).click();
  await accessibility("Stock and intent choices");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await accessibility("Wallet introduction");
  assert.ok(await page.locator(".onboarding-summary").getByText("Apple", { exact: true }).count());
  await page.setViewportSize({ width: 390, height: 844 });
  await accessibility("Mobile onboarding");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "apps/web/test-results/onboarding-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Explore the sample workspace" }).click();
  await page.waitForURL("**/?preview=1");
  await page.reload({ waitUntil: "networkidle" });
  await accessibility("Mobile markets");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.waitForURL("**/settings?preview=1");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?preview=1`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New strategy", exact: true }).last().click();
  await page.getByLabel("Strategy name").fill("Patient entry");
  await page.getByLabel("Target price").fill("220");
  await page.getByLabel("Amount per buy").fill("1000");
  await page.getByLabel("Total budget").fill("100");
  await page.getByRole("button", { name: "Review strategy", exact: true }).click();
  assert.ok(await page.locator("[role=alert]").count());
  await page.getByLabel("Amount per buy").fill("10");
  await page.getByText("Advanced limits", { exact: true }).click();
  await page.getByLabel("Daily budget", { exact: true }).fill("50");
  await page.getByLabel("Orders per day", { exact: true }).fill("2");
  await accessibility("Strategy authoring");
  await page.getByRole("button", { name: "Review strategy", exact: true }).click();
  assert.match(await page.locator(".signed-review").innerText(), /At most 2 orders/);
  await page.getByRole("button", { name: "Save preview", exact: true }).click();
  await page.locator("nav a").nth(1).click();
  await page.waitForURL("**/strategies?preview=1");
  await page.getByText("Patient entry", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: /Buy the NVIDIA dip/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Pause strategy", exact: true }).click();
  await page.getByRole("link", { name: "Open strategy page" }).click();
  await page.waitForURL("**/strategies/preview-1?preview=1");
  await page.locator(".strategy-detail-page").waitFor();
  await page.getByText("Stop this strategy permanently", { exact: true }).click();
  await page.getByRole("button", { name: "Confirm permanent stop", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Start watching", exact: true }).count(), 0);
  await accessibility("Strategy detail");
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search company or ticker").fill("Apple");
  assert.match(await page.locator(".command-results").innerText(), /AAPLc/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  for (const route of ["/", "/strategies", "/activity", "/settings"]) {
    await page.goto(`${origin}${route}?preview=1`, { waitUntil: "networkidle" });
    await accessibility(route);
  }
  await page.goto(`${origin}/?preview=1`, { waitUntil: "networkidle" });
  await page.screenshot({ path: "apps/web/test-results/workspace-desktop.png", fullPage: true });
  await page.goto(origin, { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(await page.getByText("Sample price history", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: onboarding, persisted skip, responsive layouts, authoring, budget validation, strategy navigation, pause/stop, keyboard search, and axe accessibility.",
  );
} finally {
  await browser.close();
}
