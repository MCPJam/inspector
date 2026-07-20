/**
 * Host-compatibility types — the shared verdict vocabulary for "does this MCP
 * server work on host X?". Framework-free and logo-free: the SDK owns the
 * compatibility *facts*; surfaces (inspector UI / CLI / API) join presentation
 * (logos, theme) by host id at render time.
 *
 * Relocated from the inspector client (`client/src/lib/host-compat/types.ts`)
 * so the inspector, the `mcpjam` CLI, the public API, and the MCP server all
 * evaluate against one engine instead of the logic living only in the browser.
 */

import type { McpAppsCapabilities } from "../host-config/types.js";
import type { WidgetCapabilityNeed, WidgetUsage } from "./widget-scan.js";

export type CompatVerdict = "works" | "degraded" | "blocked" | "unknown";

export type CompatFindingSeverity = "blocker" | "degraded" | "info";

/**
 * Which axis a finding belongs to. `apps` = widget/rendering (does the host
 * render this widget + expose the host APIs it calls). `server` = capability
 * negotiation (protocol version today; elicitation/sampling/roots once observed
 * live). They fail for different reasons and aggregate independently.
 */
export type CompatLane = "apps" | "server";

/**
 * Where a host-profile fact comes from. Surfaced so a verdict never reads as
 * more authoritative than its weakest source. `observed` is the strongest —
 * earned by a live run; the rest are static.
 */
export type CompatProvenance = "observed" | "vendor-doc" | "probe" | "assumed";

/**
 * Provenance for a single capability dimension. Extends `CompatProvenance` with
 * `untestable` — a dimension that cannot be exercised against the real client
 * at all (the host ships no public build, needs an enterprise tenant, never
 * sends `ui/initialize`, …).
 *
 * `untestable` is not a synonym for `assumed`. `assumed` means nobody checked;
 * `untestable` means somebody tried and the door is closed. Only the second can
 * be shown to a developer without misleading them, which is why the catalog
 * requires a `reason` alongside it.
 */
export type CapabilityProvenance = CompatProvenance | "untestable";

/**
 * Where one capability fact came from. A host-level `provenance` alone can't
 * express that a matrix is part-measured and part-guessed, which is how a
 * "verified against X" badge ends up sitting on top of values nobody checked.
 */
export type CapabilityVerification = {
  provenance: CapabilityProvenance;
  /** When this dimension specifically was last verified (ms epoch). */
  verifiedAt?: number;
  /** Why it can't be tested. Always present when provenance is `untestable`. */
  reason?: string;
  /** Where the evidence lives (capture id, vendor doc URL, probe run). */
  evidence?: string;
};

/**
 * Connection-derived facts about the *server under test* (not the host).
 * Threaded separately from tool metadata because they come from the live
 * `initialize` handshake, not the tools list.
 */
export type ConnectionFacts = {
  /** Protocol version the server negotiated at connect (`initialize`). */
  protocolVersion?: string;
};

/**
 * Stable machine key for a finding — the contract surfaces (CLI/API/MCP) filter
 * and group on, instead of parsing prose. The prose fields are default copy.
 */
export type CompatFindingCode =
  /** App-only widget the host can't render — no text fallback (blocker). */
  | "app_only_unrenderable"
  /** Widget the host can't render but has a text fallback (degraded). */
  | "widget_text_fallback"
  /** Widget uses a host capability the host lacks (degraded/info). */
  | "capability_unsupported"
  /** Server's negotiated protocol version isn't in the host's set (info). */
  | "protocol_version_mismatch";

/** Fields common to every finding. The prose is default copy, not the contract. */
type CompatFindingBase = {
  lane: CompatLane;
  severity: CompatFindingSeverity;
  /** Default human copy — surfaces may re-render from the semantic fields. */
  title: string;
  detail: string;
  remediation?: string;
  /**
   * Source of THIS finding's host fact — so a Tier-2 `observed` fact reads as
   * stronger than an `assumed` preset without implying every host fact was
   * observed. Statically, all findings inherit the host profile's provenance.
   */
  provenance: CompatProvenance;
};

/**
 * A finding, discriminated by `code` so the per-code shape is encoded in the
 * type system — a `capability_unsupported` finding always carries `capability`,
 * a protocol mismatch never carries `tools`, etc. Surfaces narrow on `code`.
 */
