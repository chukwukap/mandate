import { afterEach, expect, spyOn, test } from "bun:test";
import { request } from "../../src/lib/api";

let stub: ReturnType<typeof spyOn> | undefined;
afterEach(() => stub?.mockRestore());
test("forwards selected wallet and bearer token while preserving string amounts", async () => {
  let init: RequestInit | undefined;
  stub = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
        expect(String(url)).toBe("/api/mandate/v1/strategies/draft");
        init = options;
        return Response.json({ artifact_id: "review" });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  await request("/v1/strategies/draft", {
    token: "fixture-token",
    wallet: "0x123",
    body: { amount: "0.000001" },
  });
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
  expect(new Headers(init?.headers).get("X-Mandate-Wallet")).toBe("0x123");
  expect(init?.body).toBe('{"amount":"0.000001"}');
  expect(init?.method).toBe("POST");
});
test("an unavailable API produces an error instead of sample data", async () => {
  stub = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ detail: "Worker unavailable" }, { status: 503 }),
  );
  await expect(request("/v1/market")).rejects.toThrow("Worker unavailable");
});
