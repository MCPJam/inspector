/**
 * A surface tool group: the agent tools that only make sense while one
 * specific screen is mounted. Registered mount-scoped (scope: "surface")
 * by `useSurfaceAgentBridge`, in contrast to the always-on global catalog
 * (`buildUiToolsCatalog`).
 */

import type { AppSurfaceId } from "@/shared/app-surfaces";
import type { UiToolDefinition } from "../ui-tools-registry";

export interface UiToolGroup {
  /** The surface whose mount lifecycle owns these tools. */
  surfaceId: AppSurfaceId;
  /** Build fresh definitions — same contract as `buildUiToolsCatalog`. */
  buildTools(): UiToolDefinition[];
}
