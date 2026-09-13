/**
 * Flat, ordered step-list editor (Datadog-Synthetics-style) for an MCP-app eval
 * case. Renders ONE reorderable sequence of `prompt` / `toolCall` / `interact` /
 * `assert` rows with a unified "Add to scenario" command palette. This is the
 * sole case editor.
 *
 * It operates directly on the `TestStep[]` authoring model (`@/shared/steps`),
 * which is also the owning editor's in-memory state and the persisted/wire
 * shape — no per-turn bridge.
 */

import { type ChangeEvent } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { RemoteServer } from "@/hooks/useProjects";
import { AddStepPicker, type AddStepPickerChoice } from "./add-step-picker";
import { cn } from "@/lib/utils";
import { trimmedField } from "@/shared/scripted-steps";
import type { Predicate } from "@/shared/eval-matching";
import {
  isWidgetAssertion,
  newStepId,
  stepTurnIndices,
  type AssertStep,
  type InteractStep,
  type PromptStep,
  type StepAssertionPayload,
  type TestStep,
  type ToolCallStep,
} from "@/shared/steps";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import { ExpectedToolsEditor } from "./expected-tools-editor";
import { CheckRow, blankPredicate } from "./checks-section";
import { PinnedToolCallFields } from "./pinned-tool-call-fields";
import {
  blankStepOfKind,
  defaultWidgetAssertion,
  InteractActionFields,
  invokableTools,
  STEP_META,
  StepStatusBadge,
  summarizeStep,
  WidgetAssertionFields,
  type AvailableTool,
} from "./step-fields";

type StepListEditorProps = {
  steps: TestStep[];
  onStepsChange: (next: TestStep[]) => void;
  availableTools: AvailableTool[];
  /** Effective `argumentMatching` mode (suite default merged with case override). */
  argumentMatching?: "exact" | "partial" | "ignore";
  /** Effective suite server names — for the toolCall step's server picker. */
  suiteServers: string[];
  /** Project servers, to resolve a display name to a stable id when pinning. */
  projectServers?: RemoteServer[];
  evalValidationBorderClass: string;
  /**
   * Render the step cards as a non-editable snapshot: hides reorder/remove and
   * the add-to-scenario affordance, and locks every field. Used by the
   * replay pane to show a run's `testCaseSnapshot` with the same card visuals as
   * the live editor.
   */
  protectPrompts?: boolean;
  readOnly?: boolean;
  /**
   * Live per-turn execution status (keyed by implicit turn index) from a quick
   * run's `step_status` stream events. Cards tick running→ok/fail in lockstep
   * with their turn. v1 is turn granularity: `interact`/`assert` cards reflect
   * their parent turn's status (see {@link stepTurnIndices}).
   */
  stepStatusByTurn?: Map<number, EvalStepStatus>;
  /**
   * Live PER-STEP execution status keyed by `stepId` (PR5): a real per-card
   * verdict (running→ok/fail, plus `skipped` for steps fail-fast never ran).
   * Takes precedence over the turn-derived {@link stepStatusByTurn} when a
   * step's id is present.
   */
  stepStatusById?: Map<string, EvalStepStatus>;
  /** Step currently hovered/selected in the replay pane — highlights the matching
   *  card for left↔right sync. */
  syncedStepId?: string | null;
  /** Fired when a card is hovered, to drive the replay pane's highlight. */
  onHoverStep?: (stepId: string | null) => void;
};




