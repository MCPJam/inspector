import type { McpWireMode } from "@/lib/client-config-v2";

interface EffectiveModeChipProps {
  /**
   * Host-level default from `mcpProfile.mcpWireMode`. `undefined` =
   * implicit legacy.
   */
  hostDefault?: McpWireMode;
  /**
   * Per-server override from `projectServerRefs.mcpWireModeOverride`.
   * `undefined` = no override, inherit host default.
   */
  serverOverride?: McpWireMode;
  /**
   * When the feature flag is off, the only visible chip is "Legacy" with
   * no source attribution — the host-default JSON might still carry a
   * value but it has no runtime effect until PR3 lands the dispatch
   * wiring. Avoids leaking "Stateless · host default" before stateless
   * actually does anything.
   */
  flagEnabled?: boolean;
}

/**
 * Read-only chip showing the effective wire mode for a server connection
 * and which layer in the three-layer config resolution it came from.
 * Source attribution helps users notice when a host-default change
 * cascaded to a server that has no override of its own.
 *
 * Resolution rule (mirror of the bridge / wire-client factory):
 *   server override wins; otherwise host default; otherwise "legacy".
 */
export function EffectiveModeChip({
  hostDefault,
  serverOverride,
  flagEnabled = false,
}: EffectiveModeChipProps) {
  const effective: McpWireMode =
    serverOverride ?? hostDefault ?? "legacy";

  // Pre-flag rollout: surface only "Legacy" so users don't see a
  // misleading "Stateless · host default" label before PR3 wires the
  // factory branch. The host-default value still persists; we just hide
  // its surface effect here.
  if (!flagEnabled) {
    return (
      <span
        className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        title="Legacy MCP transport (initialize handshake + upstream Client)"
      >
        Legacy
      </span>
    );
  }

  const sourceLabel =
    serverOverride !== undefined
      ? "server override"
      : hostDefault !== undefined
        ? "host default"
        : "default";

  const tone =
    effective === "stateless-draft-2026-v1"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
      : "border-border bg-muted text-muted-foreground";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
      title={
        effective === "stateless-draft-2026-v1"
          ? "Experimental DRAFT-2026-v1 stateless transport preview"
          : "Legacy MCP transport (initialize handshake + upstream Client)"
      }
    >
      {effective === "stateless-draft-2026-v1"
        ? "Stateless"
        : "Legacy"}
      <span className="text-[9px] opacity-70">· {sourceLabel}</span>
    </span>
  );
}
