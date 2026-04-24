import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { JsonEditor } from "@/components/ui/json-editor";

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
  const showHeaderControls =
    customHeaders !== undefined &&
    onAddHeader !== undefined &&
    onRemoveHeader !== undefined &&
    onUpdateHeader !== undefined;
  const showClientCapabilitiesControls =
    onClientCapabilitiesOverrideEnabledChange !== undefined &&
    onClientCapabilitiesOverrideTextChange !== undefined;

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
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
