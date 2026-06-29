import { useMemo, type ReactNode } from "react";
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
  isMcpDirectContentImageVisible,
  isMcpEmbeddedResourceBlobImageVisible,
  isMcpLinkedResourceBlobImageVisible,
  setMcpDirectContentImageVisible,
  setMcpEmbeddedResourceBlobImageVisible,
  setMcpLinkedResourceBlobImageVisible,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { hostConfigField } from "@/lib/host-config-field-schema";
import { harnessControlState } from "@/lib/harness-capabilities";
import type { ModelDefinition } from "@/shared/types";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { useAvailableModels } from "@/hooks/use-available-models";
import { FieldRow, FocusBlock } from "./primitives";
import { fieldsWithIssues } from "./useHostDraftValidation";
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
  value: boolean | undefined
): ProgressiveTriState {
  if (value === true) return "on";
  if (value === false) return "off";
  return "auto";
}
function triToProgressiveValue(
  value: ProgressiveTriState
): boolean | undefined {
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

function InfoHoverLabel({
  label,
  tooltip,
}: {
  label: ReactNode;
  tooltip?: ReactNode;
}) {
  if (!tooltip) return <>{label}</>;

  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${String(label)}`}
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
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

interface BehaviorTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2
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

  // Same model source as the Playground picker (org providers in hosted
  // mode, local keys otherwise) so org-only providers like Bedrock and
  // OpenRouter are selectable here too.
  const { availableModels } = useAvailableModels();
  const currentModel = useMemo<ModelDefinition>(() => {
    const match = availableModels.find((m) => String(m.id) === draft.modelId);
    if (match) return match;
    // Stale or org-revoked id (or an empty/still-loading draft): keep the
    // raw id visible in the trigger instead of silently coercing to an
    // available model. Empty provider → ProviderLogo renders no icon.
    return {
      id: draft.modelId,
      name: draft.modelId || "Select model",
      provider: "" as ModelDefinition["provider"],
    };
  }, [availableModels, draft.modelId]);

  const update = (patch: Partial<HostConfigInputV2>) =>
    onDraftChange((prev) => ({ ...prev, ...patch }));

  // Labels and descriptions are sourced from the shared field schema so
  // the focus tab and the cross-host comparison matrix stay in sync.
  // Changing a label here would otherwise drift; lookups throw on a typo
  // so renames fail loudly at the first render.
  const fModel = hostConfigField("modelId");
  const fTemp = hostConfigField("temperature");
  const fApproval = hostConfigField("requireToolApproval");
  const fVisibility = hostConfigField("respectToolVisibility");
  const fDirectImages = hostConfigField(
    "modelVisibleMcpToolResults.directContent.image"
  );
  const fEmbeddedImages = hostConfigField(
    "modelVisibleMcpToolResults.embeddedResources.blob.image"
  );
  const fLinkedImages = hostConfigField(
    "modelVisibleMcpToolResults.linkedResources.blob.image"
  );
  const fRenderImages = hostConfigField("mcpToolResultImageRendering");
  const fProgressive = hostConfigField("progressiveToolDiscovery");
  const fSystemPrompt = hostConfigField("systemPrompt");

  // A real harness (e.g. Claude Code) runs its own loop, so some knobs don't
  // cross into its runtime until the MCP proxy mediates them — and a few never
  // can. Gray those out per-control (model + system prompt always apply, so
  // they stay enabled) with an honest note, instead of letting the toggle look
  // live while doing nothing. Un-graying is a one-line change in
  // `harness-capabilities.ts` as each proxy phase lands.
  const tempState = harnessControlState(draft.harness, "temperature");
  const approvalState = harnessControlState(draft.harness, "requireToolApproval");
  const visibilityState = harnessControlState(
    draft.harness,
    "respectToolVisibility",
  );
  const progressiveState = harnessControlState(
    draft.harness,
    "progressiveToolDiscovery",
  );

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock title="Model & sampling">
        <FieldRow
          label={fModel.label}
          description={fModel.description}
          control={
            <div
              className={
                issues.has("modelId")
                  ? "rounded-full ring-1 ring-amber-500"
                  : undefined
              }
            >
              <ModelSelector
                currentModel={currentModel}
                availableModels={availableModels}
                onModelChange={(model) => update({ modelId: String(model.id) })}
                disabled={readOnly}
                align="end"
                analyticsLocation="client_builder"
              />
            </div>
          }
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium">{fTemp.label}</span>
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
            aria-label={fTemp.label}
            disabled={readOnly || !tempState.enforced}
          />
          {!tempState.enforced ? (
            <p className="text-[11px] text-muted-foreground">{tempState.note}</p>
          ) : null}
        </div>

        <FieldRow
          label={fApproval.label}
          description={
            approvalState.enforced
              ? fApproval.description
              : `${fApproval.description} ${approvalState.note}`
          }
          control={
            <Switch
              checked={draft.requireToolApproval}
              onCheckedChange={(checked) =>
                update({ requireToolApproval: checked })
              }
              aria-label={fApproval.label}
              disabled={readOnly || !approvalState.enforced}
            />
          }
        />

        <FieldRow
          label={fVisibility.label}
          description={
            visibilityState.enforced
              ? fVisibility.description
              : `${fVisibility.description} ${visibilityState.note}`
          }
          control={
            <Switch
              checked={draft.respectToolVisibility}
              onCheckedChange={(checked) =>
                update({ respectToolVisibility: checked })
              }
              aria-label={fVisibility.label}
              disabled={readOnly || !visibilityState.enforced}
            />
          }
        />

        <FieldRow
          label={
            <InfoHoverLabel
              label={fDirectImages.label}
              tooltip={
                <>
                  Pass{" "}
                  <a
                    href="https://modelcontextprotocol.io/specification/2025-11-25/server/tools#image-content"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    direct image blocks
                  </a>{" "}
                  returned by MCP tools to the model.
                </>
              }
            />
          }
          control={
            <Switch
              checked={isMcpDirectContentImageVisible(
                draft.modelVisibleMcpToolResults
              )}
              onCheckedChange={(checked) =>
                update({
                  modelVisibleMcpToolResults: setMcpDirectContentImageVisible(
                    draft.modelVisibleMcpToolResults,
                    checked
                  ),
                })
              }
              aria-label={fDirectImages.label}
              disabled={readOnly}
            />
          }
        />

        <FieldRow
          label={
            <InfoHoverLabel
              label={fEmbeddedImages.label}
              tooltip={
                <>
                  Pass{" "}
                  <a
                    href="https://modelcontextprotocol.io/specification/2025-11-25/server/tools#embedded-resources"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    embedded resource blobs
                  </a>{" "}
                  with image MIME types to the model.
                </>
              }
            />
          }
          control={
            <Switch
              checked={isMcpEmbeddedResourceBlobImageVisible(
                draft.modelVisibleMcpToolResults
              )}
              onCheckedChange={(checked) =>
                update({
                  modelVisibleMcpToolResults:
                    setMcpEmbeddedResourceBlobImageVisible(
                      draft.modelVisibleMcpToolResults,
                      checked
                    ),
                })
              }
              aria-label={fEmbeddedImages.label}
              disabled={readOnly}
            />
          }
        />

        <FieldRow
          label={
            <InfoHoverLabel
              label={fLinkedImages.label}
              tooltip={
                <>
                  Resolve{" "}
                  <a
                    href="https://modelcontextprotocol.io/specification/2025-11-25/server/tools#resource-links"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    image resource links
                  </a>{" "}
                  through MCP <code>resources/read</code> and pass the image to
                  the model.
                </>
              }
            />
          }
          control={
            <Switch
              checked={isMcpLinkedResourceBlobImageVisible(
                draft.modelVisibleMcpToolResults
              )}
              onCheckedChange={(checked) =>
                update({
                  modelVisibleMcpToolResults:
                    setMcpLinkedResourceBlobImageVisible(
                      draft.modelVisibleMcpToolResults,
                      checked
                    ),
                })
              }
              aria-label={fLinkedImages.label}
              disabled={readOnly}
            />
          }
        />

        <FieldRow
          label={
            <InfoHoverLabel
              label={fRenderImages.label}
              tooltip="Controls where MCP tool-returned images appear in the UI: hidden, collapsed tool cards, or inline."
            />
          }
          control={
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={draft.mcpToolResultImageRendering ?? "inline"}
              onValueChange={(value) => {
                if (!value) return;
                if (
                  value === "none" ||
                  value === "panel" ||
                  value === "inline"
                ) {
                  update({ mcpToolResultImageRendering: value });
                }
              }}
              disabled={readOnly}
              aria-label={fRenderImages.label}
            >
              <ToggleGroupItem value="none" aria-label="Do not render images">
                None
              </ToggleGroupItem>
              <ToggleGroupItem
                value="panel"
                aria-label="Render images in collapsed tool cards"
              >
                Collapsed
              </ToggleGroupItem>
              <ToggleGroupItem value="inline" aria-label="Render images inline">
                Inline
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />

        <FieldRow
          label={
            <span className="inline-flex items-center gap-1.5">
              {fProgressive.label}
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
                  once the host crosses ~30 tools, 10k tool tokens, or 3% of the
                  model's context window. On forces it always, Off never.
                </TooltipContent>
              </Tooltip>
            </span>
          }
          description={
            progressiveState.enforced ? undefined : progressiveState.note
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
                    value as ProgressiveTriState
                  ),
                });
              }}
              aria-label="Progressive MCP tool discovery"
              disabled={readOnly || !progressiveState.enforced}
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
      </FocusBlock>

      <FocusBlock title={fSystemPrompt.label}>
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
