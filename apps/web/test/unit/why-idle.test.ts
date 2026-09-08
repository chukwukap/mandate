import { describe, expect, test } from "bun:test";
import { EVALUATION_OUTCOMES } from "../../../../packages/contracts/src/types/instances";
import { REFUSALS } from "../../../../packages/strategy/src/enforcement/envelope";
import { type Evaluation, whyIdle } from "../../src/features/strategies/why-idle";

const at = "2026-09-08T12:00:00.000Z";
const evaluation = (over: Partial<Evaluation>): Evaluation => ({
  id: "e",
  at,
  outcome: "evaluated",
  admitted: 0,
  refused: null,
  ...over,
});

describe("why a strategy is idle", () => {
  test("a cooldown reads as waiting, not as failure", () => {
    // The recurring shape refuses on every tick between buys. If that read as an error, a
    // working daily strategy would look broken hundreds of times a day.
    const idle = whyIdle(evaluation({ refused: "Cooldown active" }), "armed");
    expect(idle?.tone).toBe("waiting");
    expect(idle?.headline).toMatch(/next scheduled buy/i);
  });

  test("an empty wallet reads as something to act on, and says what", () => {
    const idle = whyIdle(evaluation({ refused: "Insufficient USDC balance" }), "armed");
    expect(idle?.tone).toBe("attention");
    expect(idle?.action).toMatch(/Add USDC/);
  });

  test("a closed market is explained rather than left as jargon", () => {
    const idle = whyIdle(evaluation({ outcome: "observation-or-authority-unavailable" }), "armed");
    expect(idle?.headline).toMatch(/market to open/i);
    expect(idle?.action).toMatch(/9:35am/);
  });

  test("a fill and a quiet watch are both reported as healthy", () => {
    expect(whyIdle(evaluation({ admitted: 2 }), "armed")?.tone).toBe("ok");
    expect(whyIdle(evaluation({}), "armed")?.tone).toBe("ok");
  });

  test("status wins over the last tick, because a paused strategy is not waiting on the market", () => {
    const stale = evaluation({ refused: "Cooldown active" });
    expect(whyIdle(stale, "paused")?.headline).toBe("Paused");
    expect(whyIdle(stale, "ended")?.headline).toBe("Stopped");
  });

  test("a strategy that has never ticked says so instead of showing nothing", () => {
    expect(whyIdle(null, "armed")?.headline).toMatch(/not checked yet/i);
  });

  /**
   * The two vocabularies come from the backend. If either grows a value this file does not
   * translate, a user sees a blank panel where an explanation should be — so the test fails
   * here rather than in front of them.
   */
  test("every refusal the engine can emit has a translation", () => {
    for (const refusal of Object.values(REFUSALS)) {
      const idle = whyIdle(evaluation({ refused: refusal }), "armed");
      expect(idle, `no translation for refusal: ${refusal}`).not.toBeNull();
      expect(idle?.headline.length, `empty headline for: ${refusal}`).toBeGreaterThan(0);
    }
  });

  test("every evaluation outcome has a translation", () => {
    for (const outcome of EVALUATION_OUTCOMES) {
      const idle = whyIdle(evaluation({ outcome }), "armed");
      expect(idle, `no translation for outcome: ${outcome}`).not.toBeNull();
    }
  });

  /**
   * The most expensive way to be wrong here: telling someone they bought when the permission
   * was never approved and every "order" was a recorded signal.
   */
  test("asked for automatic but running as signals is called out, over any tick result", () => {
    const bought = evaluation({ admitted: 3 });
    const pending = whyIdle(bought, "armed", "manual", "auto");
    expect(pending?.tone).toBe("attention");
    expect(pending?.headline).toMatch(/approval needed/i);
    expect(pending?.action).toMatch(/signals only/i);
    // Once the permission is active the same tick reads normally again.
    expect(whyIdle(bought, "armed", "auto", "auto")?.tone).toBe("ok");
    // A strategy the user deliberately created as signal-only is not nagged.
    expect(whyIdle(bought, "armed", "manual", "manual")?.tone).toBe("ok");
  });
});
