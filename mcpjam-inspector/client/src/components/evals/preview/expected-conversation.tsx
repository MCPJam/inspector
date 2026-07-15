/**
 * ExpectedConversation — the editor's right-pane "Preview" in edit mode.
 *
 * Renders the test case being authored as a forming conversation: the user
 * prompt as a bubble, each expected tool call as a lightweight assistant row,
 * per-turn checks as assertion chips, and a render-check (pinned tool call) as
 * a placeholder card. It reads `editForm.promptTurns` and updates live as the
 * left pane is edited. No model runs here — this is the spec made concrete.
 */
import { ListChecks } from "lucide-react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { Label } from "@mcpjam/design-system/label";
import type { PromptTurn } from "@/shared/steps";
import type { ScriptedStep, ScriptedWidgetCheck } from "@/shared/scripted-steps";
import { UserMessageBubble } from "@/components/chat-v2/thread/user-message-bubble";
import { cn } from "@/lib/utils";
import { ExpectedToolCallRow } from "./expected-tool-call-row";
import { RenderPreviewPanel } from "../render-preview-panel";
import { StepList } from "../scripted-steps-editor";

/** Concise, chip-sized summary of a per-turn check. */
export function describeCheck(p: Predicate): string {
  switch (p.type) {
    case "toolCalledWith":
      return `calls ${p.toolName || "?"}(…)`;
    case "toolCalledAtLeastOnce":
      return `calls ${p.toolName || "?"}`;
    case "toolNeverCalled":
      return `never ${p.toolName || "?"}`;
    case "firstToolWas":
      return `first: ${p.toolName || "?"}`;
    case "responseContains":
      return `contains "${p.needle || "…"}"`;
    case "responseMatches":
      return `matches /${p.pattern || "…"}/`;
    case "noToolErrors":
      return "no tool errors";
    case "finalAssistantMessageNonEmpty":
      return "replies";
    case "tokenBudgetUnder":
      return `< ${p.tokens} tok`;
    case "widgetRendered":
      return "widget renders";
    case "widgetRenderLatencyUnder":
      return `renders < ${p.ms}ms`;
    case "widgetNoConsoleErrors":
      return "no console errors";
    default:
      return (p as { type: string }).type;
  }
}

/**
 * The widget tools a turn references, in display order: the pinned tool (if it
 * renders a widget), then expected tool calls that render widgets, then any tool
 * an existing widget-check group already targets (so authored checks always show
 * even before tool metadata loads). De-duplicated.
 */
function referencedWidgetTools(
  turn: PromptTurn,
  widgetToolNames: string[],
): string[] {
  const isWidget = (name: string) => widgetToolNames.includes(name);
  const out: string[] = [];
  const add = (name: string) => {
    if (name && !out.includes(name)) out.push(name);
  };
  if (turn.pinnedToolCall && isWidget(turn.pinnedToolCall.toolName)) {
    add(turn.pinnedToolCall.toolName);
  }
  for (const c of turn.expectedToolCalls) if (isWidget(c.toolName)) add(c.toolName);
  for (const g of turn.widgetChecks ?? []) add(g.toolName);
  return out;
}

/** Upsert/remove one tool's group within a turn's widgetChecks. */
function setWidgetGroupSteps(
  turn: PromptTurn,
  toolName: string,
  steps: ScriptedStep[],
): PromptTurn {
  const groups = turn.widgetChecks ?? [];
  const rest = groups.filter((g) => g.toolName !== toolName);
  const next: ScriptedWidgetCheck[] =
    steps.length > 0 ? [...rest, { toolName, steps }] : rest;
  if (next.length === 0) {
    const { widgetChecks: _omit, ...without } = turn;
    return without;
  }
  return { ...turn, widgetChecks: next };
}

