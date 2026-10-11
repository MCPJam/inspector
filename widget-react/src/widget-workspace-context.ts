import { createContext } from "react";
import type { WidgetSurfaceStore } from "./widget-surface-store";
import type {
  AppToolsRegistry,
  AppToolInvocationLog,
} from "./app-tools-registry";

/** Per-workspace stores; Host Compare mounts one provider per lane. */
export const WidgetWorkspaceContext = createContext<{
  workspaceId: string;
  surfaces: WidgetSurfaceStore;
  registry: AppToolsRegistry;
  invocations: AppToolInvocationLog;
} | null>(null);
