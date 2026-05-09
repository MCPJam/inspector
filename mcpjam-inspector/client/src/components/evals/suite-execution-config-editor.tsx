import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw, Save, Settings2, Trash2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { HostConfigEditor } from "@/components/host-config/HostConfigEditor";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  type HostConfigDtoV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import type { EvalSuite } from "./types";
import type { ModelDefinition } from "@/shared/types";

type SuiteExecutionConfigEditorProps = {
  suite: Pick<EvalSuite, "_id" | "defaultConfig">;
  availableModels: ModelDefinition[];
  /**
   * Optional clear callback — surfaces "Remove" affordance when the
   * suite has a saved defaultConfig. The legacy mirror is cleared via
   * the wider `updateTestSuite({ defaultConfig: null })` mutation
   * which the parent owns, so we keep this as a callback rather than
   * hardcoding the v1 path here.
   */
  onClear?: () => Promise<void>;
};

/**
 * Eval suite execution config editor.
 *
 * Phase 3 read switch: the editor now reads + writes through the v2
 * `hostConfigsV2.{getSuiteConfig,setSuiteConfig}` API. Server selection
 * is hidden (servers come from `suite.environment`; the backend rejects
 * non-empty serverIds), but model / system prompt / temperature /
 * tool-approval / connection-defaults / capabilities / hostContext are
 * all editable through the shared HostConfigEditor.
 *
 * `setSuiteConfig` mirrors `{ modelId, systemPrompt, temperature }`
 * back to `suite.defaultConfig` for legacy readers (run snapshot,
 * inspector eval UI display labels) until Phase 5 drops the column.
 */
export function SuiteExecutionConfigEditor({
  suite,
  availableModels,
  onClear,
}: SuiteExecutionConfigEditorProps) {
  void availableModels; // currently unused; HostConfigEditor uses a free-text modelId.

  const dto = useQuery(
    "hostConfigsV2:getSuiteConfig" as any,
    { suiteId: suite._id } as any,
  ) as HostConfigDtoV2 | null | undefined;

  const setSuiteConfig = useMutation(
    "hostConfigsV2:setSuiteConfig" as any,
  ) as unknown as (args: {
    suiteId: string;
    input: HostConfigInputV2;
  }) => Promise<string>;

  const [value, setValue] = useState<HostConfigInputV2 | null>(null);
  const [baseline, setBaseline] = useState<HostConfigInputV2 | null>(null);
  const [hasJsonError, setHasJsonError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    if (dto === undefined) return; // still loading
    const next = dto
      ? hostConfigDtoToInput(dto)
      : emptyHostConfigInputV2({
          // Seed empty editor with suite.defaultConfig.{modelId,systemPrompt,
          // temperature} when the v2 row hasn't been written yet — so a
          // first-time save through HostConfigEditor doesn't blow away
          // a legacy-only suite config.
          modelId: suite.defaultConfig?.modelId,
          systemPrompt: suite.defaultConfig?.systemPrompt,
          temperature: suite.defaultConfig?.temperature,
        });
    setBaseline(next);
    setValue((current) => {
      if (current && baseline && !hostConfigInputsEqual(current, baseline)) {
        return current; // preserve unsaved edits
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto, suite._id]);

  const isDirty = useMemo(
    () =>
      value && baseline ? !hostConfigInputsEqual(value, baseline) : !!value,
    [value, baseline],
  );

  if (!value) {
    return (
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Default Execution Config
          </h2>
        </div>
        <div className="flex items-center gap-2 rounded-xl border bg-card/60 p-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading suite config…
        </div>
      </section>
    );
  }

  // setSuiteConfig refuses non-empty serverIds; if a stale v2 row
  // somehow carried any, force them empty before saving so the
  // backend's validator doesn't reject the otherwise-valid edit.
  // Server selection lives on `suite.environment`.
  const stripped: HostConfigInputV2 = {
    ...value,
    serverIds: [],
    optionalServerIds: [],
  };
  const canSave = isDirty && !hasJsonError && !isSaving && !isClearing;

  const handleReset = () => {
    if (baseline) setValue(baseline);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await setSuiteConfig({ suiteId: suite._id, input: stripped });
      setBaseline(stripped);
      setValue(stripped);
    } catch (err) {
      throw err;
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    if (!onClear) return;
    setIsClearing(true);
    try {
      await onClear();
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Default Execution Config
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The model and parameters all iterations in this suite inherit. Per-case{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            advancedConfig
          </code>{" "}
          overrides take precedence. Server selection lives in the suite
          environment, not here.
        </p>
      </div>

      <div className="rounded-xl border bg-card/60 p-4">
        <HostConfigEditor
          value={value}
          onChange={setValue}
          owner="eval-suite"
          onValidityChange={setHasJsonError}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5" />
          <span>
            {value.modelId
              ? `Default: ${value.modelId}`
              : "No default model configured"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onClear && suite.defaultConfig ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleClear()}
              disabled={isClearing || isSaving}
              className="text-destructive hover:text-destructive"
            >
              {isClearing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              Remove
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={!isDirty || isSaving || isClearing}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save config
          </Button>
        </div>
      </div>
    </section>
  );
}
