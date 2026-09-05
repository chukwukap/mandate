"use client";
import { useId, useState } from "react";
import { candlesFor } from "../trading/market-data";
export function DeskChart({symbol="NVDAc",period="1D",type="line",dark=false,compact=false,average=false,target}:{symbol?:string;period?:string;type?:"line"|"candles";dark?:boolean;compact?:boolean;average?:boolean;target?:number|undefined}) {
  const gradient=useId().replaceAll(":","");
  const candles=candlesFor(symbol,period);
  const [selected,setSelected]=useState<number|null>(null);
  const width=800,height=compact?90:280,left=8,right=compact?8:65,bottom=compact?0:35;
  const lo=Math.min(...candles.map(c=>c.low))*.998;
  const hi=Math.max(...candles.map(c=>c.high))*1.002;
  const x=(i:number)=>left+i*(width-left-right)/(candles.length-1);
  const y=(price:number)=>(height-bottom-12)*(1-(price-lo)/(hi-lo))+6;
  const line=candles.map((c,i)=>`${i?"L":"M"}${x(i)},${y(c.close)}`).join(" ");
  const hovered=selected===null?null:candles[selected];
  const mean=candles.map((_,i)=>candles.slice(Math.max(0,i-19),i+1).reduce((n,c)=>n+c.close,0)/Math.min(i+1,20));
  return <div className={`desk-chart ${dark?"is-dark":""} ${compact?"is-compact":""}`}>
    {!compact&&<div className="chart-readout" aria-live="polite">{hovered?<><span>O <b>{hovered.open.toFixed(2)}</b></span><span>H <b>{hovered.high.toFixed(2)}</b></span><span>L <b>{hovered.low.toFixed(2)}</b></span><span>C <b>{hovered.close.toFixed(2)}</b></span></>:<span>Illustrative price history <i/> {period}</span>}</div>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${symbol} illustrative ${type} chart, ${period}`} onPointerMove={compact?undefined:event=>{const bounds=event.currentTarget.getBoundingClientRect();setSelected(Math.max(0,Math.min(63,Math.round(((event.clientX-bounds.left)/bounds.width*width-left)/(width-left-right)*63))));}} onPointerLeave={()=>setSelected(null)}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={dark?"#c5e9a1":"#30755b"} stopOpacity=".21"/><stop offset="100%" stopColor={dark?"#c5e9a1":"#30755b"} stopOpacity="0"/></linearGradient></defs>
      {!compact&&[0,1,2,3,4].map(i=><g key={i}><line x1={left} x2={width-right+6} y1={y(lo+(hi-lo)*i/4)} y2={y(lo+(hi-lo)*i/4)} className="chart-grid"/><text x={width-right+15} y={y(lo+(hi-lo)*i/4)+4} className="chart-axis-text">{(lo+(hi-lo)*i/4).toFixed(2)}</text></g>)}
      {type==="line"?<><path d={`${line} L${x(63)},${height-bottom} L${left},${height-bottom}Z`} fill={`url(#${gradient})`}/><path d={line} fill="none" stroke={dark?"#c9eaa6":"#2f7858"} strokeWidth={compact?2:2.5} strokeLinejoin="round"/></>:candles.map((c,i)=><g key={`${symbol}-${i}`} className={c.close>=c.open?"candle-up":"candle-down"}><rect x={x(i)-3} y={height-bottom-c.volume*.23} width={6} height={c.volume*.23} opacity=".13"/><line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke="currentColor"/><rect x={x(i)-3} y={Math.min(y(c.open),y(c.close))} width={6} height={Math.max(1.5,Math.abs(y(c.open)-y(c.close)))}/></g>)}
      {average&&<path d={mean.map((p,i)=>`${i?"L":"M"}${x(i)},${y(p)}`).join(" ")} fill="none" stroke="#ba974d" strokeWidth="1.7"/>}
      {target&&target>=lo&&target<=hi&&<g><line x1={left} x2={width-right} y1={y(target)} y2={y(target)} stroke="#b5974c" strokeDasharray="5 4"/><text x={left+4} y={y(target)-7} className="chart-axis-text">Order level · {target.toFixed(2)}</text></g>}
      {selected!==null&&!compact&&hovered&&<g><line x1={x(selected)} x2={x(selected)} y1={8} y2={height-bottom} className="chart-crosshair"/><circle cx={x(selected)} cy={y(hovered.close)} r={4} fill={dark?"#d9efb7":"#32785a"} stroke={dark?"#15382d":"white"} strokeWidth="2"/></g>}
      {!compact&&["09:30","10:30","11:30","12:30","13:30","14:30"].map((label,i)=><text key={label} x={left+i*(width-right-left)/5} y={height-8} textAnchor={i===5?"end":"start"} className="chart-axis-text">{period==="1D"?label:["Mon","Tue","Wed","Thu","Fri","Sat"][i]}</text>)}
    </svg>
    {!compact&&<input className="chart-scrubber" type="range" min="0" max="63" value={selected??63} aria-label="Inspect chart candle" onChange={event=>setSelected(Number(event.target.value))}/>}
  </div>;
}
