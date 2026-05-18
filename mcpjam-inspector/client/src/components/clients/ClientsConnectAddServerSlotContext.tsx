import { createContext } from "react";

/** DOM mount point for ServersTab “Add server” actions when embedded under Connect (HostsTab). */
export const HostsConnectAddServerSlotContext =
  createContext<HTMLDivElement | null>(null);
