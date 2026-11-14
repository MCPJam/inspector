import { useMemo } from "react";
import {
  loadedOrgModelConfig,
  useHostedOrgModelConfig,
} from "@/hooks/use-hosted-org-model-config";
import {
  WEB_SEARCH_TOOL_NAME,
  webSearchPolicyNote,
} from "@/lib/web-search-refusal";

/**
 * Notes for the built-in tools editor, by tool id: what the project's
 * organization AI key policy means for each tool. They never block a toggle.
 */
export function useBuiltInToolNotes(
  projectId: string | null | undefined,
): Readonly<Record<string, string>> {
  const config = loadedOrgModelConfig(useHostedOrgModelConfig({ projectId }));
  const note = webSearchPolicyNote(config?.aiReadiness);
  return useMemo(
    (): Readonly<Record<string, string>> =>
      note ? { [WEB_SEARCH_TOOL_NAME]: note } : {},
    [note],
  );
}
