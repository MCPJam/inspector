/**
 * Host compatibility report — L0 static checks (prototype of the design in
 * `design-explorations/host-compat-report.md`).
 *
 * The engine joins `ServerRequirements` (what the server's widgets need,
 * derived from connect-time tool metadata) against per-host
 * `HostCompatProfile`s. Profiles are sourced directly from the host-style
 * registry's SEP-1865 capability matrix (`mcpAppsCapabilities`) — the same
 * facts the playground uses to *emulate* each host — so the report never
 * drifts from the emulation.
 */

import type { ResolvedMcpAppsCapabilities } from "@/lib/client-styles/types";
import type { WidgetUsage } from "./widget-scan";

export type CompatVerdict = "works" | "degraded" | "blocked" | "unknown";

export type CompatFindingSeverity = "blocker" | "degraded" | "info";

/**
 * Where a host-profile fact comes from. Surfaced in the UI so a verdict
 * never reads as more authoritative than its weakest source.
 */
export type CompatProvenance = "vendor-doc" | "probe" | "assumed";

export type CompatFinding = {
  severity: CompatFindingSeverity;
  title: string;
  detail: string;
  remediation?: string;
};

export type HostCompatReport = {
  hostId: string;
  hostLabel: string;
  logoSrc: string;
  logoSrcByTheme?: { light: string; dark: string };
  verdict: CompatVerdict;
  provenance: CompatProvenance;
  findings: CompatFinding[];
};

/**
 * What the server demands of a host, derived from the tools list at connect
 * time. Today this is entirely widget-shaped — that's where hosts actually
 * differ. Transport/auth/protocol live elsewhere (deliberately dropped from
 * the report: a local dev server is *expected* not to reach cloud hosts, so
 * flagging it is noise).
 */
export type ServerRequirements = {
  /** Tools that declare a UI, grouped by the bridge they render through. */
  widgets: {
    /** MCP Apps only (`_meta.ui.resourceUri`). */
    mcpAppsOnly: string[];
    /** OpenAI Apps only (`openai/outputTemplate`). */
    openaiAppsOnly: string[];
    /** Declares both bridges — renderable wherever either exists. */
    dual: string[];
  };
  /**
   * Widget tools that are app-only (`_meta.ui.visibility` excludes
   * `"model"`). These have no text fallback — a host that can't render them
   * makes the tool unusable, not merely degraded.
   */
  appOnlyWidgets: string[];
  hasWidgets: boolean;
  /**
   * L1 scan result: which host capabilities this server's widgets actually
   * use, mapped to the tools that need them. `undefined` = not scanned yet
   * (the engine withholds capability findings rather than guess); `{}` =
   * scanned, nothing notable used.
   */
  widgetUsage?: WidgetUsage;
  /** Human-readable dimensions we could not derive yet. */
  unknownDimensions: string[];
};

export type HostCompatProfile = {
  id: string;
  label: string;
  logoSrc: string;
  logoSrcByTheme?: { light: string; dark: string };
  /** Dominant provenance for this profile's facts. */
  provenance: CompatProvenance;
  /** Renders MCP Apps widgets (`_meta.ui.resourceUri`). */
  rendersMcpApps: boolean;
  /** Renders OpenAI Apps widgets (`openai/outputTemplate` via the shim). */
  rendersOpenAiApps: boolean;
  /**
   * The host's SEP-1865 MCP Apps capability matrix (from the registry).
   * Present only when the host renders widgets at all — a CLI host (Codex)
   * leaves this undefined.
   */
  capabilities?: ResolvedMcpAppsCapabilities;
};
