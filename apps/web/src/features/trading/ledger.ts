import { stocks } from "../market/catalog";
import { demoQuote } from "./market-data";
import type { DeskState, OrderInput, PaperOrder } from "./types";
export function reservedCash(state: DeskState) { return state.orders.filter(o=>o.status==="open"&&o.side==="buy").reduce((n,o)=>n+o.amountCents,0); }
export function availableCash(state: DeskState) { return state.cashCents-reservedCash(state); }
export function availableUnits(state: DeskState,symbol: string) {
  return (state.holdings.find(h=>h.symbol===symbol)?.quantityUnits ?? 0)-state.orders.filter(o=>o.status==="open"&&o.side==="sell"&&o.symbol===symbol).reduce((n,o)=>n+o.quantityUnits,0);
}
export function accountValue(state: DeskState) {
  return state.cashCents+state.holdings.reduce((n,h)=>n+Math.round(h.quantityUnits*demoQuote(h.symbol,state.tick)/1e6),0);
}
function fill(state: DeskState,order: PaperOrder): DeskState {
  const existing = state.holdings.find(h=>h.symbol===order.symbol);
  const units = existing?.quantityUnits ?? 0;
  const cost = existing?.costCents ?? 0;
  const holdings=state.holdings.filter(h=>h.symbol!==order.symbol);
  const remaining=units+(order.side==="buy"?order.quantityUnits:-order.quantityUnits);
  if(remaining>0) holdings.push({symbol:order.symbol,quantityUnits:remaining,costCents:order.side==="buy"?cost+order.amountCents:Math.round(cost*remaining/units)});
  return {...state,cashCents:state.cashCents+(order.side==="buy"?-order.amountCents:order.amountCents),holdings,orders:[{...order,status:"filled"},...state.orders.filter(o=>o.id!==order.id)]};
}
export function placePaperOrder(state: DeskState,input: OrderInput,id: string,createdAt: string): DeskState {
  if(!stocks.includes(input.symbol)) throw new Error("Choose a stock from this market.");
  if(!["buy","sell"].includes(input.side)||!["market","limit","stop"].includes(input.kind)) throw new Error("Choose a valid order type.");
  if(!Number.isSafeInteger(input.amountCents)||input.amountCents<100||input.amountCents>100000000) throw new Error("Enter an amount between $1 and $1,000,000.");
  const price=input.kind==="market"?demoQuote(input.symbol,state.tick):input.priceCents;
  if(!Number.isSafeInteger(price)||price<=0) throw new Error("Enter a valid target price.");
  if([input.takeProfit,input.stopLoss,input.trailing].some(n=>!Number.isFinite(n)||n<0||n>100)) throw new Error("Protection percentages must be between 0 and 100.");
  if(input.side==="buy"&&input.amountCents>availableCash(state)) throw new Error("This exceeds your available demo cash.");
  const quantityUnits=Math.floor(input.amountCents*1e6/price);
  if(quantityUnits<1) throw new Error("The order is too small for this stock.");
  if(input.side==="sell"&&quantityUnits>availableUnits(state,input.symbol)) throw new Error("This exceeds your available demo position.");
  const order: PaperOrder={...input,id,createdAt,priceCents:price,quantityUnits,status:input.kind==="market"?"filled":"open"};
  return input.kind==="market"?fill(state,order):{...state,orders:[order,...state.orders]};
}
export function cancelPaperOrder(state: DeskState,id: string): DeskState {
  return {...state,orders:state.orders.map(o=>o.id===id&&o.status==="open"?{...o,status:"cancelled"}:o)};
}
export function advanceMarket(state: DeskState): DeskState {
  let next={...state,tick:state.tick+1};
  for(const order of state.orders.filter(o=>o.status==="open")) {
    const price=demoQuote(order.symbol,next.tick);
    const triggered=order.kind==="limit"?(order.side==="buy"?price<=order.priceCents:price>=order.priceCents):(order.side==="buy"?price>=order.priceCents:price<=order.priceCents);
    if(triggered) next=fill(next,order);
  }
  return next;
}
