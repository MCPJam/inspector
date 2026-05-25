import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { JsonEditor } from "@/components/ui/json-editor";
import type { McpProtocolVersion } from "@/lib/client-config-v2";

/**
 * Dropdown options for the per-server protocol-version pin. Mirrors the
 * OAuth debugger's "Protocol" dropdown pattern from
 * `AuthenticationSection.tsx` so users see consistent affordances across
 * the inspector. Wire literals as values; era hints in labels.
 *
 * `"default"` is a UI-only sentinel that the change handler maps to
 * `undefined` before reaching state — preserves the SDK-default
 * semantics so canonical hashes don't churn (see
 * `feedback_preserve_undefined_default` memory).
 */
type DropdownValue = McpProtocolVersion | "default";

const MCP_PROTOCOL_OPTIONS: Array<{
  value: DropdownValue;
  label: string;
  /** When true, the option appears only with `stateless-mcp-enabled` flag. */
  flagGated?: boolean;
}> = [
  { value: "default", label: "Default (SDK chooses)" },
  {
    value: "DRAFT-2026-v1",
    label: "DRAFT-2026-v1 (RC, stateless)",
    flagGated: true,
  },
  { value: "2025-11-25", label: "2025-11-25 (Latest stable)" },
  { value: "2025-06-18", label: "2025-06-18" },
  { value: "2025-03-26", label: "2025-03-26 (Legacy)" },
];

interface HeaderEntry {
  id?: string;
  key: string;
  value: string;
}

interface AdvancedConnectionSettingsSectionProps {
  showConfiguration: boolean;
  onToggle: () => void;
  requestTimeout: string;
  onRequestTimeoutChange: (value: string) => void;
  inheritedRequestTimeout?: number;
  customHeaders?: HeaderEntry[];
  onAddHeader?: () => void;
  onRemoveHeader?: (index: number) => void;
  onUpdateHeader?: (
    index: number,
    field: "key" | "value",
    value: string,
  ) => void;
  clientCapabilitiesOverrideEnabled?: boolean;
  onClientCapabilitiesOverrideEnabledChange?: (enabled: boolean) => void;
  clientCapabilitiesOverrideText?: string;
  onClientCapabilitiesOverrideTextChange?: (value: string) => void;
  clientCapabilitiesOverrideError?: string | null;
  headersWarning?: string;
  /**
   * Visibility flag for the protocol-version override row. Wired from
   * `useFeatureFlagEnabled("stateless-mcp-enabled")` at the caller. When
   * false, the entire dropdown is hidden AND the `DRAFT-2026-v1` option
   * is omitted from the option list (the RC option is the flag-gated
   * piece; stateful options are always available behind the same flag).
   * Defaults to false. Host-default JSON keeps working regardless —
   * just no per-server affordance.
   */
  showMcpProtocolVersionOverride?: boolean;
  /**
   * Current per-server pinned MCP protocol version. `undefined` = inherit
   * host default (which itself may be `undefined` = SDK default). Bound on
   * the project server config row at save time, NOT on the server's own
   * config blob — host-default vs per-server override is a control-plane
   * edit fanned out to host configs.
   */
  mcpProtocolVersionOverride?: McpProtocolVersion;
  onMcpProtocolVersionOverrideChange?: (
    version: McpProtocolVersion | undefined,
  ) => void;
  /**
   * Transport kind of this server. Stateless options are HTTP-POST only,
   * so for stdio / SSE we filter the dropdown to stateful versions
   * (factory rejects stateless on those transports — UI filter is the
   * user-friendly safety net).
   */
  transportKind?: "http" | "stdio" | "sse";
}

