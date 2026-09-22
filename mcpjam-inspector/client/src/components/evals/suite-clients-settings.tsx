import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useHostList } from "@/hooks/useClients";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  useEnsureAdhocEnvironments,
  useProjectEnvironments,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { MAX_SUITE_ENVIRONMENTS } from "@/components/project-environments/environment-picker";
import type { ModelSelection } from "@/components/environment-composer/environment-stack";
import { EvalTargetMatrix } from "../evaluate/eval-target-matrix";
import { seedRunMatrix } from "../evaluate/suite-run-matrix";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import type { EvalSuite } from "./types";

type Selections = Record<string, ModelSelection>;
type Stack = Parameters<
  ReturnType<typeof useEnsureAdhocEnvironments>
>[0]["stacks"][number];

/** Keep untouched environments intact, including their pins and credential grants. */
export function planSuiteClients(
  suite: EvalSuite,
  environments: readonly ProjectEnvironmentView[],
  selections: Selections,
  sourceHosts: Record<string, string> = {},
): { environmentId?: string; stack?: Stack }[] {
  const attached = (suite.environmentIds ?? []).map((id) => {
    const row = environments.find(
      (environment) =>
        environment.environmentId === id && !environment.archivedAt,
    );
    if (!row)
      throw new Error(
        "An attached client is unavailable. Reload the suite and try again.",
      );
    return row;
  });
  return Object.entries(selections).flatMap(([hostId, selection]) => {
    const existing = attached.filter(
      (row) => row.hostId === (sourceHosts[hostId] ?? hostId),
    );
    const models = [
      ...(selection.includeClientDefaults ? [undefined] : []),
      ...new Set(selection.explicitModelIds),
    ];
    return models.flatMap<{ environmentId?: string; stack?: Stack }>(
      (modelId) => {
        const matches = existing.filter(
          (row) => row.hostId === hostId && row.modelId === modelId,
        );
        if (matches.length)
          return matches.map((row) => ({ environmentId: row.environmentId }));
        const templates = existing.length ? existing : [undefined];
        const stacks = new Map<string, Stack>();
        for (const template of templates) {
          // The batch resolver cannot copy plugin pins. Refuse this particular edit
          // instead of silently removing them; other clients remain editable.
          if (template?.pluginVersionIds?.length) {
            throw new Error(
              "Change this client's pinned plugins in Environments before adding a model.",
            );
          }
          const stack: Stack = {
            hostId,
            modelId,
            serverAttachmentId: template
              ? template.serverAttachmentId
              : suite.serverAttachmentId,
            skillSelection: template?.skillSelection,
            secretSelection: template?.secretSelection,
            computerEnvironmentId: template
              ? (template.computerEnvironmentId ?? undefined)
              : suite.environment?.computerEnvironmentId,
          };
          stacks.set(JSON.stringify(stack), stack);
        }
        return [...stacks.values()].map((stack) => ({ stack }));
      },
    );
  });
}

export function SuiteClientsSettings({
  suite,
  projectId,
  readOnly = false,
}: {
  suite: EvalSuite;
  projectId: string;
  readOnly?: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { availableModels } = useAvailableModels({ projectId });
  const environments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const { capable, pending } = useEvalComposeCapable(projectId);
  const ensure = useEnsureAdhocEnvironments();
  const setSuiteEnvironments = useMutation(
    "testSuites:setSuiteEnvironments" as never,
  ) as unknown as (args: {
    suiteId: string;
    environmentIds: string[];
  }) => Promise<unknown>;
  const [draft, setDraft] = useState<Selections | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const savedKey = JSON.stringify([
    suite._id,
    suite.environmentIds,
    suite.hostAttachments,
  ]);
  useEffect(() => setDraft(null), [savedKey]);
  const selections = draft ?? seedRunMatrix(suite, environments ?? []);
  const unresolved = suite.environmentIds?.some(
    (id) =>
      !environments?.some((row) => row.environmentId === id && !row.archivedAt),
  );
  const loading = isLoading || pending || environments === undefined;

  const commit = async (
    next: Selections,
    sourceHosts: Record<string, string> = {},
  ) => {
    if (inFlight.current || readOnly || loading || unresolved || !capable)
      return;
    inFlight.current = true;
    const previous = draft;
    try {
      const plan = planSuiteClients(
        suite,
        environments ?? [],
        next,
        sourceHosts,
      );
      if (!plan.length) throw new Error("Keep at least one client and model.");
      if (plan.length > MAX_SUITE_ENVIRONMENTS)
        throw new Error(
          `Choose up to ${MAX_SUITE_ENVIRONMENTS} client/model combinations.`,
        );
      setDraft(next);
      setSaving(true);
      const missing = plan.flatMap((item) => (item.stack ? [item.stack] : []));
      const resolved = missing.length
        ? await ensure({ projectId, stacks: missing })
        : [];
      let index = 0;
      const ids = plan.map(
        (item) =>
          item.environmentId ?? resolved[index++]?.environment.environmentId,
      );
      if (ids.some((id) => !id))
        throw new Error(
          "Could not save the selected clients and models. Try again.",
        );
      await setSuiteEnvironments({
        suiteId: suite._id,
        environmentIds: ids as string[],
      });
    } catch (error) {
      setDraft(previous);
      toast.error(convexErrMessage(error, "Failed to update clients"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="w-full space-y-3" aria-busy={loading || saving}>
      <EvalTargetMatrix
        hideHeading
        hostIds={Object.keys(selections)}
        hosts={hosts}
        modelSelection={undefined}
        modelSelectionsByHost={selections}
        availableModels={availableModels}
        maxTargets={MAX_SUITE_ENVIRONMENTS}
        projectId={projectId}
        disabled={
          readOnly || saving || loading || Boolean(unresolved) || !capable
        }
        modelsEditable
        onHostsChange={(ids) => {
          const previousIds = Object.keys(selections);
          void commit(
            Object.fromEntries(
              ids.map((id, index) => [
                id,
                selections[id] ??
                  (ids.length === previousIds.length
                    ? selections[previousIds[index]]
                    : undefined) ?? {
                    includeClientDefaults: true,
                    explicitModelIds: [],
                  },
              ]),
            ),
            Object.fromEntries(
              ids.flatMap((id, index) =>
                !selections[id] && ids.length === previousIds.length
                  ? [[id, previousIds[index]]]
                  : [],
              ),
            ),
          );
        }}
        onModelSelectionChange={(hostId, selection) =>
          void commit({ ...selections, [hostId]: selection })
        }
        onRemoveClient={(hostId) =>
          void commit(
            Object.fromEntries(
              Object.entries(selections).filter(([id]) => id !== hostId),
            ),
          )
        }
      />
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading clients…</p>
      ) : unresolved ? (
        <p className="text-xs text-muted-foreground">
          An attached client is unavailable.
        </p>
      ) : null}
    </div>
  );
}
