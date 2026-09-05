import type { HttpTransportConfig } from "viem";

/**
 * Default gap between outbound RPC requests, in milliseconds.
 *
 * This is a throughput ceiling, not a politeness gesture, so it is set from measurement.
 *
 * At the original 1200ms a single `/v1/market` refresh — four assets, each needing a reference
 * read and a routed quote across six tick spacings — issues roughly eighteen batches and so took
 * 22.85s against a 10s snapshot deadline. Every asset after the first reported
 * "chain-unavailable", which is indistinguishable to a caller from Base actually being down. The
 * pacer was the entire cost: 18 x 1.2s is 21.6s of deliberate sleeping.
 *
 * 120ms is ~8 requests/second, comfortably under what the public Base endpoints tolerate
 * (measured: three endpoints answering concurrent eth_calls in ~0.85s each without shedding) and
 * fast enough that the same refresh lands in roughly two seconds.
 *
 * Override with RPC_SPACING_MS. A paid endpoint can set it to 0; the pacer then only enforces the
 * queue bound, which is the part that protects this process rather than the endpoint.
 */
export const DEFAULT_SPACING_MS = 120;

/** Requests allowed to be in flight or waiting before the pacer refuses more. */
export const DEFAULT_MAX_PENDING = 24;

function configuredSpacing(): number {
  const raw = process.env.RPC_SPACING_MS;
  if (raw === undefined) return DEFAULT_SPACING_MS;
  const parsed = Number(raw);
  // A malformed value must not silently become 0 and remove the ceiling entirely.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SPACING_MS;
}

/**
 * Bound public-RPC bursts and queue length; no unbounded work after overload.
 *
 * The queue bound matters independently of the spacing: without it, a slow endpoint turns every
 * inbound HTTP request into another parked timer, and the process accumulates pending work it can
 * never drain. Refusing past `maxPending` fails the request that cannot be served instead of
 * degrading every request that could have been.
 */
export function pacedFetch(
  spacingMs = configuredSpacing(),
  maxPending = DEFAULT_MAX_PENDING,
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
