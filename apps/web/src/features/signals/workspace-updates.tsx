"use client";
import { Bell, Check, Layers3 } from "lucide-react";
import { useState } from "react";
import { Dialog } from "../../components/dialog";
import { useDesk } from "../../providers/desk-provider";
export function WorkspaceUpdates(){const [open,setOpen]=useState(false);const {state}=useDesk();return <><button type="button" className="desk-icon-button" aria-label="Workspace updates" onClick={()=>setOpen(true)}><Bell size={18}/>{state.orders.length>0&&<i className="notification-dot"/>}</button>{open&&<Dialog title="Your workspace, up to date." eyebrow="DEMO ACTIVITY" onClose={()=>setOpen(false)}><div className="workspace-updates">{state.orders.slice(0,5).map(o=><div key={o.id}><Check size={18}/><span><strong>{o.symbol} paper {o.side} · {o.status}</strong><small>{new Date(o.createdAt).toLocaleString()}</small></span></div>)}<div><Layers3 size={18}/><span><strong>{state.automations.filter(a=>a.status!=="archived").length} demo automation configurations</strong><small>Available in your strategy studio</small></span></div><p>These updates stay in this browser. No external notifications are sent.</p></div></Dialog>}</>;}
