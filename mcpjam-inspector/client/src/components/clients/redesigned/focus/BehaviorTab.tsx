import { useId, useMemo } from "react";
import { Info } from "lucide-react";
import { Slider } from "@mcpjam/design-system/slider";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  DEFAULT_TEMPERATURE_V2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { SUPPORTED_MODELS } from "@/shared/types";
import { FieldRow, FocusBlock } from "./primitives";
import { fieldsWithIssues } from "./useClientDraftValidation";
import type { HostAttentionIssue } from "../types";

// Tri-state UI ↔ persisted value. The backend treats `undefined` as
// "auto" (orchestrator may still enable progressive mode above the
// catalog/context thresholds), so collapsing it to a two-state Switch
// would let the user see the toggle "off" while progressive discovery
// actually fires. The three buttons map 1:1 to the three persisted
// states; "Auto" preserves `undefined` so the backend dedupe hash
// stays distinct from an explicit on/off override.
type ProgressiveTriState = "auto" | "on" | "off";
function progressiveValueToTri(
  value: boolean | undefined,
): ProgressiveTriState {
  if (value === true) return "on";
  if (value === false) return "off";
  return "auto";
}
function triToProgressiveValue(
  value: ProgressiveTriState,
): boolean | undefined {
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

interface BehaviorTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
  /**
   * When true, all controls render disabled. Used by the attachment
   * editor when surfacing the client's profile in a context where the
   * user shouldn't be editing it inline (edits flow through the owning
   * Client surface instead).
   */
  readOnly?: boolean;
}

export function BehaviorTab({
  draft,
  onDraftChange,
  attention,
  readOnly = false,
}: BehaviorTabProps) {
  const issues = fieldsWithIssues(attention, "behavior");
  const reactId = useId();

  // Group models by provider for the model dropdown — kept simple and
  // non-virtualized; SUPPORTED_MODELS is on the order of dozens.
  const modelsByProvider = useMemo(() => {
    const map = new Map<string, typeof SUPPORTED_MODELS>();
    for (const m of SUPPORTED_MODELS) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries());
  }, []);

  const update = (patch: Partial<HostConfigInputV2>) =>
    onDraftChange((prev) => ({ ...prev, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock title="Model & sampling">
        <FieldRow
          label="Model"
          control={
            <select
              id={`${reactId}-model`}
              value={draft.modelId}
              onChange={(e) => update({ modelId: e.target.value })}
              disabled={readOnly}
              className={
                "h-8 w-[260px] rounded-md border border-input bg-background px-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-60 " +
                (issues.has("modelId") ? "border-amber-500" : "")
              }
            >
              <option value="">— Select model —</option>
              {modelsByProvider.map(([provider, models]) => (
                <optgroup key={provider} label={provider}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          }
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium">Temperature</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {draft.temperature.toFixed(2)}
            </span>
          </div>
          <Slider
            value={[draft.temperature]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={(values) =>
              update({
                temperature: values[0] ?? DEFAULT_TEMPERATURE_V2,
              })
            }
            aria-label="Temperature"
            disabled={readOnly}
          />
        </div>

        <FieldRow
          label="Require tool approval"
          control={
            <Switch
              checked={draft.requireToolApproval}
              onCheckedChange={(checked) =>
                update({ requireToolApproval: checked })
              }
              aria-label="Require tool approval"
              disabled={readOnly}
            />
          }
        />

        <FieldRow
          label="Respect tool visibility"
          control={
            <Switch
              checked={draft.respectToolVisibility}
              onCheckedChange={(checked) =>
                update({ respectToolVisibility: checked })
              }
              aria-label="Respect tool visibility"
              disabled={readOnly}
            />
          }
        />

        <FieldRow
          label={
            <span className="inline-flex items-center gap-1.5">
              Progressive tools
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="About progressive tool discovery"
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  variant="muted"
                  side="top"
                  sideOffset={4}
                  className="max-w-[260px] leading-snug"
                >
                  Auto lets the chat orchestrator hide the catalog behind{" "}
                  <code>search_mcp_tools</code> / <code>load_mcp_tools</code>{" "}
                  once the host crosses ~30 tools, 10k tool tokens, or 3% of
                  the model's context window. On forces it always, Off never.
                </TooltipContent>
              </Tooltip>
            </span>
          }
          /**
           * 3-state, not 2-state: the backend reads `undefined` as
           * "auto" and may enable progressive discovery above catalog/
           * context thresholds even with no user opt-in. A Switch would
           * hide that, so "Auto" makes the auto-policy state explicit.
           */
          control={
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={progressiveValueToTri(draft.progressiveToolDiscovery)}
              onValueChange={(value) => {
                // Radix calls onValueChange("") when the user
                // re-clicks the active item. Treat that as no-op so
                // there's always exactly one selected state.
                if (!value) return;
                update({
                  progressiveToolDiscovery: triToProgressiveValue(
                    value as ProgressiveTriState,
                  ),
                });
              }}
              aria-label="Progressive MCP tool discovery"
              disabled={readOnly}
            >
              <ToggleGroupItem value="auto" aria-label="Auto (default)">
                Auto
              </ToggleGroupItem>
              <ToggleGroupItem value="on" aria-label="On">
                On
              </ToggleGroupItem>
              <ToggleGroupItem value="off" aria-label="Off">
                Off
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />

        <FieldRow
          label="Respect tool visibility"
          control={
            <Switch
              checked={draft.respectToolVisibility}
              onCheckedChange={(checked) =>
                update({ respectToolVisibility: checked })
              }
              aria-label="Respect tool visibility"
              disabled={readOnly}
            />
          }
        />
      </FocusBlock>

      <FocusBlock title="System prompt">
        <Textarea
          rows={10}
          value={draft.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
          placeholder="You are a helpful assistant…"
          readOnly={readOnly}
          className={
            issues.has("systemPrompt") ? "border-amber-500/60" : undefined
          }
        />
      </FocusBlock>
    </div>
  );
}