// ── assert step body (Predicate OR WidgetAssertion) ───────────────────────────
function AssertStepBody({
  step,
  onChange,
  availableTools,
  readOnly = false,
}: {
  step: AssertStep;
  onChange: (next: AssertStep) => void;
  availableTools: AvailableTool[];
  readOnly?: boolean;
}) {
  const a = step.assertion;
  const setAssertion = (assertion: StepAssertionPayload) =>
    onChange({ ...step, assertion });

  if (isWidgetAssertion(a)) {
    // The fields thread `readOnly` only far enough to drop the authoring
    // flags; a `display:contents` disabled fieldset locks the whole subtree
    // natively without affecting layout.
    return (
      <fieldset disabled={readOnly} className="contents">
        <WidgetAssertionFields
          value={a}
          onChange={setAssertion}
          availableTools={availableTools}
          readOnly={readOnly}
        />
      </fieldset>
    );
  }
  // A model-level Predicate: reuse the per-kind CheckRow body (it renders the
  // kind label + its fields). We render it without the outer remove button —
  // the step row owns deletion.
  return (
    <CheckRow
      predicate={a}
      onChange={(next: Predicate) => setAssertion(next)}
      availableTools={availableTools.map((t) => t.name)}
      widgetToolNames={invokableTools(availableTools).map((t) => t.name)}
      toolArgSchemas={Object.fromEntries(
        availableTools.map((t) => [t.name, t.inputSchema?.properties ?? {}])
      )}
      readOnly={readOnly}
      embedded
    />
  );
}

