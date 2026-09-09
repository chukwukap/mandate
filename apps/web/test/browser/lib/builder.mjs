/**
 * Driving the strategy builder the way a person does: through the dialog, by label.
 *
 * Every helper takes the page so the suites share one vocabulary — `openBuilder`, `review`,
 * `sign` — and a change to the builder's markup is a change in one file.
 */
export const builder = (p) => {
  const dialog = () => p.locator("dialog[open]");
  const title = async () =>
    (
      await dialog()
        .locator("h2")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
  const openBuilder = async () => {
    await p.locator(".sidebar-new").click();
    await dialog().waitFor({ timeout: 10000 });
    await p.waitForTimeout(400);
  };
  const closeBuilder = async () => {
    await p.keyboard.press("Escape");
    await dialog()
      .waitFor({ state: "detached", timeout: 5000 })
      .catch(() => {});
    await p.waitForTimeout(300);
  };
  const money = (i) => dialog().locator(".money .field.big input").nth(i);
  const preview = async () =>
    (
      await dialog()
        .locator(".preview")
        .innerText()
        .catch(() => "")
    ).replace(/\s+/g, " ");
  const review = async () => {
    // The setup column scrolls; after typing at its foot, bring the action back into view.
    const submit = dialog().locator('button[type="submit"]');
    await submit.scrollIntoViewIfNeeded();
    await submit.click({ timeout: 15000 });
    await p.waitForTimeout(1500);
  };
  /** Clicks the signing button and returns how many `personal_sign` calls the wallet saw. */
  const sign = async (wallet, label) => {
    const before = wallet.log.filter((m) => m === "personal_sign").length;
    await dialog().getByRole("button", { name: label }).click();
    await dialog()
      .waitFor({ state: "detached", timeout: 30000 })
      .catch(() => {});
    await p.waitForTimeout(800);
    return wallet.log.filter((m) => m === "personal_sign").length - before;
  };
  /**
   * A starter, signed as-is in manual mode. The fastest honest way for a lifecycle suite to
   * get a strategy it owns.
   */
  const createStarter = async (wallet, pattern, edit) => {
    await openBuilder();
    await dialog().locator(".recipe", { hasText: pattern }).click();
    await p.waitForTimeout(700);
    if (edit) await edit({ dialog, money });
    await review();
    return sign(wallet, /Sign & watch/);
  };
  return { dialog, title, openBuilder, closeBuilder, money, preview, review, sign, createStarter };
};
