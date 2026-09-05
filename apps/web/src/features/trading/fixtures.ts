import type { DeskState } from "./types";
export function initialDesk(): DeskState {
  return {
    version: 1, cashCents: 875000, tick: 0, hideBalance: false, savedSignals: [], hiddenSignals: [],
    holdings: [
      {symbol:"NVDAc",quantityUnits:22000000,costCents:475860},
      {symbol:"AAPLc",quantityUnits:16000000,costCents:369200},
      {symbol:"METAc",quantityUnits:4000000,costCents:290400},
      {symbol:"GOOGLc",quantityUnits:17000000,costCents:337280},
    ],
    orders: [],
    automations: [
      {id:"demo-dca",name:"A little more NVIDIA",kind:"dca",symbol:"NVDAc",budgetCents:100000,orderCents:10000,interval:"weekly",lower:210,upper:245,levels:6,safetyOrders:3,multiplier:1,takeProfit:8,stopLoss:5,trailing:0,signal:"price-below",entry:220,status:"running",createdAt:"2026-09-04T08:00:00Z"},
      {id:"demo-grid",name:"Apple, in a range",kind:"grid",symbol:"AAPLc",budgetCents:75000,orderCents:5000,interval:"daily",lower:220,upper:250,levels:8,safetyOrders:2,multiplier:1,takeProfit:5,stopLoss:4,trailing:0,signal:"price-below",entry:230,status:"running",createdAt:"2026-09-03T08:00:00Z"},
      {id:"demo-signal",name:"Wait for the breakout",kind:"signal",symbol:"METAc",budgetCents:50000,orderCents:5000,interval:"daily",lower:710,upper:780,levels:5,safetyOrders:0,multiplier:1,takeProfit:6,stopLoss:3,trailing:1.5,signal:"price-above",entry:750,status:"paused",createdAt:"2026-09-02T08:00:00Z"},
    ],
  };
}
