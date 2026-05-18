import type { HostFocusTabId } from "../types";

export interface HostFocusTabDef {
  id: HostFocusTabId;
  label: string;
}

export const HOST_FOCUS_TAB_DEFS: ReadonlyArray<HostFocusTabDef> = [
  { id: "behavior", label: "Agent" },
  { id: "protocol", label: "MCP Protocol" },
  { id: "apps", label: "Apps Extension" },
  { id: "servers", label: "Servers" },
  // { id: "appearance", label: "Appearance" }, // hidden — to reintroduce soon
];
