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
import {
  adhocSkillSelection,
  chooseTemplate,
  environmentComposition,
  lacksServerSource,
  sharedServerGroup,
  unpreservableReason,
  type EnvironmentComposition,
} from "../evaluate/environment-template";
import { ServerPicker } from "@/components/hosts/server-picker";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import type { EvalSuite } from "./types";

type Selections = Record<string, ModelSelection>;
type Stack = Parameters<
  ReturnType<typeof useEnsureAdhocEnvironments>
>[0]["stacks"][number];

export type SuiteClientsPlanItem = { environmentId?: string; stack?: Stack };

/**
 * The environments a suite should point at after a "Where it runs" edit.
 *
 * Untouched environments are reused by id, so their pins and credential grants
 * survive exactly. A combination with no environment yet is DERIVED from a
 * template — the one setup its candidates share (the edited client's own
 * environments, or every environment for a brand-new client) — and gets
 * `group` as its server group. Never the suite's legacy `serverAttachmentId`:
 * an environment suite does not read it, and most older suites keep their
 * servers somewhere else, which is how an added client used to end up with no
 * servers at all.
 *
 * `group` is the server group every planned environment must run on (the
 * picker's value, or a new pick), or `null` to keep each environment's own
 * group ("Mixed"). A pick that differs from an environment's group derives a
 * replacement for it that keeps every other field.
 *
 * Refuses (throws) rather than guess or drop anything:
 *  - candidates that disagree on their setup (which one would a new cell copy?);
 *  - a template the browser cannot copy losslessly (plugin pins, captured
 *    server skills, secret grants — see `unpreservableReason`);
 *  - any resulting environment with no server group and no plugin pin, which
 *    would run with no servers.
 */
