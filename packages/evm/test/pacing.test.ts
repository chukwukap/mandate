import { expect, test } from "bun:test";
import { pacedFetch } from "../src/clients/paced-fetch.js";

test("RPC pacing rejects overload and releases capacity after completion", async () => {
  const request = pacedFetch(1, 1);
  const first = request("data:text/plain,ok");
  await expect(request("data:text/plain,overload")).rejects.toThrow("queue is full");
  expect(await (await first).text()).toBe("ok");
  expect(await (await request("data:text/plain,next")).text()).toBe("next");
});
test("cancelled RPC work is not dispatched", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    pacedFetch(1)("data:text/plain,unused", { signal: controller.signal }),
  ).rejects.toThrow("cancelled");
});
