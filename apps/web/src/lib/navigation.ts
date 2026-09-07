/**
 * The sections the workspace has.
 *
 * `signals` and `automations` are gone. Signals was built entirely on fixtures with no endpoint
 * behind it, and automations was a second name for the same `/v1/instances` object that
 * `strategies` already shows — two nav items for one thing, one of them holding invented data.
 * Every section left here is backed by a route the API actually serves.
 */
export const sectionTitles = {
  overview: "Overview",
  markets: "Markets",
  trade: "Trade",
  discover: "Discover",
  portfolio: "Portfolio",
  strategies: "Strategies",
  activity: "Activity",
  settings: "Settings",
};
export type WorkspaceSection = keyof typeof sectionTitles;
export function workspaceSection(path: string): WorkspaceSection {
  const segment = path.split("/")[1];
  return segment && segment in sectionTitles ? (segment as WorkspaceSection) : "overview";
}
