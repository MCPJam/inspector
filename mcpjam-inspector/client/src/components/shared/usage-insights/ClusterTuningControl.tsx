import { useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw, SlidersHorizontal } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { Slider } from "@mcpjam/design-system/slider";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import {
  CLUSTER_TUNING_KNOB_COPY,
  CLUSTER_TUNING_PRESETS,
  CLUSTER_TUNING_PRESET_COPY,
  CLUSTER_TUNING_PRESET_ORDER,
  CLUSTER_TUNING_RANGES,
  formatKnobValue,
  pickKnobs,
  presetFor,
  resolveClusterTuning,
  type ClusterTuning,
  type ClusterTuningKnob,
  type ClusterTuningPreset,
  type ResolvedClusterTuning,
} from "@/lib/cluster-tuning";

interface ClusterTuningControlProps {
  /** What the last run used. Seeds the draft; absence means the defaults. */
  value: ClusterTuning | null | undefined;
  /** Apply the draft. `force` additionally re-analyzes every session. */
  onApply: (tuning: ClusterTuning, opts?: { force?: boolean }) => void;
  busy?: boolean;
  /**
   * The topic-map knob. False for scopes that build no map (swarm), where the
   * value would be recorded but never read — so it is not offered at all
   * rather than offered and ignored.
   */
  showLinkThreshold?: boolean;
  /** Session count for the re-analyze confirmation. Absent hides the cost. */
  sessionCount?: number;
  /**
   * Verb on the apply button. Defaults to the rebuild wording.
   *
   * The create flow saves a project default and starts nothing, so calling
   * that button "Rebuild" would promise a run that is not going to happen.
   */
  applyLabel?: string;
  /**
   * The re-analyze-from-scratch escape hatch. False where there is nothing to
   * re-analyze yet — offering to re-summarize zero sessions is not a choice.
   */
  showForce?: boolean;
}

/**
 * The clustering knobs, for two audiences at once.
 *
 * The preset row is the whole control for most people: three words, one click,
 * rebuild. Advanced exists because the same page is read by whoever has to
 * explain why a map looks the way it does, and "Detailed" is not an answer —
 * the raw silhouette floor is. Both write the same three numbers.
 *
 * The draft is local and only leaves on Apply. A slider that re-clustered on
 * every drag would queue a rebuild per pixel.
 */
export function ClusterTuningControl({
  value,
  onApply,
  busy = false,
  showLinkThreshold = true,
  sessionCount,
  applyLabel,
  showForce = true,
}: ClusterTuningControlProps) {
  const knobs = useMemo<ClusterTuningKnob[]>(
    () =>
      showLinkThreshold
        ? ["maxClusters", "minSeparation", "linkThreshold"]
        : ["maxClusters", "minSeparation"],
    [showLinkThreshold],
  );

  const applied = useMemo(() => resolveClusterTuning(value), [value]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ResolvedClusterTuning>(applied);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmingForce, setConfirmingForce] = useState(false);

  // Re-seed whenever the popover opens, not on every `applied` change: a run
  // completing while the popover is open would otherwise wipe an edit
  // mid-drag. Closing and reopening is the user's own signal to start over.
  useEffect(() => {
    if (!open) {
      setConfirmingForce(false);
      return;
    }
    setDraft(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on open only
  }, [open]);

  const appliedPreset = presetFor(applied, knobs);
  const draftPreset = presetFor(draft, knobs);
  const dirty = knobs.some((knob) => draft[knob] !== applied[knob]);

  const triggerLabel = appliedPreset
    ? CLUSTER_TUNING_PRESET_COPY[appliedPreset].label
    : "Custom";

  const apply = (opts?: { force?: boolean }) => {
    onApply(pickKnobs(draft, knobs), opts);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="cluster-tuning-trigger"
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted/50"
        >
          <SlidersHorizontal className="h-3 w-3" />
          {triggerLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium">Clustering</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Changes apply on the next rebuild.
            </p>
          </div>

          <ToggleGroup
            type="single"
            value={draftPreset ?? ""}
            onValueChange={(next) => {
              if (!next) return;
              setDraft({
                ...draft,
                ...pickKnobs(
                  CLUSTER_TUNING_PRESETS[next as ClusterTuningPreset],
                  knobs,
                ),
              });
            }}
            className="w-full"
          >
            {CLUSTER_TUNING_PRESET_ORDER.map((preset) => (
              <ToggleGroupItem
                key={preset}
                value={preset}
                data-testid={`cluster-tuning-preset-${preset}`}
                className="flex-1 text-[11px]"
              >
                {CLUSTER_TUNING_PRESET_COPY[preset].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <p
            className="text-[11px] text-muted-foreground"
            data-testid="cluster-tuning-preset-description"
          >
            {draftPreset
              ? CLUSTER_TUNING_PRESET_COPY[draftPreset].description
              : "Custom settings — pick a preset to return to a named starting point."}
          </p>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                data-testid="cluster-tuning-advanced-toggle"
                className="flex w-full items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${advancedOpen ? "" : "-rotate-90"}`}
                />
                Advanced
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              {knobs.map((knob) => {
                const range = CLUSTER_TUNING_RANGES[knob];
                return (
                  <div key={knob} className="space-y-1">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[11px] font-medium">
                        {CLUSTER_TUNING_KNOB_COPY[knob].label}
                      </span>
                      <span
                        className="font-mono text-[11px] text-muted-foreground"
                        data-testid={`cluster-tuning-value-${knob}`}
                      >
                        {formatKnobValue(knob, draft[knob])}
                      </span>
                    </div>
                    <Slider
                      value={[draft[knob]]}
                      min={range.min}
                      max={range.max}
                      step={range.step}
                      aria-label={CLUSTER_TUNING_KNOB_COPY[knob].label}
                      onValueChange={([next]) =>
                        setDraft((prev) => ({ ...prev, [knob]: next }))
                      }
                    />
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      {CLUSTER_TUNING_KNOB_COPY[knob].hint}
                    </p>
                  </div>
                );
              })}
            </CollapsibleContent>
          </Collapsible>

          <button
            type="button"
            data-testid="cluster-tuning-apply"
            disabled={busy}
            onClick={() => apply()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] font-medium hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
            {applyLabel ?? (dirty ? "Apply and rebuild" : "Rebuild")}
          </button>

          {showForce ? (
          <div className="border-t border-border pt-2">
            {confirmingForce ? (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Re-reads and re-summarizes every session with a model. Only
                  needed when the summaries themselves look wrong — tuning
                  changes above do not require it.
                  {sessionCount !== undefined
                    ? ` ${sessionCount.toLocaleString()} session${sessionCount === 1 ? "" : "s"} will be re-analyzed.`
                    : ""}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="cluster-tuning-force-confirm"
                    disabled={busy}
                    onClick={() => apply({ force: true })}
                    className="flex-1 rounded-md border border-destructive/40 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                  >
                    Re-analyze
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingForce(false)}
                    className="flex-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted/50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                data-testid="cluster-tuning-force"
                onClick={() => setConfirmingForce(true)}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                Re-analyze sessions from scratch…
              </button>
            )}
          </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
