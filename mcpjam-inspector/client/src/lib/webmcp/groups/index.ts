/**
 * Surface tool groups: agent tools that mount and unmount with one specific
 * screen, registered by `useSurfaceAgentBridge` while that screen is up.
 *
 * The existing servers and playground catalogs are "global"-kind (see
 * `agentTools` in `shared/app-surfaces.ts`), not groups: their tools
 * self-navigate and must stay advertised from every route. Every new
 * surface's tools land here instead, with a bridge call in the surface's own
 * component — see `../ADDING_SURFACE_TOOLS.md` for the recipe. The
 * agent-tool coverage test enforces that a manifest's `agentTools.kind ===
 * "group"` and an entry here appear together.
 */

import type { AppSurfaceId } from "@/shared/app-surfaces";
import type { UiToolGroup } from "./types";
import { buildRegistryUiTools } from "./registry";
import { buildEvalsUiTools } from "./evals";
import { buildSwarmsUiTools } from "./swarms";

export type { UiToolGroup } from "./types";

export const SURFACE_TOOL_GROUPS: Partial<Record<AppSurfaceId, UiToolGroup>> =
  {
    registry: { surfaceId: "registry", buildTools: buildRegistryUiTools },
    evals: { surfaceId: "evals", buildTools: buildEvalsUiTools },
    swarms: { surfaceId: "swarms", buildTools: buildSwarmsUiTools },
  };

/**
 * Tool names a surface's group would register — empty for a surface with no
 * group (or an unknown id). Used by the App navigate handler to wait for a
 * just-mounted surface's tools before the turn continues, and by tests.
 */
export function listSurfaceGroupToolNames(surfaceId: string): string[] {
  const group = (SURFACE_TOOL_GROUPS as Partial<Record<string, UiToolGroup>>)[
    surfaceId
  ];
  if (!group) return [];
  return group.buildTools().map((tool) => tool.name);
}
