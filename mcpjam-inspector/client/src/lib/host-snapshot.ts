import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { findHostStyle } from "@/lib/client-styles";

export type HostSnapshot = Pick<
  HostConfigDtoV2,
  "hostStyle" | "hostCapabilitiesOverride" | "chatUiOverride" | "mcpProfile"
> & Partial<Pick<HostConfigDtoV2, "hostContext">>;

/** A run's persisted preset identity; unknown styles must not become MCPJam. */
export function hostSnapshotFromStyle(
  hostStyle: string | null | undefined,
): HostSnapshot | null {
  const style = hostStyle?.trim();
  return style && findHostStyle(style) ? { hostStyle: style } : null;
}

/**
 * Extract the playground card's host-snapshot from a full host config DTO.
 * Centralizes the projection so multi-host callers don't reach into
 * arbitrary DTO fields. Returns a fresh object — no aliasing — but does
 * NOT deep-clone the inner records (the card treats them as read-only).
 */
export function snapshotFromHostConfig(config: HostConfigDtoV2): HostSnapshot {
  return {
    hostStyle: config.hostStyle,
    hostContext: config.hostContext,
    hostCapabilitiesOverride: config.hostCapabilitiesOverride,
    chatUiOverride: config.chatUiOverride,
    mcpProfile: config.mcpProfile,
  };
}
