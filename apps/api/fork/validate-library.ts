/** Re-validate the documented strategy library against the validator the API actually exports. */
import { readdirSync, readFileSync } from "node:fs";
import { ASSETS } from "../../../packages/evm/src/index.js";
import { validatePlan } from "../../../packages/strategy/src/index.js";

const dir = new URL("../../../docs/product/strategies/", import.meta.url);
let pass = 0;
const failures: string[] = [];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const raw = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
  const plan = raw.plan ?? raw;
  const symbols: string[] = raw.assets ?? ASSETS.map((a) => a.symbol);
  const assets = ASSETS.filter((a) => symbols.includes(a.symbol));
  try {
    const parsed = validatePlan(plan, assets.length ? assets : [...ASSETS]);
    pass += 1;
    const orders = parsed.machines.flatMap((m) =>
      m.states.flatMap((s) =>
        s.transitions.flatMap((t) => t.actions.filter((a) => a.action === "order")),
      ),
    );
    console.log(
      `PASS ${file.replace(".json", "").padEnd(34)} assets=${assets.length || ASSETS.length} nodes=${parsed.nodes.length} machines=${parsed.machines.length} orders=${orders.length}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(`${file}: ${detail}`);
    console.log(`FAIL ${file.replace(".json", "").padEnd(34)} ${detail.slice(0, 90)}`);
  }
}
console.log(`\n${pass} pass, ${failures.length} fail`);
