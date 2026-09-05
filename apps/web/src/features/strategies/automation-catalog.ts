import type { AutomationKind } from "../trading/types";
export const automationPresets: {kind:AutomationKind;name:string;label:string;description:string;color:string}[]=[
  {kind:"dca",name:"Steady accumulation",label:"DCA",description:"Build a position, one measured buy at a time.",color:"sage"},
  {kind:"grid",name:"Work the range",label:"Grid",description:"Set your boundaries. Map entries between them.",color:"sand"},
  {kind:"signal",name:"Wait for your moment",label:"Signal",description:"Turn a price condition into a planned entry.",color:"blue"},
  {kind:"trailing",name:"Give your exit room",label:"Trailing",description:"Plan take-profit, stop-loss, and a trailing exit.",color:"rose"},
];
export const kindName:Record<AutomationKind,string>={dca:"DCA",grid:"Grid",signal:"Signal",trailing:"Trailing"};