// ── one row ───────────────────────────────────────────────────────────────────
function StepRow({
  step,
  index,
  total,
  availableTools,
  suiteServers,
  projectServers,
  evalValidationBorderClass,
  readOnly = false,
  status,
  statusIsPerStep = false,
  isActive = false,
  onHover,
  onUpdate,
  onRemove,
  removable = true,
  onMove,
}: {
  step: TestStep;
  index: number;
  total: number;
  availableTools: AvailableTool[];
  suiteServers: string[];
  projectServers?: RemoteServer[];
  evalValidationBorderClass: string;
  readOnly?: boolean;
  status?: EvalStepStatus;
  /** True when `status` is a real per-step verdict (not turn-derived). */
  statusIsPerStep?: boolean;
  /** Highlighted because the matching replay row is hovered/selected (sync). */
  isActive?: boolean;
  /** Fired on hover to drive left↔right replay sync. */
  onHover?: (stepId: string | null) => void;
  onUpdate: (next: TestStep) => void;
  onRemove: () => void;
  removable?: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  const meta = STEP_META[step.kind];
  const { Icon } = meta;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6, height: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      data-testid="step-row"
      data-step-kind={step.kind}
      onMouseEnter={onHover ? () => onHover(step.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      className={cn(
        "list-none rounded-xl border bg-card/50 shadow-sm ring-1 ring-black/[0.03] transition-colors dark:ring-white/[0.06]",
        isActive ? "border-primary/50 ring-primary/20" : "border-border/50"
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/50 bg-background text-[11px] font-semibold tabular-nums text-muted-foreground">
          {index + 1}
        </div>
        <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.tint)} aria-hidden />
        <span className={cn("text-[11px] font-semibold", meta.tint)}>
          {meta.label}
        </span>
        <span className="mx-1 text-border">·</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {summarizeStep(step)}
        </span>
        {/* Per-step status (`statusIsPerStep`) is a REAL per-card verdict from
            the step engine — show it on every card, including `assert`. The
            legacy turn-derived status is ambiguous on assert cards (a turn
            finishes "ok" even when an assertion in it fails), so there we still
            only show the live "running" pip, never a turn-derived ok/fail. */}
        {status &&
        (statusIsPerStep ||
          !(step.kind === "assert" && status !== "running")) ? (
          <StepStatusBadge status={status} />
        ) : null}
        {readOnly ? null : (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground"
              disabled={index === 0}
              aria-label={`Move step ${index + 1} up`}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground"
              disabled={index === total - 1}
              aria-label={`Move step ${index + 1} down`}
              onClick={() => onMove(1)}
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            {removable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              aria-label={`Remove step ${index + 1}`}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            ) : null}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-4 border-border/30 bg-background/30 p-4">
        {step.kind === "prompt" ? (
          <section className="space-y-2">
            <Label className="text-[11px] font-medium text-foreground">
              User prompt
            </Label>
            <Textarea
              value={step.prompt}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                onUpdate({ ...step, prompt: event.target.value })
              }
              rows={4}
              readOnly={readOnly}
              placeholder="Enter the user prompt…"
              // A frozen snapshot is never "invalid" — only flag emptiness in the
              // live editor.
              aria-invalid={!readOnly && !step.prompt.trim()}
              className={cn(
                "resize-none bg-background font-mono text-sm leading-relaxed",
                !readOnly && !step.prompt.trim() && evalValidationBorderClass
              )}
            />
          </section>
        ) : null}

        {step.kind === "toolCall" ? (
          <ToolCallStepBody
            step={step}
            onChange={onUpdate}
            suiteServers={suiteServers}
            availableTools={availableTools}
            projectServers={projectServers}
            readOnly={readOnly}
          />
        ) : null}

        {step.kind === "interact" ? (
          // `readOnly` only drops the authoring flags inside; a
          // `display:contents` disabled fieldset locks the subtree natively.
          <fieldset disabled={readOnly} className="contents">
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">View (tool)</Label>
                  {invokableTools(availableTools).length > 0 ? (
                    <Select
                      value={step.toolName || undefined}
                      onValueChange={(next) =>
                        onUpdate({ ...step, toolName: next })
                      }
                    >
                      <SelectTrigger
                        aria-invalid={!readOnly && !trimmedField(step.toolName)}
                        className="h-7 text-[11px]"
                      >
                        <SelectValue placeholder="Pick a view tool…" />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from(
                          new Set(
                            invokableTools(availableTools).map((t) => t.name)
                          )
                        ).map((name) => (
                          <SelectItem
                            key={name}
                            value={name}
                            className="text-[11px]"
                          >
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={step.toolName}
                      onChange={(e) =>
                        onUpdate({ ...step, toolName: e.target.value })
                      }
                      placeholder="view tool name…"
                      aria-invalid={!readOnly && !trimmedField(step.toolName)}
                      className="h-7 text-[11px]"
                    />
                  )}
                </div>
              </div>
              <InteractActionFields
                value={step.action}
                onChange={(action) => onUpdate({ ...step, action })}
                readOnly={readOnly}
              />
            </div>
          </fieldset>
        ) : null}

        {step.kind === "assert" ? (
          <AssertStepBody
            step={step}
            onChange={onUpdate}
            availableTools={availableTools}
            readOnly={readOnly}
          />
        ) : null}
      </div>
    </motion.li>
  );
}

// ── toolCall body (server/tool/args, reuses PinnedToolCallFields) ─────────────
function ToolCallStepBody({
  step,
  onChange,
  suiteServers,
  availableTools,
  projectServers,
  readOnly = false,
}: {
  step: ToolCallStep;
  onChange: (next: ToolCallStep) => void;
  suiteServers: string[];
  availableTools: AvailableTool[];
  projectServers?: RemoteServer[];
  readOnly?: boolean;
}) {
  return (
    <section className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Deterministic, model-free tool call. Renders the tool&apos;s view.
      </p>
      <PinnedToolCallFields
        seedKey={step.id}
        value={{
          ...(step.serverId ? { serverId: step.serverId } : {}),
          serverName: step.serverName,
          toolName: step.toolName,
          arguments: step.arguments as Record<string, unknown>,
          ...(step.renderTimeoutMs
            ? { renderTimeoutMs: step.renderTimeoutMs }
            : {}),
        }}
        onChange={(cfg) =>
          onChange({
            ...step,
            ...(cfg.serverId
              ? { serverId: cfg.serverId }
              : { serverId: undefined }),
            serverName: cfg.serverName,
            toolName: cfg.toolName,
            arguments: cfg.arguments as Record<string, unknown>,
            ...(cfg.renderTimeoutMs
              ? { renderTimeoutMs: cfg.renderTimeoutMs }
              : { renderTimeoutMs: undefined }),
          })
        }
        suiteServers={suiteServers}
        availableTools={invokableTools(availableTools)}
        projectServers={projectServers}
        readOnly={readOnly}
      />
    </section>
  );
}


// ── main editor ───────────────────────────────────────────────────────────────
export function StepListEditor({
  steps,
  onStepsChange,
  availableTools,
  argumentMatching,
  suiteServers,
  projectServers,
  evalValidationBorderClass,
  readOnly = false,
  protectPrompts = false,
  stepStatusByTurn,
  stepStatusById,
  syncedStepId,
  onHoverStep,
}: StepListEditorProps) {
  // Map each card to its implicit turn so per-turn `step_status` ticks the right
  // cards (turn granularity). Cheap; steps lists are tiny.
  const turnIndices = stepStatusByTurn ? stepTurnIndices(steps) : null;
  const updateAt = (index: number, next: TestStep) =>
    onStepsChange(steps.map((s, i) => (i === index ? next : s)));
  const removeAt = (index: number) => {
    if (protectPrompts && steps[index]?.kind === "prompt") return;
    onStepsChange(steps.filter((_, i) => i !== index));
  };
  const moveAt = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    const copy = [...steps];
    [copy[index], copy[target]] = [copy[target]!, copy[index]!];
    onStepsChange(copy);
  };
  const append = (step: TestStep) => onStepsChange([...steps, step]);
  const addAssertion = (assertion: StepAssertionPayload) =>
    append({ id: newStepId("assert"), kind: "assert", assertion });
  // Seed a new "tool was called with…" predicate with the case's effective
  // argument-matching mode so the per-leaf picker offers the right options
  // (mirrors how the per-turn ExpectedToolsEditor is threaded `argumentMatching`).
  const blankToolCalledWith = (): Predicate => {
    const base = blankPredicate("toolCalledWith") as Extract<
      Predicate,
      { type: "toolCalledWith" }
    >;
    return argumentMatching
      ? { ...base, args: { ...base.args, argumentMatching } }
      : base;
  };

  const handleAddChoice = (choice: AddStepPickerChoice) => {
    switch (choice.kind) {
      case "step":
        append(blankStepOfKind(choice.stepKind, suiteServers));
        break;
      case "check":
        if (choice.predicateKind === "toolCalledWith") {
          addAssertion(blankToolCalledWith());
        } else {
          addAssertion(blankPredicate(choice.predicateKind));
        }
        break;
      case "widget-check":
        addAssertion(defaultWidgetAssertion(choice.widgetKind, ""));
        break;
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            Steps
          </h3>
          <p className="text-[11px] text-muted-foreground">
            An ordered sequence of prompts, tool calls, interactions, and
            assertions.
          </p>
        </div>
      </header>

      <LayoutGroup id="step-list">
        <ul className="space-y-3">
          <AnimatePresence initial={false} mode="popLayout">
            {steps.map((step, index) => {
              return (
              <StepRow
                key={step.id}
                step={step}
                index={index}
                total={steps.length}
                availableTools={availableTools}
                suiteServers={suiteServers}
                projectServers={projectServers}
                evalValidationBorderClass={evalValidationBorderClass}
                readOnly={readOnly}
                isActive={syncedStepId === step.id}
                onHover={onHoverStep}
                // Per-step verdict (by stepId) wins over the turn-derived status.
                status={
                  stepStatusById?.get(step.id) ??
                  (turnIndices
                    ? stepStatusByTurn?.get(turnIndices[index]!)
                    : undefined)
                }
                statusIsPerStep={stepStatusById?.get(step.id) !== undefined}
                onUpdate={(next) => updateAt(index, next)}
                removable={!protectPrompts || step.kind !== "prompt"}
                onRemove={() => removeAt(index)}
                onMove={(dir) => moveAt(index, dir)}
              />
              );
            })}
          </AnimatePresence>
        </ul>
      </LayoutGroup>

      {steps.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground/70">
          {readOnly
            ? "This run's snapshot has no recorded steps."
            : "No steps yet. Click Add to begin."}
        </p>
      ) : null}

      {readOnly ? null : (
        <AddStepPicker
          onSelect={handleAddChoice}
          // Once the case has interaction steps, surface secondary checks by default.
          defaultMoreExpanded={steps.some((s) => s.kind === "interact")}
        />
      )}
    </div>
  );
}

// Re-export so callers can build expected-tool-call asserts inline if needed.
export { ExpectedToolsEditor };
export type { PromptStep, ToolCallStep, InteractStep, AssertStep };
