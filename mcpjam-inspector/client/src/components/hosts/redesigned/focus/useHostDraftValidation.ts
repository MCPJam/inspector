import { useMemo } from "react";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";
import type {
  HostAttentionIssue,
  HostFocusTabId,
} from "../types";

/**
 * Walk the draft and surface user-visible issues. Each issue carries the
 * tab it belongs to so the focus overlay can deep-link to the offending
 * field and the canvas sub-node can warning-color the matching summary
 * row. Recomputed by the caller via `useMemo` whenever the draft changes.
 */
export function collectHostAttentionIssues(
  draft: HostConfigInputV2,
  hostDisplayName?: string,
): ReadonlyArray<HostAttentionIssue> {
  const issues: HostAttentionIssue[] = [];

  if (hostDisplayName !== undefined && hostDisplayName.trim() === "") {
    issues.push({
      level: "error",
      tab: "general",
      field: "hostDisplayName",
      message: "Host name is required",
    });
  }

  if (draft.modelId.trim() === "") {
    issues.push({
      level: "error",
      tab: "behavior",
      field: "modelId",
      message: "Pick a model before saving",
    });
  }
  if (draft.systemPrompt.trim() === "") {
    issues.push({
      level: "warning",
      tab: "behavior",
      field: "systemPrompt",
      message: "Empty system prompt",
    });
  }

  // Protocol tab: hostContext must be JSON-shaped (the editor enforces
  // this, but defend the validation surface for non-editor mutators too).
  if (
    draft.hostContext &&
    (typeof draft.hostContext !== "object" || Array.isArray(draft.hostContext))
  ) {
    issues.push({
      level: "error",
      tab: "protocol",
      field: "hostContext",
      message: "Host context must be a JSON object",
    });
  }

  if (
    draft.connectionDefaults.requestTimeout <= 0 ||
    !Number.isFinite(draft.connectionDefaults.requestTimeout)
  ) {
    issues.push({
      level: "error",
      tab: "protocol",
      field: "requestTimeout",
      message: "Request timeout must be a positive number",
    });
  }

  // Apps Extension: when the extension is enabled, the MIME type list must
  // not be empty. Empty mimeTypes is technically a valid hash but renders
  // the extension inert.
  const ext = (draft.clientCapabilities?.extensions as
    | Record<string, unknown>
    | undefined)?.["io.modelcontextprotocol/ui"] as
    | { mimeTypes?: unknown }
    | undefined;
  if (ext) {
    const mimeTypes = ext.mimeTypes;
    if (!Array.isArray(mimeTypes) || mimeTypes.length === 0) {
      issues.push({
        level: "warning",
        tab: "apps",
        field: "mimeTypes",
        message: "Extension is on but no MIME types are advertised",
      });
    }
  }

  return issues;
}

export function useHostDraftValidation(
  draft: HostConfigInputV2,
  hostDisplayName?: string,
) {
  return useMemo(
    () => collectHostAttentionIssues(draft, hostDisplayName),
    [draft, hostDisplayName],
  );
}

/** Convenience: count issues by tab for the sub-node attention badges. */
export function countIssuesByTab(
  issues: ReadonlyArray<HostAttentionIssue>,
): Record<HostFocusTabId, number> {
  const out: Record<HostFocusTabId, number> = {
    general: 0,
    behavior: 0,
    protocol: 0,
    apps: 0,
    servers: 0,
  };
  for (const issue of issues) out[issue.tab]++;
  return out;
}

/** Convenience: extract the offending field set for a tab. */
export function fieldsWithIssues(
  issues: ReadonlyArray<HostAttentionIssue>,
  tab: HostFocusTabId,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const issue of issues) if (issue.tab === tab) out.add(issue.field);
  return out;
}
