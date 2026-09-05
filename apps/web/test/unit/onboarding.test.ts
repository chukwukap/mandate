import { expect, test } from "bun:test";
import { parseOnboarding } from "../../src/features/onboarding/state";

test("persisted onboarding validates version and choices, preserving skip", () => {
  const choice = { version: 1, status: "skipped", symbol: "AAPLc", mode: "manual" } as const;
  expect(parseOnboarding(JSON.stringify(choice))).toEqual(choice);
  for (const value of [
    null,
    "{",
    "[]",
    JSON.stringify({ ...choice, version: 2 }),
    JSON.stringify({ ...choice, symbol: "UNKNOWN" }),
    JSON.stringify({ ...choice, mode: "unlimited" }),
    JSON.stringify({ ...choice, status: "started" }),
  ])
    expect(parseOnboarding(value)).toBeNull();
});
