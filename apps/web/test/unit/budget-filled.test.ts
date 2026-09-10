import { expect, test } from "bun:test";
import { budgetFilled } from "../../src/features/strategies/strategy-row";

/**
 * The budget bar on a strategy row.
 *
 * Every case here is a shape the API has actually produced or could: a fresh strategy that has
 * spent nothing, one part-way through its budget, and one whose figures are missing entirely.
 * The last is the one that mattered — a missing figure used to render the bar full, telling a
 * user their budget was exhausted on the single row we knew nothing about.
 */

test("an untouched budget reads empty and a finished one reads full", () => {
  expect(budgetFilled("0", "600")).toBe(0);
  expect(budgetFilled("600", "600")).toBe(100);
  expect(budgetFilled("50", "600")).toBeCloseTo(8.333, 3);
});

test("a missing figure reads as nothing spent, never as a spent budget", () => {
  // `Math.max(1, NaN)` is NaN, so the previous arithmetic produced `width: NaN%` here and CSS
  // dropped the declaration, leaving the bar at its full natural width.
  for (const [spent, cap] of [
    [undefined, undefined],
    [undefined, "600"],
    ["50", undefined],
    [null, null],
    ["", ""],
    ["not-a-number", "600"],
  ] as const)
    expect(budgetFilled(spent, cap)).toBe(0);
});

test("a zero or negative cap cannot divide, and does not report a full bar", () => {
  // A zero lifetime is not a strategy that has spent everything; it is one that can spend
  // nothing, and dividing by it would be Infinity clamped to a full bar.
  expect(budgetFilled("0", "0")).toBe(0);
  expect(budgetFilled("10", "0")).toBe(0);
  expect(budgetFilled("10", "-5")).toBe(0);
});

test("the bar stays inside its track whatever the numbers say", () => {
  // Caps count every order admitted, including ones later refunded, so spent can exceed the
  // signed lifetime. The row still has to draw inside its own width.
  expect(budgetFilled("900", "600")).toBe(100);
  expect(budgetFilled("-10", "600")).toBe(0);
});
