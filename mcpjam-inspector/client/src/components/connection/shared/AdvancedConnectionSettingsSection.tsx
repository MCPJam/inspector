import { useId } from "react";
import { ChevronDown, ChevronRight, Eye, Plus, X } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import { useMaskedValues } from "../hooks/use-masked-values";
import { MaskedValueInput } from "./MaskedValueInput";
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
}> = [
  { value: "inherit", label: "Client default" },
  { value: "latest", label: "Latest (2025-11-25)" },
  { value: "rc", label: "2026 RC (2026-07-28)" },
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
  hasStoredHeaders?: boolean;
  isRevealingHeaders?: boolean;
  headersRevealError?: string | null;
  onRevealHeaders?: () => void;
  clientCapabilitiesOverrideEnabled?: boolean;
  onClientCapabilitiesOverrideEnabledChange?: (enabled: boolean) => void;
  clientCapabilitiesOverrideText?: string;
  onClientCapabilitiesOverrideTextChange?: (value: string) => void;
  clientCapabilitiesOverrideError?: string | null;
  headersWarning?: string;
  /**
   * Visibility for the protocol-version override row. Edit-server contexts
   * (where the per-server override can be persisted on the project layer)
   * pass true; the Add Server modal passes true only when a shared project
   * id exists (the pin rides the form payload and is applied to the project
   * layer once the hosted server row is created). Defaults to false.
   * Host-default JSON keeps working regardless — just no per-server
   * affordance.
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
  hasStoredHeaders = false,
  isRevealingHeaders = false,
  headersRevealError,
  onRevealHeaders,
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
  const headersHidden = hasStoredHeaders && (customHeaders?.length ?? 0) === 0;
  // Header values carry bearer tokens and API keys, so they mask the same way
  // env-var values do. See use-masked-values for why the toggle needs no fetch.
  const maskedHeaders = useMaskedValues();
  const handleAddHeader = () => {
    maskedHeaders.markAdded(customHeaders?.length ?? 0);
    onAddHeader?.();
  };
  const handleRemoveHeader = (index: number) => {
    maskedHeaders.dropAt(index);
    onRemoveHeader?.(index);
  };
  const handleRevealHeaders = () => {
    maskedHeaders.revealAll();
    onRevealHeaders?.();
  };
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
  // Per-instance so several of these forms can be mounted at once without
  // colliding on a shared element id. Suffixed for the controls whose visible
  // label sits in a sibling element and so needs an explicit association.
  const bodyId = useId();
  const timeoutFieldId = `${bodyId}-timeout`;
  const protocolLabelId = `${bodyId}-protocol-label`;
  const protocolTriggerId = `${bodyId}-protocol-trigger`;
  const selectedDropdownValue: DropdownValue =
    mcpProtocolVersionOverride === "2026-07-28"
      ? "rc"
      : mcpProtocolVersionOverride === "2025-11-25"
      ? "latest"
      : "inherit";

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={showConfiguration}
        aria-controls={bodyId}
        className="group flex cursor-pointer items-center gap-1.5 text-left"
      >
        {showConfiguration ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
        )}
        <span className="text-sm font-medium text-foreground">
          Connection overrides
        </span>
      </button>

      {/* Always mounted so `aria-controls` resolves while collapsed. */}
      <div id={bodyId}>
        {showConfiguration && (
          <div className="space-y-4">
            {/* Timeout */}
            <div className="space-y-1.5">
              <label
                htmlFor={timeoutFieldId}
                className="text-xs font-medium text-foreground"
              >
                Timeout{" "}
                <span className="font-normal text-muted-foreground">
                  (ms, default {inheritedRequestTimeout})
                </span>
              </label>
              <Input
                id={timeoutFieldId}
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

            {/* Headers. Same row idiom as the env-var editor: monospace
                key/value pair, muted separator, ghost remove. */}
            {showHeaderControls && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-foreground">
                    Headers
                  </label>
                  <button
                    type="button"
                    onClick={handleAddHeader}
                    disabled={headersHidden}
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </button>
                </div>
                {headersHidden && (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
                    <div>
                      <p className="text-xs font-medium text-foreground">
                        Hidden — Reveal to view
                      </p>
                      {headersRevealError && (
                        <p
                          role="alert"
                          className="mt-1 text-xs text-destructive"
                        >
                          {headersRevealError}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={isRevealingHeaders || !onRevealHeaders}
                      onClick={handleRevealHeaders}
                      className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      {isRevealingHeaders ? "Revealing..." : "Reveal"}
                    </button>
                  </div>
                )}
                {!headersHidden && customHeaders.length === 0 && (
                  <button
                    type="button"
                    onClick={handleAddHeader}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add header
                  </button>
                )}
                {customHeaders.length > 0 && (
                  <div className="space-y-1.5">
                    {customHeaders.map((header, index) => {
                      const label = header.key || `header ${index + 1}`;
                      return (
                        <div
                          key={header.id ?? `${header.key}-${index}`}
                          className="flex items-center gap-1.5"
                        >
                          <Input
                            value={header.key}
                            onChange={(e) =>
                              onUpdateHeader(index, "key", e.target.value)
                            }
                            placeholder="Header"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            aria-label={`Header ${index + 1} name`}
                            className="h-8 flex-1 font-mono text-xs"
                          />
                          <span
                            aria-hidden="true"
                            className="shrink-0 select-none text-xs text-muted-foreground/70"
                          >
                            :
                          </span>
                          <MaskedValueInput
                            value={header.value}
                            onChange={(value) =>
                              onUpdateHeader(index, "value", value)
                            }
                            visible={maskedHeaders.isVisible(index)}
                            onToggleVisibility={() => maskedHeaders.toggle(index)}
                            inputLabel={`Header ${index + 1} value`}
                            subject={label}
                            className="flex-[1.4]"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveHeader(index)}
                            aria-label={`Remove ${label}`}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
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
                preview client). The RC option is hidden on non-HTTP
                transports because MCPJam's current stateless client
                requires Streamable HTTP. */}
            {showProtocolVersionControl && (
              <div className="space-y-1.5">
                <label
                  id={protocolLabelId}
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
                  {/* Name from the visible label AND the trigger's own text, so
                      the selected version is still announced — a bare
                      `aria-label` would replace the value, not add to it. */}
                  <SelectTrigger
                    id={protocolTriggerId}
                    aria-labelledby={`${protocolLabelId} ${protocolTriggerId}`}
                    className="h-8 w-full text-xs"
                  >
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
    </div>
  );
}
