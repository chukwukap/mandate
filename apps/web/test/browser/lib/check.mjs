/** A tiny result ledger: PASS/FAIL/SKIP rows, a screenshot on every failure, exit code = failures. */
export function ledger(page, shotDir, prefix) {
  const rows = [];
  const record = async (status, name, detail = "") => {
    rows.push({ status, name, detail });
    if (status === "FAIL")
      await page
        .screenshot({ path: `${shotDir}/${prefix}-FAIL-${rows.length}.png`, fullPage: true })
        .catch(() => {});
  };
  return {
    rows,
    async check(name, cond, detail = "") {
      await record(cond ? "PASS" : "FAIL", name, detail);
      return cond;
    },
    async skip(name, why) {
      await record("SKIP", name, why);
    },
    async fail(name, why) {
      await record("FAIL", name, why);
    },
    async shot(name) {
      await page
        .screenshot({ path: `${shotDir}/${prefix}-${name}.png`, fullPage: true })
        .catch(() => {});
    },
    report() {
      const w = Math.max(...rows.map((r) => r.name.length));
      for (const r of rows) console.log(`${r.status.padEnd(4)} ${r.name.padEnd(w)}  ${r.detail}`);
      const fails = rows.filter((r) => r.status === "FAIL").length;
      console.log(
        `\n${rows.filter((r) => r.status === "PASS").length} pass, ${fails} fail, ${rows.filter((r) => r.status === "SKIP").length} skip`,
      );
      return fails;
    },
  };
}
