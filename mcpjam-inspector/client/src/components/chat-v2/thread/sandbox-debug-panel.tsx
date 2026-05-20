/**
 * SandboxDebugPanel
 *
 * Tool-part debug panel for a `create_view` MCP-App tool result. Replaces
 * the old `CspDebugPanel` — the previous version surfaced ONLY blocked CSP
 * requests, which is the least common cause of "view didn't render"
 * failures. The new layout surfaces, top to bottom:
 *
 *   1. Lifecycle strip — derived from the renderer's existing
 *      `logWidgetDebug` emissions (`debug/sandbox-proxy-ready`,
 *      `debug/widget-content-*`, `debug/bridge-connect-*`,
 *      `debug/app-initialized`). Stages that haven't fired are absent
 *      (per "render only actual data"); no fabricated pending dots.
 *   2. Suggested fix + Blocked requests — verbatim from the old panel.
 *   3. Resolved sandbox policy — the matrix's six-row Sandbox card,
 *      reused here via `SandboxConfigGrid` and `buildSandboxConfig`,
 *      populated from the MCP-Apps runtime resolver payload (the same
 *      object posted to the proxy at `sandboxed-iframe.tsx:324–341`).
 *      Hidden entirely when `applied` is absent (OpenAI Apps v1).
 *   4. Widget declared — a collapsible listing only the CSP fields the
 *      widget actually declared. No "Not declared" filler rows.
 *   5. Full CSP header + docs link — unchanged.
 *
 * The grid label is "Resolved sandbox policy," not "Applied sandbox":
 * `sandboxAttrs` / `allowFeatures` are policy inputs to
 * `SandboxedIframe`; the literal emitted `sandbox=` / `allow=` strings
 * are computed inside that component and are NOT exposed yet.
 * Exposing the final attribute strings (via a ref / callback on
 * `SandboxedIframe`) is left as a follow-up.
 */

import { Fragment, useMemo, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
  Lightbulb,
  ChevronRight,
  X as XIcon,
  Loader2,
} from "lucide-react";
import { Label } from "@mcpjam/design-system/label";
import { Badge } from "@mcpjam/design-system/badge";
import type { CspMode } from "@/stores/ui-playground-store";
import type {
  CspViolation,
  WidgetLifecycleEvent,
  WidgetMount,
  WidgetSandboxApplied,
} from "@/stores/widget-debug-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";
import {
  buildSandboxConfig,
  type ResolvedSandboxView,
} from "@/components/clients/redesigned/canvas/canvasBuilder";
import {
  SandboxProxyIframeCard,
  descriptorToNodeData,
} from "@/components/clients/redesigned/canvas/sandbox-config-grid";

interface SandboxDebugPanelProps {
  sandboxInfo?: {
    mode: CspMode;
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains?: string[];
    headerString?: string;
    violations: CspViolation[];
    widgetDeclared?: {
      connect_domains?: string[];
      resource_domains?: string[];
      frame_domains?: string[];
      connectDomains?: string[];
      resourceDomains?: string[];
      frameDomains?: string[];
      baseUriDomains?: string[];
    } | null;
    applied?: WidgetSandboxApplied;
    lifecycle?: WidgetLifecycleEvent[];
    mounts?: WidgetMount[];
    hostInfo?: { name: string; version: string } | null;
  };
  protocol?: "openai-apps" | "mcp-apps";
}

/* ============================================================
   Suggested-fix machinery (lifted verbatim from the old panel —
   pure functions on widget-declared CSP + violations).
   ============================================================ */

function extractOrigin(url: string): string | null {
  if (
    !url ||
    url === "inline" ||
    url === "eval" ||
    url === "data" ||
    url === "blob"
  ) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    const match = url.match(/^(https?:\/\/[^/]+)/);
    return match ? match[1] : null;
  }
}

function getFieldForDirective(
  directive: string,
): "connect_domains" | "resource_domains" | null {
  const effectiveDirective = directive.replace(/-src$/, "");
  if (effectiveDirective === "connect") return "connect_domains";
  if (
    ["script", "style", "img", "font", "media", "default"].includes(
      effectiveDirective,
    )
  ) {
    return "resource_domains";
  }
  return null;
}

interface SuggestedFix {
  field: "connect_domains" | "resource_domains";
  domains: string[];
  violations: CspViolation[];
}

