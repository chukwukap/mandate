"use client";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { initialDesk } from "../features/trading/fixtures";
import { advanceMarket, cancelPaperOrder, placePaperOrder } from "../features/trading/ledger";
import type { AutomationConfig, DeskState, OrderInput } from "../features/trading/types";
const key="mandate:demo-desk:v1";
type Desk = { state: DeskState; ready: boolean; notice: string; notify(message: string): void; order(input: OrderInput): void; cancel(id: string): void; advance(): void; createAutomation(config: AutomationConfig): void; setAutomation(ids: string[],status:"running"|"paused"|"archived"):void; saveSignal(id:string):void; hideSignal(id:string):void; toggleBalance():void; reset():void };
const Context=createContext<Desk|null>(null);
export function DeskProvider({children}:{children:ReactNode}) {
  const [state,setState]=useState<DeskState>(initialDesk);
  const current=useRef(state);
  const [ready,setReady]=useState(false);
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    try { const stored=JSON.parse(localStorage.getItem(key)??"null") as DeskState|null; if(stored?.version===1&&Number.isSafeInteger(stored.cashCents)&&Array.isArray(stored.holdings)&&Array.isArray(stored.orders)&&Array.isArray(stored.automations)&&Array.isArray(stored.savedSignals)&&Array.isArray(stored.hiddenSignals)&&Number.isSafeInteger(stored.tick)){current.current=stored;setState(stored);} } catch { /* A private browsing session can still use the demo. */ }
    setReady(true);
  },[]);
  useEffect(()=>{if(ready) try{localStorage.setItem(key,JSON.stringify(state));}catch{/* Keep the in-memory workspace usable. */}},[state,ready]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(""),3600);return()=>clearTimeout(timer);},[notice]);
  function update(transform:(value:DeskState)=>DeskState){const next=transform(current.current);current.current=next;setState(next);}
  return <Context.Provider value={{state,ready,notice,notify:setNotice,
    order(input){update(s=>placePaperOrder(s,input,crypto.randomUUID(),new Date().toISOString()));setNotice(input.kind==="market"?"Demo order filled":"Demo order placed");},
    cancel(id){update(s=>cancelPaperOrder(s,id));setNotice("Order cancelled. Demo funds released.");},
    advance(){update(advanceMarket);setNotice("Demo market advanced one tick");},
    createAutomation(config){update(s=>({...s,automations:[{...config,id:crypto.randomUUID(),status:"running",createdAt:new Date().toISOString()},...s.automations]}));setNotice("Automation added to your demo workspace");},
    setAutomation(ids,status){update(s=>({...s,automations:s.automations.map(a=>ids.includes(a.id)?{...a,status}:a)}));setNotice(status==="archived"?"Automation archived":status==="paused"?"Automation paused":"Automation resumed in demo");},
    saveSignal(id){update(s=>({...s,savedSignals:s.savedSignals.includes(id)?s.savedSignals.filter(x=>x!==id):[...s.savedSignals,id]}));},
    hideSignal(id){update(s=>({...s,hiddenSignals:[...s.hiddenSignals,id]}));setNotice("Signal dismissed");},
    toggleBalance(){update(s=>({...s,hideBalance:!s.hideBalance}));},
    reset(){update(initialDesk);setNotice("Demo workspace reset");},
  }}>{children}</Context.Provider>;
}
export function useDesk(){const desk=useContext(Context);if(!desk)throw new Error("Missing desk provider");return desk;}
