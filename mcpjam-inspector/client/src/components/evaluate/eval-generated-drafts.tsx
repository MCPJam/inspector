import { useAvailableModels } from "@/hooks/use-available-models";
import { RunIterationControl } from "./run-iteration-control";
import { EvalModelChoices } from "./eval-target-matrix";
import type { GeneratedDraft } from "@/lib/mcpjam-agent/eval-workspace";
import { resolveAuthoringIssue } from "@/lib/mcpjam-agent/eval-workspace";
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
import { Badge } from "@mcpjam/design-system/badge";
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
  importedDraftBlockedBadge,
  followAuthoringJob,
  controlAuthoringJob,
} from "@/lib/mcpjam-agent/eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import { describeMCPJamLimitMessage } from "@/lib/mcpjam-limit";

/**
 * Convex rejects a mutation with `OptimisticConcurrencyControlFailure` when two
 * writers touch the same document at once — here, two draft saves landing on
 * the same suite. The raw message is a JSON blob whose readable text sits one
 * level down, so match the whole string rather than a parsed field.
 */
export function isWriteConflictMessage(message: string): boolean {
  return /OptimisticConcurrencyControlFailure/i.test(message);
}

/** Named the retry, because retrying is the entire fix. */
const WRITE_CONFLICT_MESSAGE =
  "Another change to this suite landed first. Try adding it again.";

/**
 * The one place a stored draft/generation error becomes user-facing copy. The
 * store keeps the wire message verbatim on purpose, so the shaping happens at
 * render: a model limit gets the catalog sentence, a write conflict gets the
 * retry line, and anything else is shown as-is.
 */
/**
 * A validation failure inside the authoring model's reply is not addressed to
 * the reader. It arrives as a serialized issue array — `[{"code":
 * "invalid_type","expected":"string","path":["drafts",0,"additions",0,"id"]…}]`
 * — which names a field of a contract they cannot see and cannot act on. The
 * job retries these itself, so the only honest thing to say is what is
 * happening.
 */
function isModelContractError(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    const issues = Array.isArray(parsed) ? parsed : [parsed];
    return issues.some(
      (issue) =>
        issue && typeof issue === "object" && "code" in issue && "path" in issue,
    );
  } catch {
    return false;
  }
}

export function describeEvalDraftError(message: string): string {
  if (isModelContractError(message))
    return "The model's reply did not match the case contract. Retrying.";
  return (
    describeMCPJamLimitMessage(message) ??
    (isWriteConflictMessage(message) ? WRITE_CONFLICT_MESSAGE : message)
  );
}

/**
 * Save drafts ONE AT A TIME. Every `saveGeneratedDraft` ends in a mutation that
 * reads and writes the same `testSuite` document, so firing them together loses
 * the optimistic-concurrency check and all but one fail. Serializing removes
 * the collision at its source — no retry needed.
 *
 * Keeps going after a failure: `saveGeneratedDraft` swallows its own error onto
 * the draft, so the failures stay in the list and the successes drop out, the
 * same as before.
 */
