import { createContext } from "react";

/** DOM mount point for ServersTab “Add server” actions when embedded under Connect (ClientsTab). */
export const ClientsConnectAddServerSlotContext =
  createContext<HTMLDivElement | null>(null);
