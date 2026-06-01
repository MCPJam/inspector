import type { McpProtocolVersion } from "@/lib/client-config-v2";

interface EffectiveProtocolVersionChipProps {
  /**
   * Host-level default from `mcpProfile.mcpProtocolVersion`. `undefined` =
   * SDK chooses at request time.
   */
  hostDefault?: McpProtocolVersion;
  /**
   * Per-server override from `projectServerRefs.mcpProtocolVersionOverride`.
   * `undefined` = no override, inherit host default.
   */
  serverOverride?: McpProtocolVersion;
  /**
   * When the feature flag is off, the chip surfaces nothing — the
   * config field may still carry a stored pin but it has no runtime
   * effect until the dispatch wiring is enabled.
   */
  flagEnabled?: boolean;
}

/** Read-only label for the effective MCP protocol version on a server. */
export function EffectiveProtocolVersionChip({
  hostDefault,
  serverOverride,
  flagEnabled = false,
}: EffectiveProtocolVersionChipProps) {
  if (!flagEnabled) return null;

  const effective: McpProtocolVersion | undefined =
    serverOverride ?? hostDefault;

  return (
    <span className="inline-flex items-center px-1 text-[11px] text-muted-foreground">
      {effective ?? "Latest"}
    </span>
  );
}