function analyzeSuggestedFixes(violations: CspViolation[]): SuggestedFix[] {
  const connectDomains = new Map<string, CspViolation[]>();
  const resourceDomains = new Map<string, CspViolation[]>();
  for (const v of violations) {
    const directive = v.effectiveDirective || v.directive;
    const field = getFieldForDirective(directive);
    const origin = extractOrigin(v.blockedUri);
    if (!field || !origin) continue;
    const targetMap =
      field === "connect_domains" ? connectDomains : resourceDomains;
    const existing = targetMap.get(origin) || [];
    existing.push(v);
    targetMap.set(origin, existing);
  }
  const fixes: SuggestedFix[] = [];
  if (connectDomains.size > 0) {
    fixes.push({
      field: "connect_domains",
      domains: Array.from(connectDomains.keys()),
      violations: Array.from(connectDomains.values()).flat(),
    });
  }
  if (resourceDomains.size > 0) {
    fixes.push({
      field: "resource_domains",
      domains: Array.from(resourceDomains.keys()),
      violations: Array.from(resourceDomains.values()).flat(),
    });
  }
  return fixes;
}

function generateCodeSnippet(
  fixes: SuggestedFix[],
  existing?: {
    connect_domains?: string[];
    resource_domains?: string[];
    connectDomains?: string[];
    resourceDomains?: string[];
  } | null,
  protocol?: "openai-apps" | "mcp-apps",
): string {
  const connectDomains = new Set([
    ...(existing?.connect_domains || []),
    ...(existing?.connectDomains || []),
  ]);
  const resourceDomains = new Set([
    ...(existing?.resource_domains || []),
    ...(existing?.resourceDomains || []),
  ]);
  for (const fix of fixes) {
    const targetSet =
      fix.field === "connect_domains" ? connectDomains : resourceDomains;
    for (const domain of fix.domains) targetSet.add(domain);
  }
  const useCamelCase = protocol !== "openai-apps";
  const result: Record<string, string[]> = {};
  if (connectDomains.size > 0) {
    result[useCamelCase ? "connectDomains" : "connect_domains"] = Array.from(
      connectDomains,
    );
  }
  if (resourceDomains.size > 0) {
    result[useCamelCase ? "resourceDomains" : "resource_domains"] = Array.from(
      resourceDomains,
    );
  }
  return JSON.stringify(result, null, 2);
}

/* ============================================================
   Resolved-runtime → matrix DTO bridge.
   ============================================================ */

/**
 * Convert the runtime resolver's published payload into the matrix's
 * `ResolvedSandboxView` shape so we can feed it into `buildSandboxConfig`
 * verbatim. `permissions` (granted) becomes `{ allow: { camera: true,
 * microphone: true, ... } }` — the matrix builder reads it that way.
 */
function appliedToView(applied: WidgetSandboxApplied): ResolvedSandboxView {
  const grantedAllow: Record<string, boolean> = {};
  if (applied.permissions) {
    for (const key of [
      "camera",
      "microphone",
      "geolocation",
      "clipboardWrite",
    ] as const) {
      if (applied.permissions[key]) grantedAllow[key] = true;
    }
  }
  return {
    csp: {
      mode: applied.cspMode,
      restrictTo: applied.restrictTo,
      cspDirectives: applied.cspDirectives,
    },
    permissions:
      Object.keys(grantedAllow).length > 0
        ? { allow: grantedAllow }
        : undefined,
    sandboxAttrs: applied.sandboxAttrs,
    allowFeatures: applied.allowFeatures,
  };
}

/* ============================================================
   Lifecycle strip — collapsed to 4 fixed stages.

   The renderer emits ~10 different event kinds and can re-trigger the
   whole sequence on re-render, so the raw event log grows unbounded
   and reads as noise (see Sandbox tab screenshots that overflowed to
   4 wrapped lines). The user-facing question is "did each stage
   succeed?" — answered by 4 dots in a fixed order, each showing its
   latest state plus a retry count when the stage fired more than once.
   The full event log stays in the store for tests / future drill-down.
   ============================================================ */

type LifecycleStage = "proxy" | "content" | "bridge" | "initialized";

interface StageSummary {
  stage: LifecycleStage;
  label: string;
  status: "ok" | "error" | "pending" | "absent";
  attempts: number;
  lastMessage?: string;
  lastTimestamp?: number;
}

