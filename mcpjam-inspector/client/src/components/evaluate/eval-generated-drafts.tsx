import { useState } from "react";
import {
  openEvalChat,
  useEvalPromptQueue,
} from "@/lib/mcpjam-agent/eval-scope";
import { cn } from "@/lib/utils";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { StepListEditor } from "../evals/step-list-editor";
import {
  useEvalGeneration,
  evalSuiteKey,
  editGeneratedDraft,
  saveGeneratedDraft,
} from "@/lib/mcpjam-agent/eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";

export function EvalGeneratedDrafts({
  projectId,
  suiteId,
  suiteName,
}: {
  projectId: string;
  suiteId: string;
  suiteName: string;
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
  if (!state || (!state.drafts.length && state.status === "ready")) return null;
  const saving = state.drafts.some((draft) => draft.saving);
  return (
    <section
      className="space-y-4 text-card-foreground"
      aria-label="Generated case drafts"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Unsaved generated drafts</h3>
          <p className="text-xs text-muted-foreground" role="status">
            {state.status === "running"
              ? `Generating… · ${state.drafts.length} unsaved`
              : `${state.drafts.length} ${
                  state.drafts.length === 1 ? "draft" : "drafts"
                } waiting to be added`}
          </p>
        </div>
        {state.drafts.length > 0 && (
          <Button
            size="sm"
            disabled={saving || state.status === "running"}
            onClick={() =>
              void Promise.all(
                state.drafts.map((draft) =>
                  saveGeneratedDraft(scope, draft.id),
                ),
              )
            }
          >
            {saving ? "Adding cases…" : "Add all to suite"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        These drafts aren’t in your suite yet and won’t run. Review them below,
        then add individual cases or add them all to make them available to Run.
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.drafts.map((draft, index) => {
        const expanded =
          reviewing === draft.id || (reviewing === null && index === 0);
        const prompt = draft.input.steps?.find(
          (step) => step.kind === "prompt",
        );
        const checks =
          draft.input.steps?.filter((step) => step.kind === "assert").length ??
          0;
        return (
          <article
            key={draft.id}
            aria-label={`Draft: ${draft.input.title || "Untitled draft"}`}
            className={cn(
              "space-y-4 rounded-xl border bg-card px-5 py-4 transition-colors",
              expanded ? "border-card-foreground/50" : "border-border",
            )}
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Draft
              </span>
              <h4 className="min-w-0 flex-1 break-words text-sm font-semibold">
                {draft.input.title || "Untitled draft"}
              </h4>
              <span className="text-[11px] text-muted-foreground">
                {expanded
                  ? "Every field is editable"
                  : `${draft.input.steps?.length ?? 0} steps · ${checks} checks`}
              </span>
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
                    disabled={draft.saving}
                    onChange={(e) =>
                      editGeneratedDraft(scope, draft.id, draft.revision, {
                        title: e.target.value,
                      })
                    }
                  />
                </label>
                <StepListEditor
                  steps={draft.input.steps ?? []}
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
            <footer className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="rounded-md"
                aria-label={`Add ${draft.input.title || "untitled draft"} to suite`}
                disabled={draft.saving}
                onClick={() => void saveGeneratedDraft(scope, draft.id)}
              >
                {draft.saving ? "Adding…" : "Add to suite"}
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
                      `Read the generated draft titled ${JSON.stringify(draft.input.title)} and suggest a focused improvement to its steps and checks. Do not save it or generate more cases.`,
                    );
                }}
              >
                Refine with chat
              </Button>
            </footer>
            {draft.error && (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {draft.error}
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
