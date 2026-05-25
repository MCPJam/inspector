import type { McpProtocolVersion } from "@/lib/client-config-v2";
import { isStatelessProtocolVersion } from "@mcpjam/sdk/browser";

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
   * effect until the dispatch wiring is enabled. Hides labels like
   * "DRAFT-2026-v1 · host default" before stateless dispatch is live.
   */
  flagEnabled?: boolean;
}

/**
 * Read-only chip showing the effective pinned protocol version for a
 * server connection and which layer in the three-layer config resolution
 * it came from. Source attribution helps users notice when a host-default
 * change cascaded to a server that has no override of its own.
 *
 * Resolution rule (mirror of the bridge / wire-client factory):
 *   server override wins; otherwise host default; otherwise SDK default.
 *
 * `undefined` resolution is rendered as "Default (SDK)" — preserves the
 * undefined-as-default semantics that lets canonical hashes stay stable
 * when the SDK upgrades its default version.
 */
export function EffectiveProtocolVersionChip({
  hostDefault,
  serverOverride,
  flagEnabled = false,
}: EffectiveProtocolVersionChipProps) {
  if (!flagEnabled) return null;

  const effective: McpProtocolVersion | undefined =
    serverOverride ?? hostDefault;

  const sourceLabel =
    serverOverride !== undefined
      ? "server pin"
      : hostDefault !== undefined
        ? "host default"
        : "SDK default";

  const isStateless =
    effective !== undefined && isStatelessProtocolVersion(effective);

  const tone = isStateless
    ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
    : "border-border bg-muted text-muted-foreground";

  const label = effective ?? "SDK default";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
      title={
        isStateless
          ? `Stateless MCP transport pinned to ${effective}`
          : effective !== undefined
            ? `Stateful MCP transport pinned to ${effective}`
            : "MCP protocol version negotiated by the SDK at request time"
      }
    >
      {label}
      <span className="text-[9px] opacity-70">· {sourceLabel}</span>
    </span>
  );
}
