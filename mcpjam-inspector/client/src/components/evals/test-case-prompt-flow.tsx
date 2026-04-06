import { type ChangeEvent, useCallback } from "react";
import { AnimatePresence, motion, LayoutGroup } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitBranchPlus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PromptTurn } from "@/shared/prompt-turns";
import { cn } from "@/lib/utils";
import { ExpectedToolsEditor } from "./expected-tools-editor";

type AvailableTool = {
  name: string;
  description?: string;
  inputSchema?: any;
  serverId?: string;
};

function formatPromptPreview(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "Empty prompt";
  }
  return trimmed.length > 88 ? `${trimmed.slice(0, 88)}…` : trimmed;
}

type TestCasePromptFlowProps = {
  promptTurns: PromptTurn[];
  expandedPromptTurnIds: string[];
  availableTools: AvailableTool[];
  evalValidationBorderClass: string;
  isStepPromptEmpty: (turn: PromptTurn | undefined) => boolean;
  stepExpectedToolsNeedAttention: (turn: PromptTurn | undefined) => boolean;
  updatePromptTurn: (
    index: number,
    updater: (turn: PromptTurn) => PromptTurn,
  ) => void;
  addPromptTurn: () => void;
  removePromptTurn: (index: number) => void;
  movePromptTurn: (index: number, direction: -1 | 1) => void;
  togglePromptTurnExpanded: (turnId: string) => void;
};

