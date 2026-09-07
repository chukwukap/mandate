export type OrderKind = "market" | "limit" | "stop";
export type PaperOrder = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  kind: OrderKind;
  amountCents: number;
  quantityUnits: number;
  priceCents: number;
  status: "open" | "filled" | "cancelled";
  createdAt: string;
  takeProfit: number;
  stopLoss: number;
  trailing: number;
};
export type Holding = { symbol: string; quantityUnits: number; costCents: number };
export type AutomationKind = "dca" | "grid" | "signal" | "trailing";
export type AutomationConfig = {
  name: string;
  kind: AutomationKind;
  symbol: string;
  budgetCents: number;
  orderCents: number;
  interval: "daily" | "weekly" | "monthly";
  lower: number;
  upper: number;
  levels: number;
  safetyOrders: number;
  multiplier: number;
  takeProfit: number;
  stopLoss: number;
  trailing: number;
  signal: "price-below" | "price-above";
  entry: number;
  sourceId?: string;
};
export type Automation = AutomationConfig & {
  id: string;
  status: "running" | "paused" | "archived";
  createdAt: string;
};
export type DeskState = {
  version: 1;
  cashCents: number;
  holdings: Holding[];
  orders: PaperOrder[];
  automations: Automation[];
  savedSignals: string[];
  hiddenSignals: string[];
  tick: number;
  hideBalance: boolean;
};
export type OrderInput = Pick<
  PaperOrder,
  "symbol" | "side" | "kind" | "amountCents" | "priceCents" | "takeProfit" | "stopLoss" | "trailing"
>;
