import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { useHostList } from "@/hooks/useClients";
import {
  EvalServerPreviewPage,
  type EvalServerPreviewCaseTarget,
} from "./eval-server-preview-page";
import { EvalServerCaseEditPage } from "./eval-server-case-edit-page";
import {
  readEvalServerPreviewDraft,
  writeEvalServerPreviewDraft,
  type EvalServerPreviewDraft,
} from "./eval-server-preview-state";
import {
  SuiteCaseGenerationWorkspace,
  type RefinementMessage,
} from "./suite-case-generation-workspace";
import type { FirstRunClient, PreviewSuite } from "./eval-server-preview-model";

type Preparation = {
  status: "queued" | "running" | "ready" | "failed" | "empty";
  suites: PreviewSuite[];
  generatedHash?: string;
  dueAt: number;
  error?: string;
};
export type PreparedRunInput = {
  suites: PreviewSuite[];
  clients: FirstRunClient[];
  iterationsPerCase: number;
  reviewKey: string;
};

export function PreparedEvalServerPage({
  projectId,
  server,
  editTarget,
  onBack,
  onOpenCase,
  onRun,
  onReconnect,
  onExit,
}: {
  projectId: string;
  server: { id: string; name: string };
  editTarget?: { suiteId: string; caseId: string };
  onBack: () => void;
  onExit?: () => void;
  onOpenCase: (target: EvalServerPreviewCaseTarget) => void;
  onRun: (input: PreparedRunInput) => Promise<void>;
  onReconnect?: () => Promise<void>;
}) {
  const args = { projectId, serverId: server.id };
  const preparation = useQuery("evalPreparations:get" as any, args) as
    | Preparation
    | null
    | undefined;
  const review = useQuery("evalPreparations:getReview" as any, args) as
    | { revision: number; draft: EvalServerPreviewDraft }
    | null
    | undefined;
  const ensure = useMutation("evalPreparations:ensure" as any);
  const refineReview = useAction("evalPreparationRefinement:refine" as any);
  const saveReview = useMutation("evalPreparations:saveReview" as any);
  const { hosts, isLoading: loadingHosts } = useHostList({
    isAuthenticated: true,
    projectId,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [chatOverride, setChatOverride] = useState<RefinementMessage[] | null>(
    null,
  );
  const [initial, setInitial] = useState<EvalServerPreviewDraft | null>(null);
  const revision = useRef<number | null>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const conflict = useRef(false);
  const availableClients = hosts.map((host) => ({
    id: host.hostId,
    name: host.name,
  }));

  useEffect(() => {
    void ensure({ projectId, serverId: server.id }).catch(() =>
      setError("Could not start preparation. Try again."),
    );
  }, [ensure, projectId, server.id]);

  useEffect(() => {
    if (
      review === undefined ||
      preparation === undefined ||
      loadingHosts ||
      initial
    )
      return;
    if (!review && !preparation?.suites.length) return;
    const draft = review?.draft ?? {
      version: 1 as const,
      serverId: server.id,
      generationHash: preparation!.generatedHash,
      suites: preparation!.suites,
      openSuiteIds: [],
      step: "suites" as const,
      clients: availableClients.slice(0, 2),
      iterationsPerCase: 1,
    };
    revision.current = review?.revision ?? 0;
    writeEvalServerPreviewDraft(server.id, draft);
    setInitial(draft);
  }, [review, preparation, loadingHosts, initial, server.id, availableClients]);

  const persist = (draft: EvalServerPreviewDraft) => {
    writeEvalServerPreviewDraft(server.id, draft);
    setInitial(draft);
    pending.current = pending.current
      .then(async () => {
        if (conflict.current)
          throw new Error("Reload this review before editing.");
        revision.current = await saveReview({
          ...args,
          draft,
          expectedRevision: revision.current ?? 0,
        });
      })
      .catch((cause) => {
        conflict.current = true;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save your review. Reload before continuing.",
        );
      });
  };
  const afterSave = async (action: () => void) => {
    await pending.current;
    if (!conflict.current) action();
  };

  const caseRows = (initial?.suites ?? []).flatMap((suite) =>
    suite.cases.map((test) => ({
      caseId: test.id,
      title: test.title,
      summary: `${suite.title} · ${test.prompt ?? test.expectedOutput ?? ""}`,
      selected: test.selected,
      requiresSetup: test.requiresSetup,
    })),
  );
  const conversation = chatOverride ??
    initial?.chatHistory ?? [
      {
        id: 0,
        role: "assistant" as const,
        text: initial
          ? `I've prepared ${caseRows.length} test cases for ${server.name}. Tell me what to add, change, or remove, or continue when you're ready to run them.`
          : `I'm preparing test cases for ${server.name}. They'll appear here, and we can refine them together.`,
      },
    ];
  const handleRefine = async (instruction?: string) => {
    if (!initial || !instruction?.trim() || refining) return;
    setRefining(true);
    setError(null);
    const nextId =
      Math.max(0, ...conversation.map((message) => message.id)) + 1;
    const pendingConversation: RefinementMessage[] = [
      ...conversation,
      { id: nextId, role: "user", text: instruction },
    ];
    setChatOverride(pendingConversation);
    try {
      // Save any edits before the action freezes the revision it will refine.
      persist(readEvalServerPreviewDraft(server.id) ?? initial);
      await pending.current;
      if (conflict.current)
        throw new Error("Reload this review before refining.");
      const result = await refineReview({
        ...args,
        expectedRevision: revision.current ?? 0,
        requestId: crypto.randomUUID(),
        instruction,
      });
      revision.current = result.revision;
      writeEvalServerPreviewDraft(server.id, result.draft);
      setInitial(result.draft);
      setChatOverride(null);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "";
      const changedElsewhere =
        /another tab|changed while|Nothing was overwritten/.test(detail);
      if (changedElsewhere) conflict.current = true;
      const message = changedElsewhere
        ? "Your cases changed while I was working. Nothing was overwritten. Reload this review before continuing."
        : /budget/.test(detail)
        ? "This refinement is unavailable under the current generation budget. Your cases are unchanged."
        : /already running/.test(detail)
        ? "A refinement is already running for this review. Wait for it to finish, then reopen the review."
        : "I couldn't apply that refinement. Your cases are unchanged. Please try again.";
      setChatOverride([
        ...pendingConversation,
        { id: nextId + 1, role: "assistant", text: message },
      ]);
      throw cause;
    } finally {
      setRefining(false);
    }
  };

  if (editTarget && initial)
    return (
      <>
        <p role="alert" className="px-6 text-sm text-destructive">
          {error}
        </p>
        <EvalServerCaseEditPage
          // Keyed by the case: the editor seeds its fields from `initial`
          // once, so moving between cases without a remount would keep the
          // previous case's text and write it under the new id.
          key={`${editTarget.suiteId}:${editTarget.caseId}`}
          server={server}
          {...editTarget}
          fallbackDraft={initial}
          onDraftChange={persist}
          onBack={() => void afterSave(onBack)}
        />
      </>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div
        className="mx-auto w-full max-w-3xl px-6 pt-6 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {error && <p className="text-destructive">{error}</p>}
        {preparation === undefined || review === undefined
          ? "Loading prepared cases…"
          : preparation === null
          ? "Reconnect this server once to prepare test cases."
          : preparation.status === "failed"
          ? preparation.error
          : preparation.status === "empty"
          ? "No callable tools were found in the saved snapshot. Reconnect after adding tools, or create a suite manually."
          : preparation.status === "queued" && preparation.dueAt > Date.now()
          ? "Updated suggestions are queued for the next daily refresh. Your saved cases remain available."
          : preparation.status === "queued" || preparation.status === "running"
          ? "Preparing test cases. You can leave this page; they will be saved here."
          : null}
        {preparation === null && onReconnect && (
          <Button
            variant="secondary"
            className="mt-3"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onReconnect()
                .catch(() =>
                  setError(
                    "Could not reconnect. Check the server connection and try again.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            Reconnect to prepare cases
          </Button>
        )}
        {(error || preparation?.status === "failed") && (
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => {
              setError(null);
              void ensure(args).catch(() =>
                setError("Could not start preparation."),
              );
            }}
          >
            Check preparation
          </Button>
        )}
        {initial &&
          preparation?.generatedHash &&
          initial.generationHash !== preparation.generatedHash && (
            <div className="mt-3">
              <p>
                Updated suggestions are ready. Your edited cases are preserved.
              </p>
              <Button
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  const current =
                    readEvalServerPreviewDraft(server.id) ?? initial;
                  const prompts = new Set(
                    current.suites.flatMap((suite) =>
                      suite.cases.map((test) =>
                        (test.prompt ?? test.title).trim().toLowerCase(),
                      ),
                    ),
                  );
                  const additions = preparation.suites
                    .map((suite) => ({
                      ...suite,
                      cases: suite.cases.filter(
                        (test) =>
                          !prompts.has(
                            (test.prompt ?? test.title).trim().toLowerCase(),
                          ),
                      ),
                    }))
                    .filter((suite) => suite.cases.length);
                  const next = {
                    ...current,
                    generationHash: preparation.generatedHash,
                    suites: [...current.suites, ...additions],
                  };
                  writeEvalServerPreviewDraft(server.id, next);
                  persist(next);
                  setInitial(next);
                }}
              >
                Add new suggestions to this review
              </Button>
            </div>
          )}
        {busy && <p>Saving suites and starting evaluations…</p>}
      </div>
      {(!initial || initial.step === "suites") && (
        <div className="flex min-h-0 flex-1 p-4">
          <SuiteCaseGenerationWorkspace
            suiteName={server.name}
            caseRows={caseRows}
            conversation={conversation}
            title="Generate test cases"
            backLabel="Evaluate"
            doneLabel="Continue"
            doneDisabled={
              !initial ||
              caseRows.every((row) => row.selected === false) ||
              conflict.current
            }
            isGenerating={
              refining ||
              (!initial &&
                (preparation === undefined ||
                  review === undefined ||
                  preparation?.status === "queued" ||
                  preparation?.status === "running"))
            }
            generationStatus="Preparing cases from saved server capabilities…"
            refinementDisabledReason={
              !initial
                ? "Waiting for the server's prepared cases"
                : conflict.current
                ? "Reload to resolve conflicting edits"
                : undefined
            }
            onGenerate={handleRefine}
            onBack={() => void afterSave(onExit ?? onBack)}
            onClose={() => {
              if (initial) persist({ ...initial, step: "confirm" });
            }}
            onCaseClick={(caseId) => {
              if (!initial) return;
              const suite = initial.suites.find((suite) =>
                suite.cases.some((test) => test.id === caseId),
              );
              const test = suite?.cases.find((test) => test.id === caseId);
              if (suite && test) {
                persist(initial);
                void afterSave(() =>
                  onOpenCase({ suiteId: suite.id, caseId, title: test.title }),
                );
              }
            }}
            onToggleCase={(caseId) => {
              if (initial)
                persist({
                  ...initial,
                  suites: initial.suites.map((suite) => ({
                    ...suite,
                    cases: suite.cases.map((test) =>
                      test.id === caseId
                        ? { ...test, selected: test.selected === false }
                        : test,
                    ),
                  })),
                });
            }}
            onRemoveCase={(caseId) => {
              if (initial)
                persist({
                  ...initial,
                  suites: initial.suites.map((suite) => ({
                    ...suite,
                    cases: suite.cases.filter((test) => test.id !== caseId),
                  })),
                });
            }}
          />
        </div>
      )}
      {initial?.step === "confirm" && (
        <fieldset
          disabled={busy || refining || conflict.current}
          className="contents"
        >
          <EvalServerPreviewPage
            key={`${server.id}:${initial.generationHash ?? "saved"}`}
            server={server}
            initialDraft={initial}
            availableClients={availableClients}
            preview={{
              serverId: server.id,
              serverName: server.name,
              suites: initial.suites,
              findings: [],
            }}
            onDraftChange={persist}
            onOpenCase={(target) => void afterSave(() => onOpenCase(target))}
            onRunFirstEvals={(input) => {
              if (busy) return;
              setBusy(true);
              void (async () => {
                await pending.current;
                if (conflict.current) return;
                if (!input.clients.length)
                  throw new Error("Select a configured client before running.");
                if (
                  input.clients.some(
                    (client) =>
                      !availableClients.some(
                        (available) => available.id === client.id,
                      ),
                  )
                )
                  throw new Error(
                    "A selected client is no longer available. Remove it and select another.",
                  );
                await onRun({
                  ...input,
                  reviewKey: `${projectId}:${server.id}:${
                    revision.current ?? 0
                  }`,
                });
              })()
                .catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not start evaluations.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          />
        </fieldset>
      )}
    </div>
  );
}
