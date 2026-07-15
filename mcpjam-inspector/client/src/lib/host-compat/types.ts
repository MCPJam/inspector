/**
 * Host compatibility types.
 *
 * The verdict vocabulary and report shapes now live in the shared SDK engine
 * (`@mcpjam/sdk/host-compat`) so the inspector UI, the `mcpjam` CLI, the public
 * API, and the MCP server all evaluate against one engine. The SDK is
 * framework-free and logo-free — it owns the compatibility *facts*.
 *
 * This module re-exports those SDK types (so existing client importers keep
 * working) and adds the client-only *presentation* extensions: the per-host
 * logos and the `rendersWidgets` convenience flag the UI joins by host id.
 */

import type {
  HostCompatProfile as SdkHostCompatProfile,
  HostCompatReport as SdkHostCompatReport,
} from "@mcpjam/sdk/host-compat";

export type {
  CompatVerdict,
  CompatFindingSeverity,
  CompatLane,
  CompatProvenance,
  ConnectionFacts,
  CompatFinding,
  CompatLaneVerdict,
  ServerRequirements,
} from "@mcpjam/sdk/host-compat";

/**
 * SDK host profile (logo-free facts) plus the client presentation join: the
 * per-host logo, optionally themed (light/dark).
 */
export type HostCompatProfile = SdkHostCompatProfile & {
  logoSrc: string;
  logoSrcByTheme?: { light: string; dark: string };
};

/**
 * SDK report (logo-free facts) plus the client presentation join: the per-host
 * logo (optionally themed) and `rendersWidgets` — whether this host renders
 * widgets at all (MCP Apps or the OpenAI shim). A CLI host (Codex) renders
 * neither; the flag gates the "Run live render" affordance (nothing to observe
 * for a host with no rendering surface).
 */
export type HostCompatReport = SdkHostCompatReport & {
  logoSrc: string;
  logoSrcByTheme?: { light: string; dark: string };
  rendersWidgets?: boolean;
};
