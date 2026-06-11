/**
 * Host compatibility report — prototype of the design in
 * `design-explorations/host-compat-report.md` (L0 static checks).
 *
 * Pure type surface; no React, no fetches. The engine joins
 * `ServerRequirements` (derived from connect-time data the client already
 * holds) against per-host `HostCompatProfile`s (best-effort capability
 * facts, each tagged with provenance).
 */

export type CompatVerdict = "works" | "degraded" | "blocked" | "unknown";

export type CompatFindingSeverity = "blocker" | "degraded" | "info";

/**
 * Where a host-profile fact comes from. Surfaced in the UI so a verdict
 * never reads as more authoritative than its weakest source:
 *   - "vendor-doc": published by the host vendor (e.g. M365 Copilot's
 *     capability table)
 *   - "probe": captured from a real host build (e.g. Cursor 3.4.17 probe)
 *   - "assumed": best-effort preset judgment, unverified
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
  verdict: CompatVerdict;
  provenance: CompatProvenance;
  findings: CompatFinding[];
};

/**
 * What the server demands of a host, derived from data already on the
 * client at (or shortly after) connect time: the server config blob
 * (transport, OAuth), `initializationInfo` (advertised capabilities), and
 * the tools list (widget usage via `_meta`).
 */
export type ServerRequirements = {
  transport: "stdio" | "http";
  /**
   * Whether a remote-only host could reach this server. True for HTTP
   * servers, and for stdio servers that have an active tunnel (ngrok)
   * exposing them over HTTPS. Drives the transport blocker so a tunnel the
   * user created from the card actually clears the verdict.
   */
  reachableRemotely: boolean;
  usesOAuth: boolean;
  protocolVersion?: string;
  /** undefined = not connected yet (capabilities unknown, not "none"). */
  capabilities?: {
    prompts: boolean;
    resources: boolean;
    logging: boolean;
    completions: boolean;
  };
  /** undefined = tools metadata not loaded yet. */
  widgets?: {
    /** Tool names rendering via MCP Apps (`_meta.ui.resourceUri`) only. */
    mcpAppsOnly: string[];
    /** Tool names rendering via OpenAI Apps (`openai/outputTemplate`) only. */
    openaiAppsOnly: string[];
    /** Tool names declaring both bridges (renderable on either host kind). */
    dual: string[];
  };
  /** Human-readable dimensions we could not derive yet. */
  unknownDimensions: string[];
};

export type HostCompatProfile = {
  id: string;
  label: string;
  logoSrc: string;
  /** Dominant provenance for this profile's facts. */
  provenance: CompatProvenance;
  transports: { stdio: boolean; remoteHttp: boolean };
  /** Host can complete an OAuth flow against a protected server. */
  oauth: boolean;
  serverCapabilities: {
    prompts: boolean;
    resources: boolean;
    logging: boolean;
    completions: boolean;
  };
  apps: {
    mcpApps: boolean;
    openaiApps: boolean;
  };
};