export function planSuiteClients(
  suite: EvalSuite,
  environments: readonly ProjectEnvironmentView[],
  selections: Selections,
  options: {
    group?: string | null;
    /** New client → the client it replaced, whose setup it takes over. */
    sourceHosts?: Record<string, string>;
  } = {},
): SuiteClientsPlanItem[] {
  const group = options.group ?? null;
  const sourceHosts = options.sourceHosts ?? {};
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

  const plan: SuiteClientsPlanItem[] = [];
  const seen = new Set<string>();
  const push = (item: SuiteClientsPlanItem) => {
    // Identical complete compositions collapse; distinct ones never do.
    const key = item.environmentId
      ? `id:${item.environmentId}`
      : `stack:${JSON.stringify(item.stack)}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.push(item);
  };

  for (const [hostId, selection] of Object.entries(selections)) {
    const sourceHost = sourceHosts[hostId] ?? hostId;
    const onSource = attached.filter((row) => row.hostId === sourceHost);
    const models = [
      ...(selection.includeClientDefaults ? [undefined] : []),
      ...new Set(selection.explicitModelIds),
    ];
    for (const modelId of models) {
      const matches = attached.filter(
        (row) => row.hostId === hostId && row.modelId === modelId,
      );
      if (matches.length) {
        for (const row of matches) {
          if (group === null || row.serverAttachmentId === group) {
            push({ environmentId: row.environmentId });
          } else {
            push({ stack: deriveStack(row, { hostId, modelId, group }) });
          }
        }
        continue;
      }
      const choice = chooseTemplate(onSource.length ? onSource : attached, {
        ignoreServerGroup: group !== null,
      });
      if (choice.kind === "ambiguous") {
        throw new Error(
          onSource.length
            ? "This client's setups differ (server group, skills, secrets or image), so there is no single one to copy. Add this model on the Environments page instead."
            : "This suite's clients don't share one setup, so there is no single one for a new client to copy. Pick one server group for the suite first, or add the client on the Environments page.",
        );
      }
      push({
        stack: deriveStack(
          choice.kind === "template" ? choice.composition : {},
          { hostId, modelId, group },
        ),
      });
    }
  }

  const serverless = plan.filter((item) =>
    item.environmentId
      ? lacksServerSource(
          attached.find((row) => row.environmentId === item.environmentId)!,
        )
      : lacksServerSource(item.stack!),
  ).length;
  if (serverless > 0) {
    throw new Error(
      serverless === plan.length
        ? "Pick a server group for this suite first — without one its runs connect no servers."
        : `${serverless} of these clients have no server group, so their runs would connect no servers. Pick a server group for the suite first.`,
    );
  }
  return plan;
}

/**
 * A new environment from a template, with `group` as its server group. Throws
 * when the browser cannot copy the template without dropping part of it.
 */
function deriveStack(
  template: EnvironmentComposition,
  cell: { hostId: string; modelId: string | undefined; group: string | null },
): Stack {
  const composition = environmentComposition(template);
  const reason = unpreservableReason(composition);
  if (reason) {
    throw new Error(
      `This client's setup ${reason}, which this editor can't copy without dropping it. Change it on the Environments page instead.`,
    );
  }
  const serverAttachmentId = cell.group ?? composition.serverAttachmentId;
  if (!serverAttachmentId) {
    throw new Error(
      "Pick a server group for this suite first — without one its runs connect no servers.",
    );
  }
  const skillSelection = adhocSkillSelection(composition);
  return {
    hostId: cell.hostId,
    ...(cell.modelId !== undefined ? { modelId: cell.modelId } : {}),
    serverAttachmentId,
    ...(skillSelection ? { skillSelection } : {}),
    ...(composition.computerEnvironmentId
      ? { computerEnvironmentId: composition.computerEnvironmentId }
      : {}),
  };
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

  const attached = (suite.environmentIds ?? []).flatMap((id) => {
    const row = environments?.find(
      (environment) =>
        environment.environmentId === id && !environment.archivedAt,
    );
    return row ? [row] : [];
  });
  /**
   * The group every environment shares — the picker's value — or why there is
   * none. Never the suite's legacy `serverAttachmentId`: an environment suite
   * does not read it.
   */
  const shared = sharedServerGroup(attached);
  const currentGroup =
    shared.kind === "group" ? shared.serverAttachmentId : null;

  const commit = async (
    next: Selections,
    options: {
      group?: string | null;
      sourceHosts?: Record<string, string>;
    } = {},
  ) => {
    if (inFlight.current || readOnly || loading || unresolved || !capable)
      return;
    inFlight.current = true;
    const previous = draft;
    try {
      const plan = planSuiteClients(suite, environments ?? [], next, {
        // An edit that is not a group pick keeps the shared group (or, for a
        // mixed suite, each environment's own).
        group: options.group !== undefined ? options.group : currentGroup,
        sourceHosts: options.sourceHosts,
      });
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
      // Two derived cells can land on one existing row; the suite's list is
      // duplicate-free.
      await setSuiteEnvironments({
        suiteId: suite._id,
        environmentIds: [...new Set(ids as string[])],
      });
    } catch (error) {
      setDraft(previous);
      toast.error(convexErrMessage(error, "Failed to update clients"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const disabled =
    readOnly || saving || loading || Boolean(unresolved) || !capable;

  return (
    <div className="w-full space-y-3" aria-busy={loading || saving}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Servers
        </span>
        <div className="min-w-[12rem] max-w-xs flex-1">
          <ServerPicker
            projectId={projectId}
            value={currentGroup}
            // Same picker as the create page's servers slot. Picking a group
            // moves EVERY client to it (each keeps its other settings); there
            // is no "none" to pick, because an eval environment without a
            // group runs with no servers.
            onChange={(serverAttachmentId) => {
              if (serverAttachmentId === currentGroup) return;
              void commit(selections, { group: serverAttachmentId });
            }}
            offerClear={false}
            variant="field"
            emptyTriggerLabel={
              shared.kind === "mixed" ? "Mixed groups" : "Pick a server group"
            }
            triggerTestId="suite-clients-server-group"
            disabled={disabled}
          />
        </div>
      </div>
      <EvalTargetMatrix
        hideHeading
        hostIds={Object.keys(selections)}
        hosts={hosts}
        modelSelection={undefined}
        modelSelectionsByHost={selections}
        availableModels={availableModels}
        maxTargets={MAX_SUITE_ENVIRONMENTS}
        projectId={projectId}
        disabled={disabled}
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
            {
              sourceHosts: Object.fromEntries(
                ids.flatMap((id, index) =>
                  !selections[id] && ids.length === previousIds.length
                    ? [[id, previousIds[index]]]
                    : [],
                ),
              ),
            },
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
      ) : shared.kind === "none" || shared.kind === "empty" ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="suite-clients-no-group-hint"
        >
          {shared.kind === "none"
            ? "No server group picked, so runs connect no servers. Pick one to give every client its servers."
            : "Pick a server group before adding clients or models."}
        </p>
      ) : shared.kind === "mixed" ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="suite-clients-mixed-group-hint"
        >
          These clients use different server groups. Picking one here moves
          every client to it.
        </p>
      ) : null}
    </div>
  );
}
