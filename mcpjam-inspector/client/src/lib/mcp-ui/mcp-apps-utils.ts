// The UI-type detection core (UIType, detectUIType, getUIResourceUri,
// detectUiTypeFromTool) + the SEP-1865 tool-visibility re-exports relocated to
// @mcpjam/widget-react (Phase 3d-ii). Re-exported here so existing
// `@/lib/mcp-ui/mcp-apps-utils` import sites are unchanged. The
// `ListToolsResultWithMetadata`-typed convenience helpers stay local — they
// depend on an inspector api type.
import { detectUIType, UIType } from "@mcpjam/widget-react";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

export { detectUIType, UIType };
export {
  detectUiTypeFromTool,
  getUIResourceUri,
  getToolVisibility,
  isVisibleToModelOnly,
  isVisibleToAppOnly,
} from "@mcpjam/widget-react";

export function isMCPApp(
  toolsData?: ListToolsResultWithMetadata | null,
): boolean {
  const metadata = toolsData?.toolsMetadata;
  if (!metadata) return false;

  return Object.values(metadata).some(
    (meta) => detectUIType(meta, undefined) === UIType.MCP_APPS,
  );
}

export function isOpenAIApp(
  toolsData?: ListToolsResultWithMetadata | null,
): boolean {
  const metadata = toolsData?.toolsMetadata;
  if (!metadata) return false;

  return Object.values(metadata).some(
    (meta) => detectUIType(meta, undefined) === UIType.OPENAI_SDK,
  );
}

export function isOpenAIAppAndMCPApp(
  toolsData?: ListToolsResultWithMetadata | null,
): boolean {
  const metadata = toolsData?.toolsMetadata;
  if (!metadata) return false;

  return Object.values(metadata).some(
    (meta) => detectUIType(meta, undefined) === UIType.OPENAI_SDK_AND_MCP_APPS,
  );
}
