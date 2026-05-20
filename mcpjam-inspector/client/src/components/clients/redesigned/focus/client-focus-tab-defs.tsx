import type { HostFocusTabId } from "../types";

export interface HostFocusTabDef {
  id: HostFocusTabId;
  label: string;
}

export const HOST_FOCUS_TAB_DEFS: ReadonlyArray<HostFocusTabDef> = [
  { id: "behavior", label: "Agent" },
  { id: "protocol", label: "MCP Protocol" },
  { id: "apps", label: "Apps Extension" },
  // Servers moved to Project Settings → Servers (one server set across
  // every host in the project). Removed from the per-host tab list as
  // part of the project-scoped server config rollout. The "servers"
  // HostFocusTabId variant is kept for state-compat with persisted UI
  // state that may still reference it; the type-level enum stays so
  // legacy URLs / sessionStorage don't crash.
  // { id: "appearance", label: "Appearance" }, // hidden — to reintroduce soon
];
