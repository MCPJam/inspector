/**
 * L1 widget scan — turns the generic host-capability matrix into
 * *server-specific* findings.
 *
 * At L0 we only know a host's limitations; we can't say whether THIS server's
 * widget hits them. This module statically scans a widget's HTML (and its
 * declared `_meta.ui`) for the host APIs it actually uses, so a finding only
 * fires when the widget genuinely needs a capability the host lacks. Pure
 * string scanning — no execution.
 *
 * Heuristic by nature: it matches both the raw MCP Apps wire methods
 * (`ui/message`, `tools/call`, …) and the OpenAI Apps SDK surface
 * (`window.openai.sendFollowUpMessage`, …). False positives are possible (a
 * method name in a comment); we accept that over masquerading general host
 * knowledge as a per-server finding.
 */

/** Capability dimensions a widget can depend on (subset of the host matrix). */
export type WidgetCapabilityNeed =
  | "serverTools"
  | "serverResources"
  | "openLinks"
  | "downloadFile"
  | "updateModelContext"
  | "message"
  | "logging"
  | "sandboxPermissions"
  | "cspFrameDomains";

/** capability key → tool names whose widget actually needs it. */
export type WidgetUsage = Partial<Record<WidgetCapabilityNeed, string[]>>;

const SOURCE_PATTERNS: ReadonlyArray<{
  key: WidgetCapabilityNeed;
  patterns: RegExp[];
}> = [
  {
    key: "serverTools",
    patterns: [/tools\/call/, /\bcallTool\b/, /\bcallServerTool\b/],
  },
  {
    key: "serverResources",
    patterns: [/resources\/read/, /\breadResource\b/],
  },
  {
    key: "message",
    patterns: [/ui\/message/, /\bsendFollowUpMessage\b/i],
  },
  {
    key: "updateModelContext",
    patterns: [/ui\/update-model-context/, /\bsetWidgetState\b/],
  },
  {
    key: "openLinks",
    patterns: [/ui\/open-link/, /\bopenExternal\b/],
  },
  {
    key: "downloadFile",
    patterns: [/ui\/download-file/, /\bgetFileDownloadUrl\b/, /\buploadFile\b/],
  },
  {
    key: "logging",
    patterns: [/notifications\/message/],
  },
];

/** Scan widget HTML/JS source for the host APIs it calls. */
export function scanWidgetSource(source: string): Set<WidgetCapabilityNeed> {
  const needs = new Set<WidgetCapabilityNeed>();
  for (const { key, patterns } of SOURCE_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(source))) needs.add(key);
  }
  return needs;
}

/**
 * Read declared needs straight off the resource's `_meta.ui` — CSP frame
 * domains and sandbox permissions are declared, not called, so they don't show
 * up in a source scan.
 */
export function scanWidgetMeta(meta: unknown): Set<WidgetCapabilityNeed> {
  const needs = new Set<WidgetCapabilityNeed>();
  const ui = (meta as { ui?: { csp?: unknown; permissions?: unknown } })?.ui;
  const frameDomains = (ui?.csp as { frameDomains?: unknown } | undefined)
    ?.frameDomains;
  if (Array.isArray(frameDomains) && frameDomains.length > 0) {
    needs.add("cspFrameDomains");
  }
  const permissions = ui?.permissions;
  if (
    permissions &&
    typeof permissions === "object" &&
    Object.keys(permissions).length > 0
  ) {
    needs.add("sandboxPermissions");
  }
  return needs;
}
