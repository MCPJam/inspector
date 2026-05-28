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
 * Per-server protocol-version pin. Three-state picker:
 *   - "inherit" → `undefined`, defers to the host default (or SDK default if
 *     no host default is set).
 *   - "latest"  → `"2025-11-25"`, explicit stable pin — overrides a
 *     host-level RC default.
 *   - "rc"      → `"2026-07-28"`, the stateless RC preview client.
 */
type DropdownValue = "inherit" | "latest" | "rc";

const MCP_PROTOCOL_OPTIONS: Array<{
  value: DropdownValue;
  label: string;
  /** When true, the option appears only with `stateless-mcp-enabled` flag. */
  flagGated?: boolean;
}> = [
  { value: "inherit", label: "Host default" },
  { value: "latest", label: "Latest (2025-11-25)" },
  { value: "rc", label: "2026 RC (2026-07-28)", flagGated: true },
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
    value: string
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
   * false, the entire dropdown is hidden AND the `2026-07-28` RC option
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
    version: McpProtocolVersion | undefined
  ) => void;
  /**
   * Transport kind of this server. MCPJam's current stateless preview
   * is HTTP-POST only, so for stdio / SSE we filter the dropdown to
   * stateful versions (factory rejects stateless on those transports —
   * UI filter is the user-friendly safety net).
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
  const showProtocolVersionControl = showMcpProtocolVersionOverride;
  const canEditProtocolVersion =
    onMcpProtocolVersionOverrideChange !== undefined;
  // MCPJam's current RC preview is Streamable HTTP POST only — picking
  // it on stdio / sse would fail at construction with
  // `StatelessRequiresHttpTransport`.
  // Hide it on non-HTTP transports as the user-friendly safety net.
  const isHttp = transportKind === "http";
  const visibleOptions = MCP_PROTOCOL_OPTIONS.filter((opt) => {
    if (opt.value === "rc" && !isHttp) return false;
    return true;
  });
  const selectedDropdownValue: DropdownValue =
    mcpProtocolVersionOverride === "2026-07-28"
      ? "rc"
      : mcpProtocolVersionOverride === "2025-11-25"
      ? "latest"
      : "inherit";

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
                        onChange={(e) =>
                          onUpdateHeader(index, "key", e.target.value)
                        }
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

          {/* Per-server MCP protocol-version pin. Tri-state picker:
              "Latest" → `"2025-11-25"` (legacy adapter + initialize
              handshake); "2026 RC" → `"2026-07-28"` (stateless RC
              preview client). Gated by `stateless-mcp-enabled` at the
              caller. The RC option is hidden on non-HTTP transports
              because MCPJam's current stateless client requires
              Streamable HTTP. */}
          {showProtocolVersionControl && (
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-foreground"
                title="Latest: the current stable MCP wire version (2025-11-25). 2026 RC: MCPJam's current 2026-07-28 stateless preview over Streamable HTTP POST."
              >
                Protocol version
              </label>
              <Select
                value={selectedDropdownValue}
                disabled={!canEditProtocolVersion}
                onValueChange={(next) => {
                  if (!onMcpProtocolVersionOverrideChange) return;
                  onMcpProtocolVersionOverrideChange(
                    next === "rc"
                      ? "2026-07-28"
                      : next === "latest"
                      ? "2025-11-25"
                      : undefined
                  );
                }}
              >
                <SelectTrigger className="h-9 w-full text-xs">
                  <SelectValue placeholder="Latest" />
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
                  MCPJam's current 2026 RC preview requires Streamable HTTP —
                  only Latest is selectable for this transport.
                </p>
              )}
              {!canEditProtocolVersion && (
                <p className="text-xs text-muted-foreground">
                  Project configuration must finish loading before setting a
                  per-server protocol override.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
