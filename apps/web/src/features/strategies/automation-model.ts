import { stocks } from "../market/catalog";
import { demoQuote } from "../trading/market-data";
import type { AutomationConfig, AutomationKind } from "../trading/types";
import { automationPresets } from "./automation-catalog";
export function defaultAutomation(kind:AutomationKind,symbol="NVDAc"):AutomationConfig {
  const price=demoQuote(symbol)/100;
  return {name:automationPresets.find(p=>p.kind===kind)?.name??"My automation",kind,symbol,budgetCents:100000,orderCents:10000,interval:"weekly",lower:Math.round(price*.94),upper:Math.round(price*1.06),levels:8,safetyOrders:3,multiplier:1,takeProfit:8,stopLoss:5,trailing:kind==="trailing"?1.5:0,signal:"price-below",entry:Math.round(price*.97)};
}
export function allocationLadder(config:AutomationConfig){return Array.from({length:config.safetyOrders+1},(_,i)=>Math.round(config.orderCents*config.multiplier**i));}
export function validateAutomation(config:AutomationConfig){
  if(!config.name.trim()||config.name.length>80)throw new Error("Give this automation a name of up to 80 characters.");
  if(!stocks.includes(config.symbol))throw new Error("Choose a supported stock.");
  if(!Number.isSafeInteger(config.budgetCents)||config.budgetCents<100||config.budgetCents>100000000)throw new Error("Set a budget between $1 and $1,000,000.");
  if(!Number.isSafeInteger(config.orderCents)||config.orderCents<100||config.orderCents>config.budgetCents)throw new Error("Each order must fit inside your budget.");
  if(!Number.isInteger(config.levels)||config.levels<2||config.levels>50)throw new Error("Choose between 2 and 50 grid levels.");
  if(!Number.isInteger(config.safetyOrders)||config.safetyOrders<0||config.safetyOrders>10||!Number.isFinite(config.multiplier)||config.multiplier<1||config.multiplier>3)throw new Error("Check the number and size of your additional buys.");
  if(config.kind==="dca"&&allocationLadder(config).reduce((n,v)=>n+v,0)>config.budgetCents)throw new Error("The initial and additional buys exceed your budget. Reduce their size or count.");
  if(config.kind==="grid"&&(!Number.isFinite(config.lower)||!Number.isFinite(config.upper)||config.lower<=0||config.upper<=config.lower))throw new Error("The upper grid price must be above the lower price.");
  if(config.kind==="signal"&&(!Number.isFinite(config.entry)||config.entry<=0))throw new Error("Enter a valid signal price.");
  if([config.takeProfit,config.stopLoss,config.trailing].some(v=>!Number.isFinite(v)||v<0||v>100))throw new Error("Exit percentages must be between 0 and 100.");
  return config;
}
