import { createContext, useContext } from "react";
import type { ViewPhase } from "./transition-tokens";

/**
 * Connect-tab transition phase. Lets ServersTab (which is passed into ClientsTab
 * as a ReactNode) opt into a slide-out animation on the logs rail when the
 * user toggles to the Host view, without ServersTab needing to know about
 * the parent's animation orchestration.
 *
 * Defaults to "servers" so standalone callers (e.g. ClientFocusDialog) render
 * the static layout unchanged.
 */
export const ClientsConnectViewPhaseContext = createContext<ViewPhase>("servers");

export function useHostsConnectViewPhase(): ViewPhase {
  return useContext(ClientsConnectViewPhaseContext);
}
