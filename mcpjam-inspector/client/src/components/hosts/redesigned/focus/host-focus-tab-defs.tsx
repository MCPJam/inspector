import type { ReactNode } from "react";
import {
  AppWindow,
  LayoutTemplate,
  Plug,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import type { HostFocusTabId } from "../types";

export interface HostFocusTabDef {
  id: HostFocusTabId;
  label: string;
  eyebrow: string;
  icon: ReactNode;
}

export const HOST_FOCUS_TAB_DEFS: ReadonlyArray<HostFocusTabDef> = [
  {
    id: "behavior",
    label: "Agent",
    eyebrow: "",
    icon: <SlidersHorizontal className="size-3.5" />,
  },
  {
    id: "protocol",
    label: "MCP Protocol",
    eyebrow: "",
    icon: <Plug className="size-3.5" />,
  },
  {
    id: "apps",
    label: "Apps Extension",
    eyebrow: "",
    icon: <AppWindow className="size-3.5" />,
  },
  {
    id: "servers",
    label: "Servers",
    eyebrow: "",
    icon: <Server className="size-3.5" />,
  },
  {
    id: "general",
    label: "General",
    eyebrow: "",
    icon: <LayoutTemplate className="size-3.5" />,
  },
];