async function saveDraftsSequentially(
  scope: EvalAgentScope,
  drafts: ReadonlyArray<{ id: string }>,
): Promise<void> {
  for (const draft of drafts) {
    await saveGeneratedDraft(scope, draft.id);
  }
}

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
  useEffect(() => {
    if (state?.authoringJobId)
      void followAuthoringJob({ projectId, suiteId }, state.authoringJobId);
  }, [projectId, suiteId, state?.authoringJobId]);
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
  // A running or failed authoring job owns the status line and its
  // cancel/retry control before it has produced a single draft. A bare
  // `error` does NOT: generation writes its failures to the same per-suite
  // store, and the generation workspace already renders them — opening this
  // panel for one put the identical message on screen twice and revived an
  // empty draft section after a failed generation.
  const authoringVisible = !saveVisibleOnly && Boolean(state?.authoringJobId);
  if (!state || (!state.drafts.length && !authoringVisible))
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
  if (!visibleDrafts.length && !authoringVisible) return null;
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
          {state.authoringJobId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void controlAuthoringJob(scope, running ? "cancel" : "retry")
              }
            >
              {running ? "Cancel drafting" : "Retry failed cases"}
            </Button>
          )}
          {state.drafts.length > 0 && (
            <Button
              size="sm"
              disabled={saving || running || revealing || !readyTargets.length}
              onClick={() => void saveDraftsSequentially(scope, readyTargets)}
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
          {/* Reaching here means there ARE drafts or an authoring job — the
              early return above handles the bare-error case, which belongs to
              the generation workspace. */}
          {!saveVisibleOnly && state.error && (
            <p role="alert" className="text-sm text-destructive">
              {describeEvalDraftError(state.error)}
            </p>
          )}
          {visibleDrafts.map((draft) => {
            // An imported draft opens in the step editor. The collapsed card
            // shows a prompt and a paragraph about the case; what a reader has
            // to agree to is the CASE — its tool calls, its assertions — and
            // making them click into each one hid exactly that. Generated
            // drafts keep the summary list: there are twenty of them.
            const expanded =
              reviewing === draft.id ||
              (reviewing === null && Boolean(draft.authoring?.source));
            const blockedReason = importedDraftBlockedReason(draft);
            const blockedBadge = importedDraftBlockedBadge(draft);
            const locked = draft.saving || Boolean(draft.authoringPrepared);
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
                  <h4 className="min-w-0 break-words text-sm font-semibold">
                    {draft.input.title || "Untitled draft"}
                  </h4>
                  {blockedBadge && (
                    <Badge variant="destructive" title={blockedReason}>
                      {blockedBadge}
                    </Badge>
                  )}
                  <span className="flex-1" />
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
                    {draft.authoring && (
                      <AuthoringDraftSettings
                        scope={scope}
                        draft={draft}
                        disabled={locked}
                      />
                    )}
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
                      availableTools={state?.availableTools ?? []}
                      suiteServers={state?.suiteServers ?? []}
                      evalValidationBorderClass="border-border"
                      readOnly={locked}
                      onStepsChange={(steps) =>
                        editGeneratedDraft(scope, draft.id, draft.revision, {
                          steps,
                        })
                      }
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Input prompt
                    </p>
                    <p className="line-clamp-2 text-[13px] leading-relaxed">
                      {prompt?.kind === "prompt" && prompt.prompt.trim()
                        ? prompt.prompt
                        : "Open this draft to review its steps and assertions."}
                    </p>
                  </div>
                )}
                {draft.authoring && (
                  <div className="space-y-3 text-sm">
                    {draft.authoring.source && (
                      <details>
                        <summary>
                          Source: {draft.authoring.source.fileName}, lines{" "}
                          {draft.authoring.source.startLine}–
                          {draft.authoring.source.endLine}
                        </summary>
                        <pre className="whitespace-pre-wrap rounded bg-muted p-3">
                          {draft.authoring.source.excerpt}
                        </pre>
                      </details>
                    )}
                    {draft.authoring.issues.map((issue, index) => (
                      <div key={index}>
                        <p
                          className={
                            issue.blocking && !issue.resolution
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          {issue.stepId ? `${issue.stepId}: ` : ""}
                          {issue.message}
                        </p>
                        {issue.blocking && (
                          <textarea
                            aria-label={`Resolution for ${issue.message}`}
                            placeholder="Explain the evidence or edits that resolve this issue (at least 10 characters)."
                            className="w-full rounded-md border bg-background p-2"
                            value={
                              draft.issueResolutions?.[index] ??
                              issue.resolution ??
                              ""
                            }
                            disabled={locked}
                            onChange={(event) =>
                              resolveAuthoringIssue(
                                scope,
                                draft.id,
                                index,
                                event.target.value,
                              )
                            }
                          />
                        )}
                      </div>
                    ))}
                    {draft.authoring.additions.length > 0 && (
                      // The additions are in the steps above, so this says what
                      // was added and why. Removing one is a step edit, and
                      // saving the case is the agreement.
                      <div className="space-y-1">
                        <p className="font-medium text-foreground">
                          {draft.authoring.additions.length === 1
                            ? "Added by MCPJam, beyond the source document:"
                            : `Added by MCPJam, beyond the source document (${draft.authoring.additions.length}):`}
                        </p>
                        <ul className="list-disc space-y-1 pl-5">
                          {draft.authoring.additions.map((addition) => (
                            <li key={addition.id}>
                              <span className="font-mono text-[11px]">
                                {addition.path}
                              </span>
                              : {addition.explanation}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
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
                      : draft.authoringPrepared
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
                            )} and suggest a focused improvement to its steps and assertions. Do not save it or generate more cases.`,
                          );
                      }}
                    >
                      Refine with chat
                    </Button>
                  )}
                </footer>
                {draft.error && (
                  <p role="alert" className="mt-3 text-xs text-destructive">
                    {describeEvalDraftError(draft.error)}
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

function AuthoringDraftSettings({
  scope,
  draft,
  disabled,
}: {
  scope: EvalAgentScope;
  draft: GeneratedDraft;
  disabled: boolean;
}) {
  const { availableModels } = useAvailableModels({
    projectId: scope.projectId,
  });
  return (
    <div className="space-y-4">
      <RunIterationControl
        value={String(draft.input.runs ?? 5)}
        disabled={disabled}
        onChange={(value) =>
          editGeneratedDraft(scope, draft.id, draft.revision, {
            runs: Number(value),
          })
        }
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={disabled}
          checked={draft.input.isNegativeTest ?? false}
          onChange={(event) =>
            editGeneratedDraft(scope, draft.id, draft.revision, {
              isNegativeTest: event.target.checked,
            })
          }
        />
        Negative test
      </label>
      <p className="text-sm text-muted-foreground">
        No model override uses the suite models.
      </p>
      <EvalModelChoices
        testId="authoring-models"
        disabled={disabled}
        availableModels={availableModels}
        value={{
          includeClientDefaults: false,
          // A draft persisted by an older build, or staged from a case that
          // inherits the suite's models, carries no list of its own.
          explicitModelIds: (draft.input.models ?? []).map(
            (model) => model.model,
          ),
        }}
        onChange={(value) =>
          editGeneratedDraft(scope, draft.id, draft.revision, {
            models: value.explicitModelIds.flatMap((id) => {
              const model = availableModels.find(
                (model) => String(model.id) === id,
              );
              return model
                ? [{ model: id, provider: String(model.provider) }]
                : (draft.input.models ?? []).filter(
                    (model) => model.model === id,
                  );
            }),
          })
        }
      />
    </div>
  );
}
