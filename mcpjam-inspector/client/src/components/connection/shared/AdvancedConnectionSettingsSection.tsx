import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { JsonEditor } from "@/components/ui/json-editor";
import type { McpWireMode } from "@/lib/client-config-v2";

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
   * Visibility flag for the experimental DRAFT-2026-v1 stateless wire-mode
   * override row. Wired from `useFeatureFlagEnabled("stateless-mcp-enabled")`
   * at the caller so the section file stays free of feature-flag plumbing.
   * Defaults to false; absent or false hides the entire row regardless of
   * the value of `mcpWireModeOverride` (host-default JSON keeps working,
   * just no per-server affordance).
   */
  showMcpWireModeOverride?: boolean;
  /**
   * Current per-server wire-mode override. `undefined` = inherit host
   * default. Bound on the project server config row at save time, NOT on
   * the server's own config blob — host-default vs per-server override
   * is a control-plane edit that gets fanned out to host configs.
   */
  mcpWireModeOverride?: McpWireMode;
  onMcpWireModeOverrideChange?: (mode: McpWireMode | undefined) => void;
  /**
   * Transport kind of this server. The stateless preview is HTTP-POST
   * only, so we lock the toggle for stdio / SSE servers (factory rejects
   * them anyway — UI lock is the user-friendly safety net per the
   * "requires Streamable HTTP POST" hint).
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
  showMcpWireModeOverride = false,
  mcpWireModeOverride,
  onMcpWireModeOverrideChange,
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
  const showWireModeControl =
    showMcpWireModeOverride && onMcpWireModeOverrideChange !== undefined;
  const wireModeOverrideEnabled = mcpWireModeOverride !== undefined;
  // Stateless preview is Streamable HTTP POST only. Lock the toggle for
  // stdio / SSE rather than letting the user pick a mode that will fail
  // at construction with StatelessPreviewRequiresHttpTransport.
  const wireModeLocked = transportKind !== "http";

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

          {/* MCP wire-mode override (DRAFT-2026-v1 preview).
              Gated by the `stateless-mcp-enabled` feature flag at the
              caller so the row stays hidden until the wire client lands.
              Off (default) → server inherits the host default; on →
              segmented selector picks the per-server mode and writes
              projectServerRefs.mcpWireModeOverride. */}
          {showWireModeControl && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  className="text-xs font-medium text-foreground"
                  title="Use stateless MCP for this server. Partial DRAFT-2026-v1 support — server-initiated requests (sampling, elicitation) and subscriptions are not yet implemented."
                >
                  Wire mode override
                </label>
                <Switch
                  checked={wireModeOverrideEnabled}
                  disabled={wireModeLocked && !wireModeOverrideEnabled}
                  onCheckedChange={(checked) => {
                    if (!onMcpWireModeOverrideChange) return;
                    // Switching on defaults to the stateless preview —
                    // there's no point in flipping the toggle just to
                    // re-pin "legacy" since that's already the host
                    // default for most users. The segmented selector
                    // below lets you change to "legacy" explicitly.
                    onMcpWireModeOverrideChange(
                      checked ? "stateless-draft-2026-v1" : undefined,
                    );
                  }}
                  aria-label="Toggle MCP wire-mode override"
                  className="scale-90"
                />
              </div>
              {wireModeLocked && (
                <p className="text-xs text-muted-foreground">
                  Stateless preview requires Streamable HTTP POST.
                </p>
              )}
              {wireModeOverrideEnabled && !wireModeLocked && (
                <div
                  role="radiogroup"
                  aria-label="Wire mode"
                  className="flex w-fit overflow-hidden rounded border border-border bg-background text-xs"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mcpWireModeOverride === "legacy"}
                    onClick={() =>
                      onMcpWireModeOverrideChange?.("legacy")
                    }
                    className={
                      mcpWireModeOverride === "legacy"
                        ? "px-2.5 py-1 bg-muted text-foreground"
                        : "px-2.5 py-1 text-muted-foreground hover:text-foreground"
                    }
                  >
                    Legacy
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={
                      mcpWireModeOverride === "stateless-draft-2026-v1"
                    }
                    onClick={() =>
                      onMcpWireModeOverrideChange?.(
                        "stateless-draft-2026-v1",
                      )
                    }
                    className={
                      mcpWireModeOverride === "stateless-draft-2026-v1"
                        ? "px-2.5 py-1 bg-muted text-foreground"
                        : "px-2.5 py-1 text-muted-foreground hover:text-foreground"
                    }
                  >
                    Stateless (DRAFT-2026-v1)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
