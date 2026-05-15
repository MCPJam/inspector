import { useId, useMemo } from "react";
import { Slider } from "@mcpjam/design-system/slider";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  DEFAULT_TEMPERATURE_V2,
  type HostConfigInputV2,
  type HostStyleId,
} from "@/lib/host-config-v2";
import { listHostStyles } from "@/lib/host-styles";
import { SUPPORTED_MODELS } from "@/shared/types";
import { FieldRow, FocusBlock, SegmentedControl } from "./primitives";
import { fieldsWithIssues } from "./useHostDraftValidation";
import type { HostAttentionIssue } from "../types";

interface BehaviorTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
}

export function BehaviorTab({
  draft,
  onDraftChange,
  attention,
}: BehaviorTabProps) {
  const issues = fieldsWithIssues(attention, "behavior");
  const reactId = useId();
  const styles = useMemo(() => listHostStyles(), []);

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
      <FocusBlock
        title="Model & sampling"
        subtitle="How this host samples completions during chat."
      >
        <FieldRow
          label="Model"
          description="Provider × model that the host will call. The handoff names it the 'agent layer'."
          control={
            <select
              id={`${reactId}-model`}
              value={draft.modelId}
              onChange={(e) => update({ modelId: e.target.value })}
              className={
                "h-8 w-[260px] rounded-md border border-input bg-background px-2 text-[12px] " +
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
          />
          <div className="flex justify-between font-mono text-[10px] text-muted-foreground/70">
            <span>0.00</span>
            <span>1.00</span>
          </div>
        </div>
      </FocusBlock>

      <FocusBlock
        title="Host style"
        subtitle="Seeds the capability preset advertised in ui/initialize."
      >
        <SegmentedControl<HostStyleId>
          ariaLabel="Host style"
          value={draft.hostStyle}
          onChange={(next) => update({ hostStyle: next })}
          options={styles.map((s) => ({
            value: s.id,
            label: s.label,
            hint: s.pickerDescription,
          }))}
        />
        <FieldRow
          label="Require tool approval"
          description="When on, the host pauses before each tool call for user confirmation."
          control={
            <Switch
              checked={draft.requireToolApproval}
              onCheckedChange={(checked) =>
                update({ requireToolApproval: checked })
              }
              aria-label="Require tool approval"
            />
          }
        />
      </FocusBlock>

      <FocusBlock
        title="System prompt"
        subtitle="Sent verbatim as the system message on every chat turn."
        action={
          issues.has("systemPrompt") ? (
            <span className="text-[10.5px] text-amber-700 dark:text-amber-300">
              attention
            </span>
          ) : null
        }
      >
        <Textarea
          rows={10}
          value={draft.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
          placeholder="You are a helpful assistant…"
          className={
            issues.has("systemPrompt") ? "border-amber-500/60" : undefined
          }
        />
      </FocusBlock>

    </div>
  );
}
