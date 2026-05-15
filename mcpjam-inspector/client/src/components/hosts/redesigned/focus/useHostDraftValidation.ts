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

  // Apps tab: hostContext must be JSON-shaped (the editor enforces this,
  // but defend the validation surface for non-editor mutators too). Test
  // presence — not truthiness — so falsy non-object payloads (0, false,
  // "") don't slip past as "absent".
  if (draft.hostContext !== undefined && draft.hostContext !== null) {
    const ctx = draft.hostContext;
    if (typeof ctx !== "object" || Array.isArray(ctx)) {
      issues.push({
        level: "error",
        tab: "apps",
        field: "hostContext",
        message: "Host context must be a JSON object",
      });
    }
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

  // Apps Extension: sandbox permissions.allow MUST be an object with
  // boolean values — backend canonicalizer rejects anything else and the
  // write would fail. Reject both non-object shapes (string/number/array)
  // AND non-boolean values within an object form, so JSON-tab edits that
  // get the type wrong surface here instead of failing at save time.
  const allow = draft.mcpProfile?.apps?.sandbox?.permissions?.allow;
  if (allow !== undefined && allow !== null) {
    const isObjectShape =
      typeof allow === "object" && !Array.isArray(allow);
    if (!isObjectShape) {
      issues.push({
        level: "error",
        tab: "apps",
        field: "sandboxPermissionsAllow",
        message: "Sandbox permission allow values must be true/false",
      });
    } else {
      for (const v of Object.values(allow)) {
        if (typeof v !== "boolean") {
          issues.push({
            level: "error",
            tab: "apps",
            field: "sandboxPermissionsAllow",
            message: "Sandbox permission allow values must be true/false",
          });
          break;
        }
      }
    }
  }

  return issues;
}

/**
 * Returns true when the draft has at least one `level: "error"` issue.
 * Callers use this to gate "Save" — warnings don't block.
 */
export function hasBlockingErrors(
  issues: ReadonlyArray<HostAttentionIssue>,
): boolean {
  return issues.some((issue) => issue.level === "error");
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
