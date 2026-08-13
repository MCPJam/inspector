import { useMemo } from "react";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import type {
  HostAttentionIssue,
  HostFocusTabId,
} from "../types";

export type HostDraftValidationOptions = {
  /**
   * The model the host has PERSISTED, used to tell "this host never had a
   * model" from "this edit removed it". Only the second is blocking.
   *
   * ABSENT means the saved baseline is UNKNOWN, and an unknown baseline is
   * treated as "not pinned" — a warning, never a blocking error. That is
   * deliberate for the two ways it occurs today: the host row is still
   * loading (a blocking error that appears and then vanishes is worse than a
   * late one), and a legacy row genuinely has no model.
   *
   * It also means this hook alone does NOT hold a brand-new host to the
   * forward-client invariant; a create surface that adopts it needs its own
   * gate. The v1 `POST/PATCH /hosts` routes enforce the invariant server-side
   * regardless of which client is asking.
   */
  savedModelId?: string;
};

/**
 * Walk the draft and surface user-visible issues. Each issue carries the
 * tab it belongs to so the focus overlay can deep-link to the offending
 * field and the canvas sub-node can warning-color the matching summary
 * row. Recomputed by the caller via `useMemo` whenever the draft changes.
 */
export function collectHostAttentionIssues(
  draft: HostConfigInputV2,
  hostDisplayName?: string,
  options?: HostDraftValidationOptions,
): ReadonlyArray<HostAttentionIssue> {
  const issues: HostAttentionIssue[] = [];

  if (hostDisplayName !== undefined && hostDisplayName.trim() === "") {
    issues.push({
      level: "error",
      // Host name lives in the sticky identity header above the tab
      // bar (see HostIdentityRow's `hasNameIssue` indicator), not in any
      // tab. After the General tab was removed, attribute the issue to
      // the most-active tab (Behavior) so it still participates in
      // tab-scoped validation helpers, even though the input itself is
      // in the header.
      tab: "behavior",
      field: "hostDisplayName",
      message: "Client name is required",
    });
  }

  if (draft.modelId.trim() === "") {
    // FORWARD-CLIENT INVARIANT. A host's model is what every environment that
    // selects it inherits (`modelSource: "host"`), so a host with no model
    // cannot back a headless environment at all — the launch is refused with
    // `ENV_MODEL_REQUIRED`. Saving an edit that CLEARS the model is therefore
    // blocked outright, not merely flagged.
    //
    // A host that was ALREADY modelless stays a warning. Those legacy rows
    // predate the invariant, are deliberately not auto-backfilled, and turning
    // this into an error for them would strand every unrelated edit (renaming
    // a host, toggling a capability) behind a model choice the user did not
    // come here to make.
    const wasPinned = (options?.savedModelId ?? "").trim() !== "";
    issues.push(
      wasPinned
        ? {
            level: "error",
            tab: "behavior",
            field: "modelId",
            message: "Pick a model — a client can't be saved without one",
          }
        : {
            level: "warning",
            tab: "behavior",
            field: "modelId",
            message: "Pick a model before chatting",
          },
    );
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
        message: "Client context must be a JSON object",
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

  // Apps Extension: detect profiles still carrying the legacy default
  // restrictTo (anthropic / openai / jsdelivr) we used to seed Claude,
  // ChatGPT, Cursor, and Copilot templates with. SEP-1865 makes
  // restrictTo an intersection with the view's declared CSP — so this
  // captured allowlist silently strips any widget reaching an origin
  // outside the three. New profiles no longer ship it; this surfaces it
  // on existing profiles so users can clear it deliberately.
  //
  // Match heuristic: connectDomains contains all three canonical origins
  // AND resourceDomains contains jsdelivr. Users who typed those three
  // by hand will see this too — acceptable: the message is a warning,
  // not a blocker, and the explanation tells them what to do.
  const restrictTo = draft.mcpProfile?.apps?.sandbox?.csp?.restrictTo;
  if (restrictTo) {
    const connect = restrictTo.connectDomains ?? [];
    const resource = restrictTo.resourceDomains ?? [];
    const hasAll = (list: string[], needles: string[]) =>
      needles.every((n) => list.includes(n));
    const looksLegacy =
      hasAll(connect, [
        "https://api.anthropic.com",
        "https://api.openai.com",
        "https://cdn.jsdelivr.net",
      ]) && resource.includes("https://cdn.jsdelivr.net");
    if (looksLegacy) {
      issues.push({
        level: "warning",
        tab: "apps",
        field: "sandboxRestrictTo",
        message:
          "Legacy default restrictTo (anthropic/openai/jsdelivr) silently narrows view CSP — clear it to honor the view's declaration",
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

/**
 * Human-readable explanation for why the "Save host" button is disabled, or
 * `null` when it's enabled (or actively saving, where the spinner already
 * speaks for itself).
 *
 * Motivation: a *silently* greyed Save button reads as an arbitrary rule.
 * A Discord report chased a phantom "you must pick a model first" gate when
 * the real reason was simply "nothing has changed yet". Surfacing the actual
 * reason (no changes, or the specific blocking validation errors) on hover
 * keeps the disabled state honest. Priority mirrors the `canSave` gate order:
 * saving → blocking errors → not dirty.
 *
 * Note that clearing a model IS now a blocking error, so "pick a model" can
 * legitimately appear here — but only for a host that had one, and the message
 * says so.
 */
export function saveDisabledReason(args: {
  isDirty: boolean;
  isSaving: boolean;
  issues: ReadonlyArray<HostAttentionIssue>;
}): string | null {
  const { isDirty, isSaving, issues } = args;
  if (isSaving) return null;
  const blocking = issues.filter((issue) => issue.level === "error");
  if (blocking.length > 0) {
    return blocking.map((issue) => issue.message).join(" · ");
  }
  if (!isDirty) {
    return "No unsaved changes yet — edit any field to enable Save";
  }
  return null;
}

export function useHostDraftValidation(
  draft: HostConfigInputV2,
  hostDisplayName?: string,
  options?: HostDraftValidationOptions,
) {
  const savedModelId = options?.savedModelId;
  return useMemo(
    () => collectHostAttentionIssues(draft, hostDisplayName, { savedModelId }),
    [draft, hostDisplayName, savedModelId],
  );
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
