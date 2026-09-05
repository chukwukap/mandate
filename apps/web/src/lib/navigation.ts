export const sectionTitles={overview:"Overview",markets:"Markets",trade:"Trade",automations:"Automations",signals:"Signals",discover:"Discover",portfolio:"Portfolio",strategies:"Signed strategies",activity:"Activity",settings:"Settings"};
export type WorkspaceSection=keyof typeof sectionTitles;
export function workspaceSection(path:string):WorkspaceSection {
  const segment=path.split("/")[1];
  return segment&&segment in sectionTitles?segment as WorkspaceSection:"overview";
}
