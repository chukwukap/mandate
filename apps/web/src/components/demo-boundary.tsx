import { ArrowUpRight, FlaskConical } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
export function DemoBoundary({preview,path,children}:{preview:boolean;path:string;children:ReactNode}){
  if(preview)return children;
  return <section className="desk-demo-gateway"><div className="demo-gateway-art"><FlaskConical size={42}/><span>mandate / playground</span></div><div><span className="desk-overline">YOUR NEXT WORKSPACE</span><h2>Try it. Make it yours.</h2><p>Explore orders, automations, signals, and portfolios with a demo balance. Your connected wallet stays separate.</p><Link className="desk-button primary" href={`${path}?preview=1`}>Open demo workspace<ArrowUpRight size={17}/></Link><small>Interactive frontend · sample prices · no real funds</small></div></section>;
}
