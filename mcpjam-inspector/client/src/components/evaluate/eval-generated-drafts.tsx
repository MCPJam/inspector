import { ImportedDraftEditor } from "./imported-draft-editor";
import { EVAL_DESCRIBE_ONLY_AGENT } from "@/shared/eval-agent-scope";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  openEvalChat,
  useEvalPromptQueue,
} from "@/lib/mcpjam-agent/eval-scope";
import { cn } from "@/lib/utils";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
} from "../evals/eval-surface-chrome";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { CaseSpine } from "./case-spine/case-spine";
import { caseViewModel } from "./case-workspace/case-view-model";
import {
  useEvalGeneration,
  evalSuiteKey,
  editGeneratedDraft,
  saveGeneratedDraft,
  removeGeneratedDraft,
  importedDraftBlockedReason,
} from "@/lib/mcpjam-agent/eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";

export function EvalGeneratedDrafts({
  projectId,
  suiteId,
  suiteName,
  visibleDraftIds,
  hideChat = false,
  saveVisibleOnly = false,
  defaultOpen = true,
}: {
  projectId: string;
  suiteId: string;
  suiteName: string;
  visibleDraftIds?: ReadonlySet<string>;
  hideChat?: boolean;
  saveVisibleOnly?: boolean;
  defaultOpen?: boolean;
}) {
  const scope: EvalAgentScope = {
    kind: "evals",
    version: 1,
    id: "review",
    projectId,
    suiteId,
    suiteName,
  };
  const [reviewing, setReviewing] = useState<string | null>(null);
  const state = useEvalGeneration((s) => s.suites[evalSuiteKey(scope)]);
  const [open, setOpen] = useState(defaultOpen);
  const initialReviewRequest = useRef(state?.reviewRequestId);
  useEffect(() => {
    if (
      state?.reviewRequestId &&
      state.reviewRequestId !== initialReviewRequest.current
    ) {
      initialReviewRequest.current = state.reviewRequestId;
      setOpen(true);
    }
  }, [state?.reviewRequestId]);
  if (!state || !state.drafts.length)
    return saveVisibleOnly ? (
      <p role="status" className="text-sm">
        All tests in this batch are saved.
      </p>
    ) : null;
  const visibleDrafts = visibleDraftIds
    ? state.drafts.filter((draft) => visibleDraftIds.has(draft.id))
    : state.drafts;
  if (!visibleDrafts.length && saveVisibleOnly)
    return (
      <p role="status" className="text-sm">
        All tests in this batch are saved.
      </p>
    );
  if (!visibleDrafts.length && !state.error) return null;
  const revealing =
    !saveVisibleOnly && visibleDrafts.length < state.drafts.length;
  const saveTargets = saveVisibleOnly ? visibleDrafts : state.drafts;
  const readyTargets = saveTargets.filter(
    (draft) => !importedDraftBlockedReason(draft),
  );
  const saving = saveTargets.some((draft) => draft.saving);
  const running = !saveVisibleOnly && state.status === "running";
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section
        className={cn(evalSurfaceCardClass, "group/drafts overflow-hidden")}
        aria-label="Generated case drafts"
      >
        <div
          className={cn(
            evalSurfaceHeaderClass,
            "flex flex-wrap items-center justify-between gap-3 bg-muted/55 px-4 py-3 group-data-[state=closed]/drafts:border-b-0",
          )}
        >
          <h3>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="group h-8 gap-2 px-0 text-sm font-semibold text-foreground"
              >
                <ChevronDown
                  className="size-4 -rotate-90 transition-transform group-data-[state=open]:rotate-0"
                  aria-hidden
                />
                Review Draft Cases
              </Button>
            </CollapsibleTrigger>
          </h3>
          {state.drafts.length > 0 && (
            <Button
              size="sm"
              disabled={saving || running || revealing || !readyTargets.length}
              onClick={() =>
                void Promise.all(
                  readyTargets.map((draft) =>
                    saveGeneratedDraft(scope, draft.id),
                  ),
                )
              }
            >
              {saving
                ? "Adding cases…"
                : saveVisibleOnly
                  ? "Save all"
                  : readyTargets.length < saveTargets.length
                    ? "Add ready cases"
                    : "Add all to suite"}
            </Button>
          )}
        </div>
        <CollapsibleContent className="space-y-4 p-4">
          <p className="text-xs text-muted-foreground">
            These drafts aren’t in your suite yet and won’t run. Review them
            below, then add individual cases or add them all to make them
            available to Run.
          </p>
          {!saveVisibleOnly && state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          {visibleDrafts.map((draft) => {
            const expanded = reviewing === draft.id;
            const blockedReason = importedDraftBlockedReason(draft);
            const locked =
              draft.saving || Boolean(draft.markdownImport?.prepared);
            const prompt = draft.input.steps?.find(
              (step) => step.kind === "prompt",
            );
            return (
              <article
                key={draft.id}
                aria-label={`Draft: ${draft.input.title || "Untitled draft"}`}
                className={cn(
                  "space-y-4 rounded-xl border bg-card px-5 py-4 transition-colors",
                  expanded ? "border-card-foreground/50" : "border-border",
                )}
              >
                <header className="flex items-start gap-3">
                  <h4 className="min-w-0 flex-1 break-words text-sm font-semibold">
                    {draft.input.title || "Untitled draft"}
                  </h4>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${
                      draft.input.title || "untitled draft"
                    }`}
                    title="Remove draft"
                    disabled={locked}
                    onClick={() => {
                      removeGeneratedDraft(scope, draft.id);
                      if (reviewing === draft.id) setReviewing(null);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </header>
                {expanded ? (
                  <div id={`review-${draft.id}`} className="space-y-4">
                    <label className="block space-y-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Case title
                      </span>
                      <Input
                        aria-label="Generated case title"
                        value={draft.input.title}
                        disabled={locked}
                        onChange={(e) =>
                          editGeneratedDraft(scope, draft.id, draft.revision, {
                            title: e.target.value,
                          })
                        }
                      />
                    </label>
                    {draft.markdownImport ? (
                      <ImportedDraftEditor scope={scope} draft={draft} />
                    ) : (
                      <CaseSpine
                        steps={caseViewModel("draft", draft.input).steps}
                        matchOptions={draft.input.matchOptions}
                        onMatchOptionsChange={(matchOptions) =>
                          editGeneratedDraft(scope, draft.id, draft.revision, {
                            matchOptions,
                          })
                        }
                        expectedOutput={draft.input.expectedOutput}
                        onExpectedOutputChange={(expectedOutput) =>
                          editGeneratedDraft(scope, draft.id, draft.revision, {
                            expectedOutput,
                          })
                        }
                        predicates={draft.input.predicates}
                        onPredicatesChange={(predicates) =>
                          editGeneratedDraft(scope, draft.id, draft.revision, {
                            predicates,
                          })
                        }
                        availableTools={[]}
                        suiteServers={[]}
                        evalValidationBorderClass="border-border"
                        readOnly={draft.saving}
                        onStepsChange={(steps) =>
                          editGeneratedDraft(scope, draft.id, draft.revision, {
                            steps,
                          })
                        }
                      />
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Input prompt
                    </p>
                    <p className="line-clamp-2 text-[13px] leading-relaxed">
                      {prompt?.kind === "prompt" && prompt.prompt.trim()
                        ? prompt.prompt
                        : "Open this draft to review its steps and checks."}
                    </p>
                  </div>
                )}
                {blockedReason && (
                  <p className="text-xs text-muted-foreground">
                    {blockedReason}
                  </p>
                )}
                <footer className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="rounded-md"
                    aria-label={`Add ${
                      draft.input.title || "untitled draft"
                    } to suite`}
                    disabled={draft.saving || Boolean(blockedReason)}
                    title={blockedReason}
                    onClick={() => void saveGeneratedDraft(scope, draft.id)}
                  >
                    {draft.saving
                      ? "Adding…"
                      : draft.markdownImport?.prepared
                        ? "Retry save"
                        : "Add to suite"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-md"
                    aria-expanded={expanded}
                    aria-controls={expanded ? `review-${draft.id}` : undefined}
                    onClick={() => setReviewing(expanded ? "" : draft.id)}
                  >
                    {expanded ? "Close editor" : "Review case"}
                  </Button>
                  {!hideChat && !EVAL_DESCRIBE_ONLY_AGENT && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-md text-secondary-foreground"
                      onClick={() => {
                        const sessionId = openEvalChat({
                          projectId,
                          suiteId,
                          suiteName,
                        });
                        useEvalPromptQueue
                          .getState()
                          .enqueue(
                            sessionId,
                            `Read the generated draft titled ${JSON.stringify(
                              draft.input.title,
                            )} and suggest a focused improvement to its steps and checks. Do not save it or generate more cases.`,
                          );
                      }}
                    >
                      Refine with chat
                    </Button>
                  )}
                </footer>
                {draft.error && (
                  <p role="alert" className="mt-3 text-xs text-destructive">
                    {draft.error}
                  </p>
                )}
              </article>
            );
          })}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
