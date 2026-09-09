export type Execution = {
  id: string;
  instanceId: string;
  status: string;
  amountIn: string;
  tokenIn: string;
  tokenOut: string;
  createdAt: string;
  txHash: string | null;
  /**
   * Why an execution ended the way it did.
   *
   * The API translates the worker's raw string into `{ code, message, raw }`. This was typed as
   * a bare string and rendered straight into JSX, so the first order to carry a reason — a
   * cancellation, a failed precondition, a refund — threw "Objects are not valid as a React
   * child" and took the whole Activity page down, pause and stop buttons with it.
   *
   * Both shapes are accepted rather than swapping one hard-coded shape for the other, because
   * the web app and the API deploy independently and either can be the older half.
   */
  reason: { code: string; message: string; raw: string } | string | null;
  intent?: { side: string; amount: string; asset: number } | null;
  /** Joined by the owned-executions list; the per-instance feed leaves it out. */
  strategy_name?: string | null;
  name?: string;
};
/** The reason as text, whichever shape it arrived in. */
export function reasonText(reason: Execution["reason"]): string {
  if (!reason) return "";
  return typeof reason === "string" ? reason : (reason.message ?? reason.raw ?? "");
}

export type Evaluation = {
  id: string;
  at: string;
  outcome: string;
  admitted: number;
  refused: string | null;
  notifications: string[];
  inputs: Record<string, string>;
};