export function ExpectedConversation({
  promptTurns,
  emptyHint = "Start typing a prompt — the conversation will build here.",
  onUpdateTurn,
  widgetToolNames = [],
  widgetChecksEnabled = false,
  onRunWidget,
  isRunning = false,
}: {
  promptTurns: PromptTurn[];
  emptyHint?: string;
  /** When provided with `widgetChecksEnabled`, the preview becomes the authoring
   *  surface for per-widget interaction checks (next to the live widget). */
  onUpdateTurn?: (index: number, updater: (turn: PromptTurn) => PromptTurn) => void;
  /** Tools that render a widget (detected from `_meta`). A slot is auto-derived
   *  for each widget tool a turn references — no manual tool picker. */
  widgetToolNames?: string[];
  widgetChecksEnabled?: boolean;
  /** Run the case and stream the live trace into the preview. When provided,
   *  widget-tool rows become "click to render the widget" entry points. */
  onRunWidget?: () => void;
  isRunning?: boolean;
}) {
  const widgetToolSet = new Set(widgetToolNames ?? []);
  const editChecks = widgetChecksEnabled && !!onUpdateTurn;
  const hasContent = promptTurns.some(
    (t) =>
      t.prompt.trim() ||
      t.expectedToolCalls.length ||
      t.pinnedToolCall ||
      (t.checks?.length ?? 0) > 0 ||
      (t.widgetChecks?.length ?? 0) > 0,
  );

  if (!hasContent) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="space-y-5 px-5 py-6">
      {promptTurns.map((turn, index) => {
        const checks = turn.checks ?? [];
        const hasAssistant =
          turn.expectedToolCalls.length > 0 || !!turn.pinnedToolCall || checks.length > 0;
        return (
          <div key={turn.id} className="space-y-3">
            {turn.prompt.trim() ? (
              <UserMessageBubble>
                <p className="whitespace-pre-wrap">{turn.prompt}</p>
              </UserMessageBubble>
            ) : null}

            {hasAssistant ? (
              <div className="flex justify-start">
                <div className="w-[92%] space-y-2">
                  {turn.expectedToolCalls.length ? (
                    <>
                      <div className="text-[11px] text-muted-foreground">
                        Assistant calls
                      </div>
                      {turn.expectedToolCalls.map((c, i) => (
                        <ExpectedToolCallRow
                          key={`${turn.id}-tc-${i}`}
                          toolName={c.toolName}
                          arguments={c.arguments}
                          isWidget={widgetToolSet.has(c.toolName)}
                          onRun={onRunWidget}
                          isRunning={isRunning}
                        />
                      ))}
                    </>
                  ) : null}

                  {turn.pinnedToolCall ? (
                    <RenderPreviewPanel
                      pinned={turn.pinnedToolCall}
                      // Tier 2: record clicks/typing into the pinned tool's group.
                      onRecordStep={
                        editChecks
                          ? (step) => {
                              const toolName = turn.pinnedToolCall!.toolName;
                              onUpdateTurn!(index, (current) => {
                                const existing =
                                  current.widgetChecks?.find(
                                    (g) => g.toolName === toolName,
                                  )?.steps ?? [];
                                return setWidgetGroupSteps(current, toolName, [
                                  ...existing,
                                  step,
                                ]);
                              });
                            }
                          : undefined
                      }
                    />
                  ) : null}

                  {checks.length ? (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                      {checks.map((c, i) => (
                        <span
                          key={`${turn.id}-ck-${i}`}
                          className={cn(
                            "inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground",
                          )}
                        >
                          {describeCheck(c)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Tier 1.5: interaction-check slots for widgets the turn renders.
                Progressive disclosure — in the static spec we only surface slots
                that ALREADY have recorded steps (or a pinned widget that renders
                without a run). The empty "add your first step" entry point lives
                on the live widget after Run, not as an empty card up front. */}
            {editChecks
              ? (() => {
                  const slots = referencedWidgetTools(turn, widgetToolNames)
                    .map((toolName) => ({
                      toolName,
                      steps:
                        turn.widgetChecks?.find((g) => g.toolName === toolName)
                          ?.steps ?? [],
                      isPinned: turn.pinnedToolCall?.toolName === toolName,
                    }))
                    // Hide empty model-driven slots pre-run; keep recorded steps
                    // and pinned widgets (which render deterministically).
                    .filter(({ steps, isPinned }) => steps.length > 0 || isPinned);
                  if (slots.length === 0) return null;
                  return (
                    <div className="flex justify-start">
                      <div className="w-[92%] space-y-2">
                        <Label className="text-xs font-medium text-foreground">
                          Widget interaction checks
                        </Label>
                        {slots.map(({ toolName, steps, isPinned }) => (
                          <div
                            key={toolName}
                            className="space-y-2 rounded-md border border-border/60 bg-muted/10 p-2.5"
                            data-testid="widget-check-slot"
                          >
                            <div className="text-[11px] text-muted-foreground">
                              Widget from{" "}
                              <span className="font-mono text-foreground">
                                {toolName}
                              </span>
                              {isPinned ? "" : " · captured from a run"}
                            </div>
                            <StepList
                              value={steps}
                              onChange={(nextSteps) =>
                                onUpdateTurn!(index, (current) =>
                                  setWidgetGroupSteps(
                                    current,
                                    toolName,
                                    nextSteps,
                                  ),
                                )
                              }
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()
              : null}
          </div>
        );
      })}
    </div>
  );
}
