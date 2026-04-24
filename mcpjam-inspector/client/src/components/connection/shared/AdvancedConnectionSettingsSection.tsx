import { ChevronDown, ChevronRight } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { JsonEditor } from "@/components/ui/json-editor";
import { CustomHeadersSection } from "./CustomHeadersSection";

interface HeaderEntry {
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
}

function countConfiguredHeaders(customHeaders: HeaderEntry[] | undefined): number {
  return (
    customHeaders?.filter(
      (header) => header.key.trim() !== "" || header.value.trim() !== "",
    ).length ?? 0
  );
}

function hasCustomTimeout(
  requestTimeout: string,
  inheritedRequestTimeout: number,
): boolean {
  const parsed = Number.parseInt(requestTimeout.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return requestTimeout.trim() !== "";
  }
  return parsed !== inheritedRequestTimeout;
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
}: AdvancedConnectionSettingsSectionProps) {
  const headerCount = countConfiguredHeaders(customHeaders);
  const showHeaderControls =
    customHeaders !== undefined &&
    onAddHeader !== undefined &&
    onRemoveHeader !== undefined &&
    onUpdateHeader !== undefined;
  const showClientCapabilitiesControls =
    onClientCapabilitiesOverrideEnabledChange !== undefined &&
    onClientCapabilitiesOverrideTextChange !== undefined;
  const summaryItems = [
    headerCount > 0
      ? `${headerCount} header${headerCount === 1 ? "" : "s"} configured`
      : undefined,
    hasCustomTimeout(requestTimeout, inheritedRequestTimeout)
      ? `Timeout: ${requestTimeout}ms`
      : undefined,
    clientCapabilitiesOverrideEnabled
      ? "Client capabilities override"
      : undefined,
  ].filter(Boolean) as string[];

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-3 p-3 hover:bg-muted/50 transition-colors cursor-pointer text-left"
      >
        <div className="flex items-start gap-2 min-w-0">
          {showConfiguration ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground mt-0.5" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground mt-0.5" />
          )}
          <div className="space-y-1 min-w-0">
            <span className="block text-sm font-medium text-foreground">
              Connection Overrides
            </span>
            <p className="text-xs text-muted-foreground">
              Override workspace headers, timeout, and client capabilities for
              this server.
            </p>
          </div>
        </div>

        {summaryItems.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {summaryItems.map((item) => (
              <span
                key={item}
                className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground whitespace-nowrap"
              >
                {item}
              </span>
            ))}
          </div>
        )}
      </button>

      {showConfiguration && (
        <div className="p-4 space-y-4 border-t border-border bg-muted/30">
          {showHeaderControls && (
            <div className="space-y-2">
              <CustomHeadersSection
                customHeaders={customHeaders}
                onAdd={onAddHeader}
                onRemove={onRemoveHeader}
                onUpdate={onUpdateHeader}
              />
              <p className="text-xs text-muted-foreground">
                Workspace default headers are merged automatically. Per-server
                keys win on conflicts.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Request Timeout
            </label>
            <Input
              type="number"
              value={requestTimeout}
              onChange={(e) => onRequestTimeoutChange(e.target.value)}
              placeholder={String(inheritedRequestTimeout)}
              className="h-10"
              min="1000"
              max="600000"
              step="1000"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to inherit the workspace default ({inheritedRequestTimeout}
              ms). Min: 1000ms, max: 600000ms.
            </p>
          </div>

          {showClientCapabilitiesControls && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-foreground">
                    Client Capabilities Override
                  </label>
                  <p className="text-xs text-muted-foreground">
                    When enabled, this replaces the workspace client
                    capabilities for this server.
                  </p>
                </div>
                <Switch
                  checked={clientCapabilitiesOverrideEnabled}
                  onCheckedChange={onClientCapabilitiesOverrideEnabledChange}
                  aria-label="Toggle client capabilities override"
                />
              </div>

              {clientCapabilitiesOverrideEnabled && (
                <div className="space-y-2">
                  {clientCapabilitiesOverrideError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                      {clientCapabilitiesOverrideError}
                    </div>
                  ) : null}
                  <div className="overflow-hidden rounded-md border border-border bg-background">
                    <JsonEditor
                      rawContent={clientCapabilitiesOverrideText}
                      onRawChange={onClientCapabilitiesOverrideTextChange}
                      mode="edit"
                      showModeToggle={false}
                      showToolbar={false}
                      className="h-[220px]"
                      height="220px"
                      wrapLongLinesInEdit={false}
                      showLineNumbers
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