const STAGE_OF_KIND: Partial<
  Record<WidgetLifecycleEvent["kind"], LifecycleStage>
> = {
  "sandbox-proxy-ready": "proxy",
  "widget-content-requested": "content",
  "widget-content-ready": "content",
  "widget-content-error": "content",
  "widget-content-invalid-mimetype": "content",
  "bridge-connect-start": "bridge",
  "bridge-connect-ready": "bridge",
  "bridge-connect-error": "bridge",
  // bridge-connect-skipped is intentionally excluded — it's a no-op
  // signal (the renderer deliberately deferred a connect attempt), not
  // a stage outcome users care about at a glance.
  "app-initialized": "initialized",
};

const STAGE_LABELS: Record<LifecycleStage, string> = {
  proxy: "Proxy",
  content: "Content",
  bridge: "Bridge",
  initialized: "Initialized",
};

const STAGE_ORDER: LifecycleStage[] = [
  "proxy",
  "content",
  "bridge",
  "initialized",
];

const ATTEMPT_STARTER_KINDS: Partial<
  Record<WidgetLifecycleEvent["kind"], true>
> = {
  // Each "start" / "requested" event = one new attempt at the stage.
  "widget-content-requested": true,
  "bridge-connect-start": true,
};

function summarizeLifecycle(
  events: WidgetLifecycleEvent[],
): StageSummary[] {
  const acc: Record<LifecycleStage, StageSummary> = {
    proxy: { stage: "proxy", label: STAGE_LABELS.proxy, status: "absent", attempts: 0 },
    content: {
      stage: "content",
      label: STAGE_LABELS.content,
      status: "absent",
      attempts: 0,
    },
    bridge: {
      stage: "bridge",
      label: STAGE_LABELS.bridge,
      status: "absent",
      attempts: 0,
    },
    initialized: {
      stage: "initialized",
      label: STAGE_LABELS.initialized,
      status: "absent",
      attempts: 0,
    },
  };
  for (const e of events) {
    const stage = STAGE_OF_KIND[e.kind];
    if (!stage) continue;
    const slot = acc[stage];
    if (ATTEMPT_STARTER_KINDS[e.kind]) slot.attempts += 1;
    // Latest event wins — the strip shows current state, not history.
    slot.status = e.status;
    slot.lastMessage = e.message;
    slot.lastTimestamp = e.timestamp;
    // For stages whose "start" event isn't also a final state, an
    // initial pending entry should still count as one attempt. Proxy
    // and Initialized fire only once each (no starter event), so the
    // event itself is the attempt — bump on those too if we haven't.
    if (
      !ATTEMPT_STARTER_KINDS[e.kind] &&
      (stage === "proxy" || stage === "initialized") &&
      slot.attempts === 0
    ) {
      slot.attempts = 1;
    }
  }
  return STAGE_ORDER.map((s) => acc[s]);
}

