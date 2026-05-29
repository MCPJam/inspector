import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, Save, Settings2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { ClientConfigEditor } from "@/components/client-config/ClientConfigEditor";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  type HostConfigDtoV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { EvalSuite } from "./types";
import type { ModelDefinition } from "@/shared/types";

type SuiteExecutionConfigEditorProps = {
  suite: Pick<EvalSuite, "_id" | "defaultConfig">;
  availableModels: ModelDefinition[];
  /**
   * Phase 4: when set, surfaces a "Reset to project default" affordance.
   * The parent passes the convex project id so the editor can fetch the
   * project default and write it through `setSuiteConfig`. Replaces the
   * legacy "Remove" button which cleared `suite.defaultConfig` via
   * `updateTestSuite({ defaultConfig: null })`.
   */
  projectId?: string | null;
};

/**
 * Eval suite execution config editor.
 *
 * Phase 3 read switch: the editor now reads + writes through the v2
 * `hostConfigsV2.{getSuiteConfig,setSuiteConfig}` API. Server selection
 * is hidden, but preserved from the suite hostConfig while model /
 * system prompt / temperature / tool-approval / connection-defaults /
 * capabilities / hostContext are editable through the shared
 * ClientConfigEditor.
 *
 * `setSuiteConfig` mirrors `{ modelId, systemPrompt, temperature }`
 * back to `suite.defaultConfig` for legacy readers (run snapshot,
 * inspector eval UI display labels) until Phase 5 drops the column.
 */
export function SuiteExecutionConfigEditor({
  suite,
  availableModels,
  projectId,
}: SuiteExecutionConfigEditorProps) {
  void availableModels; // currently unused; ClientConfigEditor uses a free-text modelId.

  const dto = useQuery(
    "hostConfigsV2:getSuiteConfig" as any,
    { suiteId: suite._id } as any
  ) as HostConfigDtoV2 | null | undefined;

  // Phase 4: project default snapshot used by the "Reset to project
  // default" affordance. Skipped when no projectId is wired through
  // (e.g. unscoped guest suites).
  const projectDefaultDto = useQuery(
    "hostConfigsV2:getProjectDefault" as any,
    projectId ? ({ projectId } as any) : "skip"
  ) as HostConfigDtoV2 | null | undefined;

  const setSuiteConfig = useMutation(
    "hostConfigsV2:setSuiteConfig" as any
  ) as unknown as (args: {
    suiteId: string;
    input: HostConfigInputV2;
  }) => Promise<string>;

  const [value, setValue] = useState<HostConfigInputV2 | null>(null);
  const [baseline, setBaseline] = useState<HostConfigInputV2 | null>(null);
  const [hasJsonError, setHasJsonError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // Track the scalar fields the legacy fallback reads so the editor
  // re-seeds when the parent clears `suite.defaultConfig` via
  // `onClear` without replacing the suite (suite._id is stable, but
  // `defaultConfig` flips from object to undefined). Without these
  // deps, the editor keeps showing the cleared values until the user
  // navigates away and back.
  const legacyModelId = suite.defaultConfig?.modelId;
  const legacySystemPrompt = suite.defaultConfig?.systemPrompt;
  const legacyTemperature = suite.defaultConfig?.temperature;
  // Track the previous suite id so a suite switch ALWAYS resets
  // state — including unsaved edits. Without this, the dirty-check
  // below sees the OLD suite's baseline (stale closure: baseline is
  // intentionally excluded from deps) and decides "user has unsaved
  // edits, preserve them", leaking suite A's edits into suite B.
  const prevSuiteIdRef = useRef<typeof suite._id | null>(null);
  useEffect(() => {
    if (dto === undefined) return; // still loading
    const isSuiteSwitch = prevSuiteIdRef.current !== suite._id;
    prevSuiteIdRef.current = suite._id;
    const next = dto
      ? hostConfigDtoToInput(dto)
      : emptyHostConfigInputV2({
          // Seed empty editor with suite.defaultConfig.{modelId,systemPrompt,
          // temperature} when the v2 row hasn't been written yet — so a
          // first-time save through ClientConfigEditor doesn't blow away
          // a legacy-only suite config.
          modelId: legacyModelId,
          systemPrompt: legacySystemPrompt,
          temperature: legacyTemperature,
        });
    setBaseline(next);
    setValue((current) => {
      // Suite switch: hard reset — never preserve previous suite's
      // edits. The dirty check below would compare suite A's edits
      // against suite A's stale baseline (closure capture) and
      // wrongly preserve them under suite B.
      if (isSuiteSwitch) return next;
      if (current && baseline && !hostConfigInputsEqual(current, baseline)) {
        return current; // preserve unsaved edits within the same suite
      }
      return next;
    });
    // baseline is intentionally excluded — including it would re-run
    // every save (we setBaseline above), causing an instant value
    // overwrite on save success. The dep set covers every external
    // input the seed depends on, and the prevSuiteIdRef guards the
    // cross-suite stale-closure case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto, suite._id, legacyModelId, legacySystemPrompt, legacyTemperature]);

  const isDirty = useMemo(
    () =>
      value && baseline ? !hostConfigInputsEqual(value, baseline) : !!value,
    [value, baseline]
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

  const canSave = isDirty && !hasJsonError && !isSaving && !isResetting;

  const handleReset = () => {
    if (baseline) setValue(baseline);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await setSuiteConfig({ suiteId: suite._id, input: value });
      setBaseline(value);
      setValue(value);
      toast.success("Suite execution config updated");
    } catch (err) {
      // Surface the failure to the user; do NOT rethrow. The button's
      // onClick wraps this in `() => void handleSave()`, so a thrown
      // error becomes an unhandled promise rejection with no UI
      // feedback. Mirrors the parent-provided onSave handler the
      // pre-Phase-3 component used.
      toast.error(
        getBillingErrorMessage(err, "Failed to update suite execution config")
      );
      console.error("Failed to update suite execution config:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetToProjectDefault = async () => {
    if (!projectDefaultDto) return;
    setIsResetting(true);
    try {
      // Phase 4: copy the project default execution fields into the
      // suite-owned hostConfigId via setSuiteConfig while preserving the
      // suite's frozen server snapshot. The mutation mints a new v2 row
      // when the project-default content differs from the suite's
      // existing row, or no-ops via dedupe when they already match.
      const projectDefaultInput: HostConfigInputV2 = {
        ...hostConfigDtoToInput(projectDefaultDto),
        serverIds: value.serverIds,
        optionalServerIds: value.optionalServerIds,
        serverConnectionOverrides: value.serverConnectionOverrides,
      };
      await setSuiteConfig({
        suiteId: suite._id,
        input: projectDefaultInput,
      });
      setBaseline(projectDefaultInput);
      setValue(projectDefaultInput);
      toast.success("Suite reset to project default");
    } catch (err) {
      toast.error(
        getBillingErrorMessage(err, "Failed to reset suite to project default")
      );
      console.error("Failed to reset suite to project default:", err);
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Default Execution Config
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The model and parameters all iterations in this suite inherit.
          Per-case{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            advancedConfig
          </code>{" "}
          overrides take precedence. Server selection lives in the suite
          environment, not here.
        </p>
      </div>

      <div className="rounded-xl border bg-card/60 p-4">
        <ClientConfigEditor
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
          {projectDefaultDto ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleResetToProjectDefault()}
              disabled={isResetting || isSaving}
            >
              {isResetting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
              )}
              Reset to project default
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={!isDirty || isSaving || isResetting}
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