export type CompatFinding =
  | (CompatFindingBase & { code: "app_only_unrenderable"; tools: string[] })
  | (CompatFindingBase & { code: "widget_text_fallback"; tools: string[] })
  | (CompatFindingBase & {
      code: "capability_unsupported";
      capability: WidgetCapabilityNeed;
      tools: string[];
    })
  | (CompatFindingBase & { code: "protocol_version_mismatch" });

/** Per-lane rollup so a surface can show apps vs server verdicts independently. */
export type CompatLaneVerdict = {
  verdict: CompatVerdict;
  /** Weakest provenance among this lane's findings (host baseline if none). */
  provenance: CompatProvenance;
};

export type HostCompatReport = {
  hostId: string;
  hostLabel: string;
  /** When this host's catalog facts were last verified/reviewed (ms epoch). */
  verifiedAt?: number;
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
 *  - **apps** (widget-shaped): derived from the tools list + L1 widget scan.
 *  - **server** (capability negotiation): `connectionFacts` from `initialize`
 *    (today just the protocol version).
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
   * Widget tools that are app-only (`_meta.ui.visibility` excludes `"model"`).
   * No text fallback — a host that can't render them makes the tool unusable.
   */
  appOnlyWidgets: string[];
  hasWidgets: boolean;
  /**
   * L1 scan result: which host capabilities this server's widgets actually use,
   * mapped to the tools that need them. `undefined` = not scanned (the engine
   * withholds capability findings rather than guess); `{}` = scanned, clean.
   */
  widgetUsage?: WidgetUsage;
  /** Server-lane connection facts (protocol version) from `initialize`. */
  connectionFacts?: ConnectionFacts;
  /** Human-readable dimensions we could not derive yet. */
  unknownDimensions: string[];
};

/** How a host renders MCP tool-result image previews (the "MCP tool-result
 * images" host setting). Distinct from widget rendering — even tools-only
 * hosts can surface images. */
export type ImagePlacement = "none" | "collapsed" | "inline";

/** Per image-source support: whether the model sees it, and whether the UI
 * renders it. */
export type ImageSourceSupport = {
  /** Image is passed to the model. */
  model: boolean;
  /** Image is rendered in the host UI (at the host's `placement`). */
  ui: boolean;
};

/**
 * A host's tool-result image handling, per MCP result shape. `placement` is one
 * mode for the whole host (a host renders inline OR collapsed OR nothing).
 */
export type HostImageSupport = {
  /** Direct MCP image blocks returned by tools. */
  toolImageContent: ImageSourceSupport;
  /** Image blobs embedded inside MCP resources. */
  embeddedResourceImages: ImageSourceSupport;
  /** Image links resolved through MCP resources/read. */
  resourceLinkImages: ImageSourceSupport;
  /** Where rendered image previews appear (`none` = the UI shows none). */
  placement: ImagePlacement;
};

/**
 * A host's compatibility *facts* (no presentation). Surfaces join logos/theme
 * by `id`. `capabilities` is the SEP-1865 MCP Apps matrix; absent for a host
 * that renders no widgets (e.g. a CLI host).
 */
export type HostCompatProfile = {
  id: string;
  label: string;
  provenance: CompatProvenance;
  /** When this host's catalog facts were last verified/reviewed (ms epoch). */
  verifiedAt?: number;
  rendersMcpApps: boolean;
  rendersOpenAiApps: boolean;
  supportedProtocolVersions?: string[];
  /**
   * SEP-1865 MCP Apps capability matrix. Typed against the SDK's
   * `McpAppsCapabilities` (dims optional); a host's fully-resolved matrix is
   * assignable. A missing/false dim reads as "not supported". Absent for a host
   * that renders no widgets (e.g. a CLI host).
   */
  capabilities?: McpAppsCapabilities;
  /**
   * Per-dimension provenance for `capabilities`, keyed by dimension name.
   * Present only for hosts the catalog has audited; a dimension missing from
   * the map has no recorded evidence either way. Surfaces should prefer this
   * over the host-level `provenance` when explaining a specific capability.
   */
  capabilityVerification?: Record<string, CapabilityVerification>;
  /**
   * Explicit sandbox permission allowlist from the host's MCP Apps profile.
   * `undefined` means the catalog did not publish an exact allowlist; an
   * empty object is meaningful and means the host allows none of them.
   */
  sandboxPermissionAllow?: Record<string, boolean>;
  /** Tool-result image handling (see `HostImageSupport`). */
  imageSupport?: HostImageSupport;
};