export function TestCasePromptFlow({
  promptTurns,
  expandedPromptTurnIds,
  availableTools,
  evalValidationBorderClass,
  isStepPromptEmpty,
  stepExpectedToolsNeedAttention,
  updatePromptTurn,
  addPromptTurn,
  removePromptTurn,
  movePromptTurn,
  togglePromptTurnExpanded,
}: TestCasePromptFlowProps) {
  const multi = promptTurns.length > 1;

  const scrollStepIntoView = useCallback((turnId: string) => {
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-prompt-step="${turnId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {multi ? "Prompt sequence" : "Test scenario"}
          </h3>
          {multi ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 border-dashed"
              onClick={() => {
                addPromptTurn();
              }}
            >
              <GitBranchPlus className="h-3.5 w-3.5" />
              Add turn
            </Button>
          ) : null}
        </div>
      </header>

      <LayoutGroup id="prompt-flow-steps">
        <div
          className={cn(
            "relative",
            multi && "pl-[1.35rem] sm:pl-7",
          )}
        >
          {multi ? (
            <div
              className="pointer-events-none absolute bottom-2 left-[0.4rem] top-6 w-px bg-border/60 sm:left-[0.82rem]"
              aria-hidden
            />
          ) : null}

          <ul className={cn("space-y-4", !multi && "space-y-0")}>
            <AnimatePresence initial={false} mode="popLayout">
              {promptTurns.map((turn, index) => {
                const isExpanded =
                  !multi || expandedPromptTurnIds.includes(turn.id);
                const promptEmpty = isStepPromptEmpty(turn);
                const toolsAttention = stepExpectedToolsNeedAttention(turn);
                const stepNeedsAttention = promptEmpty || toolsAttention;

                return (
                  <motion.li
                    key={turn.id}
                    data-prompt-step={turn.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6, height: 0 }}
                    transition={{ type: "spring", stiffness: 380, damping: 28 }}
                    className={cn("relative list-none", multi && "pl-0")}
                  >
                    {multi ? (
                      <div
                        className={cn(
                          "absolute -left-[1.05rem] top-5 z-[1] flex h-6 w-6 items-center justify-center rounded-full border-2 bg-background text-[11px] font-semibold tabular-nums shadow-sm sm:-left-[1.62rem] sm:h-7 sm:w-7 sm:text-xs",
                          stepNeedsAttention && !isExpanded
                            ? "border-destructive/50 text-destructive"
                            : "border-primary/25 text-primary",
                        )}
                      >
                        {index + 1}
                      </div>
                    ) : null}

                    <div
                      className={cn(
                        "overflow-hidden rounded-xl border bg-card/50 shadow-sm ring-1 ring-black/[0.03] dark:ring-white/[0.06]",
                        stepNeedsAttention && !isExpanded && multi
                          ? "border-destructive/35"
                          : "border-border/50",
                      )}
                    >
                      {multi ? (
                        <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-2">
                          <button
                            type="button"
                            className={cn(
                              "min-w-0 flex-1 truncate text-left text-xs",
                              promptEmpty
                                ? "text-destructive"
                                : "text-muted-foreground",
                            )}
                            onClick={() => {
                              togglePromptTurnExpanded(turn.id);
                              if (!expandedPromptTurnIds.includes(turn.id)) {
                                scrollStepIntoView(turn.id);
                              }
                            }}
                          >
                            <span className="sr-only">
                              Toggle step {index + 1}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground/80">
                              Turn {index + 1}
                            </span>
                            <span className="mx-1.5 text-border">·</span>
                            <span className="font-normal">
                              {formatPromptPreview(turn.prompt)}
                            </span>
                          </button>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground"
                              disabled={index === 0}
                              aria-label={`Move step ${index + 1} up`}
                              onClick={() => movePromptTurn(index, -1)}
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground"
                              disabled={index === promptTurns.length - 1}
                              aria-label={`Move step ${index + 1} down`}
                              onClick={() => movePromptTurn(index, 1)}
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              disabled={promptTurns.length <= 1}
                              aria-label={`Remove step ${index + 1}`}
                              onClick={() => removePromptTurn(index)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              aria-label={
                                isExpanded
                                  ? `Collapse step ${index + 1}`
                                  : `Expand step ${index + 1}`
                              }
                              onClick={() => {
                                togglePromptTurnExpanded(turn.id);
                                if (!isExpanded) {
                                  scrollStepIntoView(turn.id);
                                }
                              }}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      <AnimatePresence initial={false}>
                        {(isExpanded || !multi) && (
                          <motion.div
                            key={`body-${turn.id}`}
                            initial={multi ? { height: 0, opacity: 0 } : false}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={
                              multi
                                ? { height: 0, opacity: 0 }
                                : { opacity: 0 }
                            }
                            transition={{
                              duration: multi ? 0.22 : 0,
                              ease: [0.25, 0.46, 0.45, 0.94],
                            }}
                            className={cn(multi && "overflow-hidden")}
                          >
                            <div
                              className={cn(
                                "space-y-5 p-4",
                                !multi && "pt-4",
                                multi && "border-border/30 bg-background/30",
                              )}
                            >
                              <section className="space-y-2">
                                <Label className="text-xs font-medium text-foreground">
                                  User prompt
                                </Label>
                                <Textarea
                                  value={turn.prompt}
                                  onChange={(
                                    event: ChangeEvent<HTMLTextAreaElement>,
                                  ) =>
                                    updatePromptTurn(index, (currentTurn) => ({
                                      ...currentTurn,
                                      prompt: event.target.value,
                                    }))
                                  }
                                  rows={multi ? 4 : 5}
                                  placeholder={
                                    multi
                                      ? `Prompt for turn ${index + 1}…`
                                      : "Enter the user prompt…"
                                  }
                                  aria-invalid={promptEmpty}
                                  aria-describedby={
                                    promptEmpty
                                      ? `prompt-turn-${index}-hint`
                                      : undefined
                                  }
                                  className={cn(
                                    "resize-none font-mono text-sm leading-relaxed",
                                    multi
                                      ? "min-h-[96px] bg-background"
                                      : "bg-muted/30",
                                    promptEmpty && evalValidationBorderClass,
                                  )}
                                />
                                {promptEmpty ? (
                                  <p
                                    id={`prompt-turn-${index}-hint`}
                                    className="text-xs text-muted-foreground"
                                  >
                                    Required before run or save.
                                  </p>
                                ) : null}
                              </section>

                              <section className="space-y-2">
                                <Label className="text-xs font-medium text-foreground">
                                  Tool triggered
                                </Label>
                                <ExpectedToolsEditor
                                  toolCalls={turn.expectedToolCalls}
                                  onChange={(toolCalls) =>
                                    updatePromptTurn(index, (currentTurn) => ({
                                      ...currentTurn,
                                      expectedToolCalls: toolCalls,
                                    }))
                                  }
                                  availableTools={availableTools}
                                />
                                {toolsAttention ? (
                                  <p className="text-xs text-muted-foreground">
                                    Finish tool names and parameters, or remove
                                    incomplete rows.
                                  </p>
                                ) : null}
                              </section>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </div>
      </LayoutGroup>

      {!multi ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={addPromptTurn}
        >
          <GitBranchPlus className="h-3.5 w-3.5" />
          Add another turn
        </Button>
      ) : null}
    </div>
  );
}