function LifecycleStrip({ events }: { events: WidgetLifecycleEvent[] }) {
  if (events.length === 0) return null;
  const summary = summarizeLifecycle(events);
  return (
    <div className="lifecycle-track">
      {summary.map((s, i) => {
        // Attempts count is still surfaced via the hover title for the
        // rare power-user case — but not as a visible chip, since the
        // retry signal was reading as "something is wrong" when in
        // practice it just means React re-rendered the surface.
        const title = [
          `${s.label} stage`,
          `status: ${s.status}`,
          s.attempts > 1 ? `attempts: ${s.attempts}` : null,
          s.lastTimestamp
            ? new Date(s.lastTimestamp).toLocaleTimeString()
            : null,
          s.lastMessage,
        ]
          .filter(Boolean)
          .join(" — ");
        // Connector AFTER this node fills when this node is "ok" — the
        // upstream stage has completed and data has flowed to the next.
        // Errors paint it red so the eye locks onto the break.
        const nextConnectorClass =
          s.status === "ok"
            ? "lifecycle-connector lifecycle-connector--filled"
            : s.status === "error"
              ? "lifecycle-connector lifecycle-connector--error"
              : "lifecycle-connector";
        return (
          <Fragment key={s.stage}>
            <div
              className={`lifecycle-node lifecycle-node--${s.status}`}
              title={title}
            >
              <div className="lifecycle-dot">
                {s.status === "ok" ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                ) : s.status === "error" ? (
                  <XIcon className="h-3.5 w-3.5" strokeWidth={3} />
                ) : s.status === "pending" ? (
                  <Loader2 className="h-3 w-3" strokeWidth={2.5} />
                ) : null}
              </div>
              <span className="lifecycle-label">{s.label}</span>
            </div>
            {i < summary.length - 1 ? (
              <div className={nextConnectorClass} aria-hidden />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

/* ============================================================
   Panel.
   ============================================================ */

export function SandboxDebugPanel({
  sandboxInfo,
  protocol,
}: SandboxDebugPanelProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const chatboxHostTheme = useChatboxHostTheme();
  const resolvedThemeMode = chatboxHostTheme ?? themeMode;
  const violations = sandboxInfo?.violations ?? [];
  const lifecycle = sandboxInfo?.lifecycle ?? [];
  const mounts = sandboxInfo?.mounts ?? [];
  const applied = sandboxInfo?.applied;
  const hasViolations = violations.length > 0;
  const [copied, setCopied] = useState(false);

  // Widget-declared CSP — surface only fields the widget actually declared
  // (per "render only actual data"). The previous panel emitted 4 sticky
  // "Not declared" / "Not enforced" rows; the new panel hides each field
  // independently when its source array is empty/absent.
  const declared = sandboxInfo?.widgetDeclared;
  const declaredEntries: Array<{ label: string; values: string[] }> = useMemo(
    () => {
      if (!declared) return [];
      const rows: Array<{ label: string; values: string[] }> = [];
      const connect =
        declared.connect_domains ?? declared.connectDomains ?? [];
      const resource =
        declared.resource_domains ?? declared.resourceDomains ?? [];
      const frame = declared.frame_domains ?? declared.frameDomains ?? [];
      const baseUri = declared.baseUriDomains ?? [];
      if (connect.length > 0)
        rows.push({ label: "connect_domains", values: connect });
      if (resource.length > 0)
        rows.push({ label: "resource_domains", values: resource });
      if (frame.length > 0)
        rows.push({
          label: protocol === "openai-apps" ? "frame_domains" : "frameDomains",
          values: frame,
        });
      if (protocol === "mcp-apps" && baseUri.length > 0)
        rows.push({ label: "baseUriDomains", values: baseUri });
      return rows;
    },
    [declared, protocol],
  );

  const suggestedFixes = useMemo(
    () => analyzeSuggestedFixes(violations),
    [violations],
  );

  const codeSnippet = useMemo(
    () =>
      hasViolations
        ? generateCodeSnippet(suggestedFixes, declared, protocol)
        : "",
    [suggestedFixes, declared, hasViolations, protocol],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // Build the resolved-policy rows from `applied`. Memoized so we don't
  // recompute the descriptors on every re-render. When `applied` is
  // absent (OpenAI Apps in v1, or before the widget initialized), the
  // resolved-policy section is hidden entirely.
  const resolvedRows = useMemo(() => {
    if (!applied) return [];
    const view = appliedToView(applied);
    return buildSandboxConfig(view).map(descriptorToNodeData);
  }, [applied]);

  return (
    <div className="space-y-4 text-xs">
      {/* Lifecycle progress track */}
      <LifecycleStrip events={lifecycle} />

      {/* Mount log — hidden in the healthy case (exactly one mount).
          When the iframe re-mounted, list each entry with the segments of
          the fetch-source key that changed, so devs can spot self-induced
          reloads (e.g. a history snapshot landing flipping
          `cachedWidgetHtmlUrl` / `liveFetchPreferred`). */}
      {mounts.length > 1 && (
        <details className="group" open>
          <summary className="flex items-center gap-1.5 cursor-pointer list-none text-amber-600 dark:text-amber-400">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <span className="font-medium">Mounts</span>
            <Badge
              variant="outline"
              className="text-[9px] px-1 py-0 h-4 ml-0.5"
              title="Iframe was torn down and rebuilt"
            >
              {mounts.length}
            </Badge>
          </summary>
          <div className="mt-2 pl-5 space-y-1">
            {mounts.map((m) => (
              <div
                key={m.index}
                className="flex items-baseline gap-2 text-[10px]"
              >
                <span className="text-muted-foreground tabular-nums w-4 shrink-0">
                  #{m.index}
                </span>
                <span className="font-mono text-foreground truncate">
                  {m.reason}
                </span>
                <span className="ml-auto text-muted-foreground/60 tabular-nums shrink-0">
                  {new Date(m.at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Suggested Fix */}
      {hasViolations && suggestedFixes.length > 0 && (
        <details className="group">
          <summary
            className={`flex items-center gap-1.5 cursor-pointer list-none ${
              resolvedThemeMode === "dark" ? "text-amber-400" : "text-amber-600"
            }`}
          >
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <Lightbulb className="h-3.5 w-3.5" />
            <span className="font-medium">Suggested fix</span>
          </summary>
          <div className="mt-2 pl-5 space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] text-muted-foreground">
                {protocol === "mcp-apps"
                  ? "Add the following to your ui.csp field"
                  : "Add the following to your openai/widgetCSP field"}
              </Label>
              <button
                onClick={handleCopy}
                className="p-1 hover:bg-muted rounded transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
            </div>
            <pre className="font-mono text-[10px] bg-muted/50 p-2 rounded overflow-auto max-h-32 text-foreground">
              {codeSnippet}
            </pre>
          </div>
        </details>
      )}

      {/* Blocked requests */}
      {hasViolations && (
        <details className="group">
          <summary className="flex items-center gap-1.5 text-destructive cursor-pointer list-none">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="font-medium">
              {violations.length} blocked request
              {violations.length !== 1 ? "s" : ""}
            </span>
          </summary>
          <div className="mt-2 space-y-1 max-h-32 overflow-auto pl-5">
            {violations.map((v, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
              >
                <Badge
                  variant="outline"
                  className="text-[9px] px-1 py-0 h-4 shrink-0"
                >
                  {v.effectiveDirective || v.directive}
                </Badge>
                <span className="font-mono truncate">
                  {v.blockedUri || "(inline)"}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Full Sandbox proxy iframe card — same component the host-config
          matrix renders, fed from the runtime resolver payload. Hidden
          when no resolver output has been published yet (OpenAI Apps v1,
          or pre-init). The "permissive" badge is overlaid on top of the
          card so users see at a glance when CSP enforcement was bypassed
          for this surface. */}
      {resolvedRows.length > 0 ? (
        <div className="relative">
          {applied?.permissive ? (
            <Badge
              variant="outline"
              className="absolute right-3 top-3 text-[9px] px-1 py-0 h-4 z-10"
              title="Sandbox CSP enforcement bypassed for this surface"
            >
              permissive
            </Badge>
          ) : null}
          <SandboxProxyIframeCard
            rows={resolvedRows}
            hostInfo={sandboxInfo?.hostInfo ?? null}
          />
        </div>
      ) : null}

      {/* Widget-declared CSP, collapsible. Hidden when the widget
          declared nothing the panel could surface. */}
      {declaredEntries.length > 0 && (
        <details className="group">
          <summary className="flex items-center gap-1.5 cursor-pointer list-none text-muted-foreground">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <span className="font-medium">Widget declared</span>
          </summary>
          <div className="mt-2 pl-5 space-y-3">
            {declaredEntries.map((entry) => (
              <div key={entry.label} className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">
                  {entry.label}
                </Label>
                <div className="font-mono text-[10px] space-y-0.5">
                  {entry.values.map((v, i) => (
                    <div key={i} className="truncate">
                      {v}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Full CSP header */}
      {sandboxInfo?.headerString && (
        <details>
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
            Full CSP header
          </summary>
          <div className="mt-1 font-mono text-[9px] text-muted-foreground bg-muted/50 p-2 rounded max-h-24 overflow-auto break-all">
            {sandboxInfo.headerString}
          </div>
        </details>
      )}

      {/* Docs link */}
      <a
        href={
          protocol === "mcp-apps"
            ? "https://github.com/modelcontextprotocol/ext-apps/blob/bcfffb6585ea4fb1e3a9da39fb8911b83399fa71/specification/draft/apps.mdx?plain=1#L672"
            : "https://developers.openai.com/apps-sdk/build/mcp-server/"
        }
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3 w-3" />
        {protocol === "mcp-apps"
          ? "CSP for MCP Apps docs"
          : "CSP for OpenAI Apps docs"}
      </a>
    </div>
  );
}
