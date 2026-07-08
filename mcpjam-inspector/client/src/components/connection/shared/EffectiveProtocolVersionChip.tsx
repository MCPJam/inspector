import type { McpProtocolVersionPin } from "@/lib/client-config-v2";

interface EffectiveProtocolVersionChipProps {
  /**
   * Host-level default from `mcpProfile.mcpProtocolVersion`. `undefined` =
   * SDK chooses at request time.
   */
  hostDefault?: McpProtocolVersionPin;
  /**
   * Per-server override from `projectServerRefs.mcpProtocolVersionOverride`.
   * `undefined` = no override, inherit host default.
   */
  serverOverride?: McpProtocolVersionPin;
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

  const effective: McpProtocolVersionPin | undefined =
    serverOverride ?? hostDefault;

  // Unpinned (`undefined`) now resolves to Auto at connect time — it probes
  // the stateless RC and falls back to the legacy handshake — so render it as
  // "Auto" to match the actual wire behavior. Only an explicit wire-version
  // pin surfaces a concrete version label.
  return (
    <span className="inline-flex items-center px-1 text-[11px] text-muted-foreground">
      {!effective || effective === "auto" ? "Auto" : effective}
    </span>
  );
}
