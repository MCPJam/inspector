/**
 * First-run case editor. Same SimpleCaseForm as today's test-edit page,
 * backed by the preview draft until generation persists real suites.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { ChevronLeft } from "lucide-react";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import type { CasePredicates, EvalMatchOptions } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import { SimpleCaseForm } from "./simple-case/simple-case-form";
import {
  findPreviewCase,
  hydratePreviewCase,
  updatePreviewCase,
  type PreviewCase,
} from "./eval-server-preview-model";
import {
  readEvalServerPreviewDraft,
  writeEvalServerPreviewDraft,
  type EvalServerPreviewDraft,
} from "./eval-server-preview-state";

interface EvalServerCaseEditPageProps {
  server: { id: string; name: string };
  suiteId: string;
  caseId: string;
  onBack: () => void;
  onDraftChange?: (draft: EvalServerPreviewDraft) => void;
}

export function previewCaseTitleFromDraft(
  serverId: string,
  suiteId: string,
  caseId: string,
): string | null {
  const draft = readEvalServerPreviewDraft(serverId);
  if (!draft) return null;
  return findPreviewCase(draft.suites, suiteId, caseId)?.title ?? null;
}

export function EvalServerCaseEditPage({
  server,
  suiteId,
  caseId,
  onBack,
  onDraftChange,
}: EvalServerCaseEditPageProps) {
  const initial = useMemo(
    () => loadPreviewCase(server.id, suiteId, caseId),
    [server.id, suiteId, caseId],
  );
  const [title, setTitle] = useState(initial?.title ?? "Test case");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [steps, setSteps] = useState<TestStep[]>(initial?.steps ?? []);
  const [matchOptions, setMatchOptions] = useState<
    EvalMatchOptions | undefined
  >(initial?.matchOptions);
  const [expectedOutput, setExpectedOutput] = useState(
    initial?.expectedOutput ?? "",
  );
  const [predicates, setPredicates] = useState<CasePredicates | undefined>(
    initial?.predicates,
  );

  const persist = (patch: Partial<PreviewCase>) => {
    const draft = readEvalServerPreviewDraft(server.id);
    if (!draft) return;
    const next = {
      ...draft,
      suites: updatePreviewCase(draft.suites, suiteId, caseId, patch),
    };
    writeEvalServerPreviewDraft(server.id, next);
    onDraftChange?.(next);
  };

  if (!initial) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-auto"
        data-testid="eval-server-case-edit"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-8 sm:px-8">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80"
          >
            <ChevronLeft className="size-4" aria-hidden />
            Back
          </button>
          <p className="mt-6 text-sm text-muted-foreground">
            This case is no longer in the first-run preview.
          </p>
        </div>
      </div>
    );
  }

  const finishTitleEdit = () => {
    setIsEditingTitle(false);
    const nextTitle = title.trim() || "New case";
    if (nextTitle !== title) setTitle(nextTitle);
    persist({ title: nextTitle });
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setTitle(initial.title);
      setIsEditingTitle(false);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      data-testid="eval-server-case-edit"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-8 sm:px-8">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Back
        </button>

        <div className="mt-6 border-b border-border pb-4">
          {isEditingTitle ? (
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={finishTitleEdit}
              onKeyDown={handleTitleKeyDown}
              autoFocus
              aria-label="Case title"
              className="min-w-0 w-full bg-transparent px-0 py-0 text-lg font-semibold tracking-tight text-foreground focus:outline-none sm:text-xl"
            />
          ) : (
            <button
              type="button"
              className="min-w-0 w-full text-left"
              onClick={() => setIsEditingTitle(true)}
            >
              <h1 className="truncate text-lg font-semibold tracking-tight text-foreground transition-opacity hover:opacity-80 sm:text-xl">
                {title}
              </h1>
            </button>
          )}
          <p className="mt-1 text-sm text-muted-foreground">{server.name}</p>
        </div>

        <div className="mt-6">
          <SimpleCaseForm
            steps={steps}
            onStepsChange={(next) => {
              setSteps(next);
              persist({ steps: next });
            }}
            matchOptions={matchOptions ?? MATCH_OPTIONS_DEFAULTS}
            onMatchOptionsChange={(next) => {
              setMatchOptions(next);
              persist({ matchOptions: next });
            }}
            expectedOutput={expectedOutput}
            onExpectedOutputChange={(next) => {
              setExpectedOutput(next);
              persist({ expectedOutput: next });
            }}
            predicates={predicates}
            onPredicatesChange={(next) => {
              setPredicates(next);
              persist({ predicates: next });
            }}
            onOpenDeepEditor={() => undefined}
            autoFocusPrompt
          />
        </div>
      </div>
    </div>
  );
}

function loadPreviewCase(
  serverId: string,
  suiteId: string,
  caseId: string,
): PreviewCase | null {
  const draft = readEvalServerPreviewDraft(serverId);
  if (!draft) return null;
  const previewCase = findPreviewCase(draft.suites, suiteId, caseId);
  return previewCase ? hydratePreviewCase(previewCase) : null;
}