export function AdvancedConnectionSettingsSection({
  showConfiguration,
  onToggle,
  requestTimeout,
  onRequestTimeoutChange,
  inheritedRequestTimeout = 10000,
  customHeaders,
  onAddHeader,
  onRemoveHeader,
  onUpdateHeader,
  clientCapabilitiesOverrideEnabled = false,
  onClientCapabilitiesOverrideEnabledChange,
  clientCapabilitiesOverrideText = "{}",
  onClientCapabilitiesOverrideTextChange,
  clientCapabilitiesOverrideError,
  headersWarning,
  showMcpProtocolVersionOverride = false,
  mcpProtocolVersionOverride,
  onMcpProtocolVersionOverrideChange,
  transportKind = "http",
}: AdvancedConnectionSettingsSectionProps) {
  const showHeaderControls =
    customHeaders !== undefined &&
    onAddHeader !== undefined &&
    onRemoveHeader !== undefined &&
    onUpdateHeader !== undefined;
  const showClientCapabilitiesControls =
    onClientCapabilitiesOverrideEnabledChange !== undefined &&
    onClientCapabilitiesOverrideTextChange !== undefined;
  const showProtocolVersionControl =
    showMcpProtocolVersionOverride &&
    onMcpProtocolVersionOverrideChange !== undefined;
  // Stateless options are Streamable HTTP POST only. For non-HTTP
  // transports, filter the dropdown to stateful versions only — picking
  // a stateless version would fail at construction with
  // `StatelessRequiresHttpTransport`. Filtering here is the user-friendly
  // safety net (factory rejection is the hard floor).
  const isHttp = transportKind === "http";
  const visibleOptions = MCP_PROTOCOL_OPTIONS.filter((opt) => {
    if (opt.flagGated && !showMcpProtocolVersionOverride) return false;
    if (
      !isHttp &&
      opt.value !== "default" &&
      // For non-HTTP, drop the stateless option(s).
      (opt.value === "DRAFT-2026-v1")
    ) {
      return false;
    }
    return true;
  });
  const selectedDropdownValue: DropdownValue =
    mcpProtocolVersionOverride ?? "default";

  return (
    <div className="space-y-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-1.5 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {showConfiguration ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        Connection overrides
      </button>

      {showConfiguration && (
        <div className="mt-2 space-y-3 border-l-2 border-border/60 pl-3">
          {/* Timeout */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">
              Timeout{" "}
              <span className="font-normal text-muted-foreground">
                (ms, default {inheritedRequestTimeout})
              </span>
            </label>
            <Input
              type="number"
              value={requestTimeout}
              onChange={(e) => onRequestTimeoutChange(e.target.value)}
              placeholder={String(inheritedRequestTimeout)}
              className="h-8 text-xs"
              min="1000"
              max="600000"
              step="1000"
            />
          </div>

          {/* Headers */}
          {showHeaderControls && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">
                  Headers
                </label>
                <button
                  type="button"
                  onClick={onAddHeader}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </div>
              {customHeaders.length > 0 && (
                <div className="space-y-1">
                  {customHeaders.map((header, index) => (
                    <div
                      key={header.id ?? `${header.key}-${index}`}
                      className="flex items-center gap-1.5"
                    >
                      <Input
                        value={header.key}
                        onChange={(e) => onUpdateHeader(index, "key", e.target.value)}
                        placeholder="Key"
                        className="h-7 flex-1 text-xs"
                      />
                      <Input
                        value={header.value}
                        onChange={(e) =>
                          onUpdateHeader(index, "value", e.target.value)
                        }
                        placeholder="Value"
                        className="h-7 flex-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => onRemoveHeader(index)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {headersWarning && (
                <p role="alert" className="text-xs text-amber-700">
                  {headersWarning}
                </p>
              )}
            </div>
          )}

          {/* Client capabilities override */}
          {showClientCapabilitiesControls && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">
                  Capabilities override
                </label>
                <Switch
                  checked={clientCapabilitiesOverrideEnabled}
                  onCheckedChange={onClientCapabilitiesOverrideEnabledChange}
                  aria-label="Toggle client capabilities override"
                  className="scale-90"
                />
              </div>

              {clientCapabilitiesOverrideEnabled && (
                <>
                  {clientCapabilitiesOverrideError && (
                    <div className="rounded border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
                      {clientCapabilitiesOverrideError}
                    </div>
                  )}
                  <div className="overflow-hidden rounded border border-border bg-background">
                    <JsonEditor
                      rawContent={clientCapabilitiesOverrideText}
                      onRawChange={onClientCapabilitiesOverrideTextChange}
                      mode="edit"
                      showModeToggle={false}
                      showToolbar={false}
                      className="h-[160px]"
                      height="160px"
                      wrapLongLinesInEdit={false}
                      showLineNumbers
                      showValidationErrorInStatusBar={false}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Per-server MCP protocol-version pin.

              Mirrors the OAuth debugger's "Protocol" dropdown
              (`AuthenticationSection.tsx`) so users see the same
              affordance pattern across the inspector. Gated by
              `stateless-mcp-enabled` at the caller. The dropdown's
              "Default (SDK chooses)" option serializes to `undefined`,
              preserving canonical-hash stability across SDK default
              upgrades. Stateless options are filtered out for
              non-HTTP transports (factory rejects them otherwise). */}
          {showProtocolVersionControl && (
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-foreground"
                title="Pin the MCP protocol version this server speaks. 'Default' lets the SDK choose at request time. Stateless options use the experimental DRAFT-2026-v1 transport and require Streamable HTTP."
              >
                Protocol version
              </label>
              <Select
                value={selectedDropdownValue}
                onValueChange={(next) => {
                  if (!onMcpProtocolVersionOverrideChange) return;
                  if (next === "default") {
                    onMcpProtocolVersionOverrideChange(undefined);
                  } else {
                    onMcpProtocolVersionOverrideChange(
                      next as McpProtocolVersion,
                    );
                  }
                }}
              >
                <SelectTrigger className="h-9 w-full text-xs">
                  <SelectValue placeholder="Default (SDK chooses)" />
                </SelectTrigger>
                <SelectContent>
                  {visibleOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!isHttp && (
                <p className="text-xs text-muted-foreground">
                  Stateless options require Streamable HTTP — only
                  stateful protocol versions are selectable for this
                  transport.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
