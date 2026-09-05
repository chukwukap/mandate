import type { HttpTransportConfig } from "viem";

/** Bound public-RPC bursts and queue length; no unbounded work after overload. */
export function pacedFetch(
  spacingMs = 1200,
  maxPending = 12,
): NonNullable<HttpTransportConfig["fetchFn"]> {
  let nextStart = 0;
  let pending = 0;
  return async (input, init) => {
    if (pending >= maxPending) throw new Error("RPC request queue is full");
    pending++;
    const now = Date.now();
    const delay = Math.max(0, nextStart - now);
    nextStart = Math.max(now, nextStart) + spacingMs;
    try {
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (init?.signal?.aborted) throw new Error("RPC request cancelled");
      return await fetch(input, init);
    } finally {
      pending--;
    }
  };
}
