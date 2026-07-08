import type { McpProtocolVersionPin } from "@/lib/client-config-v2";

interface EffectiveProtocolVersionChipProps {
  /**
   * Host-level default from `mcpProfile.mcpProtocolVersion`. `undefined` =
   * no explicit pin — behaves as Auto when the stateless-MCP flag is on,
   * SDK-default legacy negotiation otherwise.
   */
  hostDefault?: McpProtocolVersionPin;
  /**
   * Per-server override from `projectServerRefs.mcpProtocolVersionOverride`.
   * `undefined` = no override, inherit host default.
   */
  serverOverride?: McpProtocolVersionPin;
  /**
   * Whether the stateless-MCP / Auto feature is on (`useStatelessMcpEnabled`
   * at the caller). Controls only the label for the unpinned state: with the
   * flag on, unpinned connections resolve to Auto at connect time, so the
   * chip says "Auto"; with it off they use the legacy SDK default, so the
   * chip keeps saying "Latest". Explicit pins render the same either way.
   */
  flagEnabled?: boolean;
}

/** Read-only label for the effective MCP protocol version on a server. */
export function EffectiveProtocolVersionChip({
  hostDefault,
  serverOverride,
  flagEnabled = false,
}: EffectiveProtocolVersionChipProps) {
  const effective: McpProtocolVersionPin | undefined =
    serverOverride ?? hostDefault;

  const label =
    effective === "auto"
      ? "Auto"
      : effective !== undefined
      ? effective
      : flagEnabled
      ? "Auto"
      : "Latest";

  return (
    <span className="inline-flex items-center px-1 text-[11px] text-muted-foreground">
      {label}
    </span>
  );
}
