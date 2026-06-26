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
 * Which axis a finding belongs to. `apps` = widget/rendering (does the host
 * render this widget + expose the host APIs it calls). `server` = capability
 * negotiation (protocol version today; elicitation/sampling/roots once
 * observed live). They fail for different reasons and aggregate independently.
 */
export type CompatLane = "apps" | "server";

/**
 * Where a host-profile fact comes from. Surfaced in the UI so a verdict
 * never reads as more authoritative than its weakest source. `observed` is
 * the strongest — earned by a Tier-2 live run (Phase 3); the rest are static.
 */
export type CompatProvenance = "observed" | "vendor-doc" | "probe" | "assumed";

/**
 * Connection-derived facts about the *server under test* (not the host).
 * Threaded into the engine separately from tool metadata because they come
 * from the live `initialize` handshake, not the tools list.
 */
export type ConnectionFacts = {
  /** Protocol version the server negotiated at connect (`initialize`). */
  protocolVersion?: string;
};

export type CompatFinding = {
  lane: CompatLane;
  severity: CompatFindingSeverity;
  title: string;
  detail: string;
  remediation?: string;
  /**
   * Source of THIS finding's host fact — so a Tier-2 `observed` fact reads as
   * stronger than an `assumed` preset without implying every host fact was
   * observed. In Phase 1 all findings inherit the host profile's provenance.
   */
  provenance: CompatProvenance;
};

/** Per-lane rollup so the UI can show apps vs server verdicts independently. */
export type CompatLaneVerdict = {
  verdict: CompatVerdict;
  /** Weakest provenance among this lane's findings (host baseline if none). */
  provenance: CompatProvenance;
};

export type HostCompatReport = {
  hostId: string;
  hostLabel: string;
  logoSrc: string;
  logoSrcByTheme?: { light: string; dark: string };
  /** Worst-wins aggregate across lanes. */
  verdict: CompatVerdict;
  /** Host's baseline provenance (dominant source for its facts). */
  provenance: CompatProvenance;
  /** Per-lane verdicts (`apps`, `server`). */
  lanes: Record<CompatLane, CompatLaneVerdict>;
  findings: CompatFinding[];
};

/**
 * What the server demands of a host. Two lanes:
 *  - **apps** (widget-shaped): derived from the tools list + L1 widget scan —
 *    where hosts most visibly differ.
 *  - **server** (capability negotiation): `connectionFacts` from the live
 *    `initialize`. Today just the protocol version — a host *advertising a
 *    different protocol version* is a real capability gap, distinct from a
 *    local server merely not reaching a cloud host (the reason transport/auth
 *    stay out). Richer server-lane facts (elicitation/sampling/roots) are
 *    observed live in Phase 3, not derivable statically.
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
  /**
   * Server-lane connection facts (protocol version). Separate from widget data
   * because it comes from `initialize`, not the tools list. Absent when the
   * caller has no live connection — the protocol check is then skipped.
   */
  connectionFacts?: ConnectionFacts;
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
   * MCP base-protocol versions this host advertises, sourced from its
   * host-template seed (`mcpProfile.initialize.supportedProtocolVersions`).
   * Undefined when the template doesn't pin versions — the server-lane
   * protocol check is then skipped.
   */
  supportedProtocolVersions?: string[];
  /**
   * The host's SEP-1865 MCP Apps capability matrix (from the registry).
   * Present only when the host renders widgets at all — a CLI host (Codex)
   * leaves this undefined.
   */
  capabilities?: ResolvedMcpAppsCapabilities;
};
