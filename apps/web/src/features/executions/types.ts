export type Execution = {
  id: string;
  instanceId: string;
  status: string;
  amountIn: string;
  tokenIn: string;
  tokenOut: string;
  createdAt: string;
  txHash: string | null;
  reason: string | null;
  intent?: { side: string; amount: string; asset: number } | null;
  name?: string;
};
export type Evaluation = {
  id: string;
  at: string;
  outcome: string;
  admitted: number;
  refused: string | null;
  notifications: string[];
  inputs: Record<string, string>;
};
