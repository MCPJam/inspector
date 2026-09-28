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
import { useEnvironmentCapabilities } from "@/hooks/use-environment-capabilities";
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
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import type { EvalSuite } from "./types";

type Selections = Record<string, ModelSelection>;
type Stack = Parameters<
  ReturnType<typeof useEnsureAdhocEnvironments>
>[0]["stacks"][number];

/**
 * A backend derivation: a new environment built server-side from the STORED
 * source row, every execution field kept unless overridden (`null` clears).
 */
export type SuiteClientsDerivation = {
  sourceEnvironmentId: string;
  expectedRevision: number;
  overrides: {
    hostId?: string;
    modelId?: string | null;
    serverAttachmentId?: string;
  };
  /** The attached environment this one takes the place of (schedule pin). */
  replaces?: string;
};

export type SuiteClientsPlanItem = {
  environmentId?: string;
  stack?: Stack;
  derive?: SuiteClientsDerivation;
};

/**
 * A new client or model whose candidate setups differ. With backend
 * derivation the person picks which one to copy (`sourceEnvironmentId`);
 * without it the edit is refused.
 */
export class AmbiguousSuiteTemplateError extends Error {
  constructor(
    message: string,
    readonly candidates: readonly ProjectEnvironmentView[],
  ) {
    super(message);
    this.name = "AmbiguousSuiteTemplateError";
  }
}

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
    /**
     * The backend derives new environments from the stored source
     * (`environmentDerivation`), so every pin survives: nothing is refused
     * as uncopyable, and differing setups become a choice instead of a
     * refusal.
     */
    lossless?: boolean;
    /** The setup the person picked to copy when the candidates differ. */
    sourceEnvironmentId?: string;
  } = {},
): SuiteClientsPlanItem[] {
  const group = options.group ?? null;
  const sourceHosts = options.sourceHosts ?? {};
  const lossless = options.lossless === true;
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
      : item.derive
        ? `derive:${JSON.stringify([
            item.derive.sourceEnvironmentId,
            item.derive.overrides,
          ])}`
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
          } else if (lossless) {
            // A new group for an existing environment: the backend copies
            // everything else from the stored row.
            push({
              derive: {
                sourceEnvironmentId: row.environmentId,
                expectedRevision: row.revision,
                overrides: { serverAttachmentId: group },
                replaces: row.environmentId,
              },
            });
          } else {
            push({ stack: deriveStack(row, { hostId, modelId, group }) });
          }
        }
        continue;
      }
      const candidates = onSource.length ? onSource : attached;
      let choice = chooseTemplate(candidates, {
        ignoreServerGroup: group !== null,
      });
      if (choice.kind === "ambiguous" && lossless) {
        const picked = candidates.find(
          (row) => row.environmentId === options.sourceEnvironmentId,
        );
        if (!picked) {
          throw new AmbiguousSuiteTemplateError(
            onSource.length
              ? "This client's setups differ, so pick the one the new model copies."
              : "This suite's clients don't share one setup, so pick the one the new client copies.",
            candidates,
          );
        }
        choice = {
          kind: "template",
          composition: environmentComposition(picked),
          source: picked,
        };
      }
      if (choice.kind === "ambiguous") {
        throw new Error(
          onSource.length
            ? "This client's setups differ (server group, skills, secrets or image), so there is no single one to copy. Add this model on the Environments page instead."
            : "This suite's clients don't share one setup, so there is no single one for a new client to copy. Pick one server group for the suite first, or add the client on the Environments page.",
        );
      }
      if (lossless && choice.kind === "template") {
        push({
          derive: {
            sourceEnvironmentId: choice.source.environmentId,
            expectedRevision: choice.source.revision,
            overrides: {
              hostId,
              modelId: modelId ?? null,
              ...(group !== null ? { serverAttachmentId: group } : {}),
            },
          },
        });
        continue;
      }
      push({
        stack: deriveStack(
          choice.kind === "template" ? choice.composition : {},
          { hostId, modelId, group },
        ),
      });
    }
  }

  const serverless = plan.filter((item) => {
    if (item.environmentId) {
      return lacksServerSource(
        attached.find((row) => row.environmentId === item.environmentId)!,
      );
    }
    if (item.derive) {
      const source = attached.find(
        (row) => row.environmentId === item.derive!.sourceEnvironmentId,
      )!;
      return lacksServerSource({
        ...source,
        serverAttachmentId:
          item.derive.overrides.serverAttachmentId ?? source.serverAttachmentId,
      });
    }
    return lacksServerSource(item.stack!);
  }).length;
  if (serverless > 0) {
    throw new Error(
      serverless === plan.length
        ? "Pick a server group for this suite first. Without one, its runs connect no servers."
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
      "Pick a server group for this suite first. Without one, its runs connect no servers.",
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

/** What sets one candidate setup apart, for the "which to copy" choice. */
function describeSetup(row: ProjectEnvironmentView): string {
  const c = environmentComposition(row);
  const parts = [
    c.serverAttachmentId ? "server group" : "no server group",
    c.skillSelection
      ? `${c.skillSelection.skillIds.length} skill${
          c.skillSelection.skillIds.length === 1 ? "" : "s"
        }`
      : null,
    c.serverSkillSelection ? "server skills" : null,
    c.secretSelection ? "secrets" : null,
    c.pluginVersionIds
      ? `${c.pluginVersionIds.length} plugin${
          c.pluginVersionIds.length === 1 ? "" : "s"
        }`
      : null,
    c.computerEnvironmentId ? "sandbox image" : null,
  ];
  return parts.filter(Boolean).join(" · ");
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
  const capabilities = useEnvironmentCapabilities(projectId);
  // The backend copies new environments from the stored source (every pin
  // kept); without it the browser composes them and refuses what it can't
  // copy.
  const lossless = capabilities?.environmentDerivation === true;
  const ensure = useEnsureAdhocEnvironments();
  const setSuiteEnvironments = useMutation(
    "testSuites:setSuiteEnvironments" as never,
  ) as unknown as (args: {
    suiteId: string;
    environmentIds: string[];
  }) => Promise<unknown>;
  const deriveSuiteEnvironments = useMutation(
    "testSuites:deriveSuiteEnvironments" as never,
  ) as unknown as (args: {
    suiteId: string;
    expectedEnvironmentIds: string[];
    targets: Array<
      | { keep: string }
      | {
          derive: Omit<SuiteClientsDerivation, "replaces">;
          replaces?: string;
        }
      | { compose: Stack }
    >;
  }) => Promise<unknown>;
  const [draft, setDraft] = useState<Selections | null>(null);
  const [saving, setSaving] = useState(false);
  /** An edit waiting on the person to pick which setup a new cell copies. */
  const [pendingChoice, setPendingChoice] = useState<{
    next: Selections;
    options: { group?: string | null; sourceHosts?: Record<string, string> };
    candidates: readonly ProjectEnvironmentView[];
    message: string;
  } | null>(null);
  const [pickedSource, setPickedSource] = useState<string>();
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
  const loading =
    isLoading ||
    pending ||
    environments === undefined ||
    capabilities === undefined;

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
      sourceEnvironmentId?: string;
    } = {},
  ) => {
    if (inFlight.current || readOnly || loading || unresolved || !capable)
      return;
    inFlight.current = true;
    const previous = draft;
    try {
      let plan: SuiteClientsPlanItem[];
      try {
        plan = planSuiteClients(suite, environments ?? [], next, {
          // An edit that is not a group pick keeps the shared group (or, for
          // a mixed suite, each environment's own).
          group: options.group !== undefined ? options.group : currentGroup,
          sourceHosts: options.sourceHosts,
          lossless,
          sourceEnvironmentId: options.sourceEnvironmentId,
        });
      } catch (error) {
        if (error instanceof AmbiguousSuiteTemplateError) {
          // Nothing is written: the person picks the setup to copy first.
          setPendingChoice({
            next,
            options: {
              ...(options.group !== undefined ? { group: options.group } : {}),
              ...(options.sourceHosts
                ? { sourceHosts: options.sourceHosts }
                : {}),
            },
            candidates: error.candidates,
            message: error.message,
          });
          setPickedSource(undefined);
          return;
        }
        throw error;
      }
      if (!plan.length) throw new Error("Keep at least one client and model.");
      if (plan.length > MAX_SUITE_ENVIRONMENTS)
        throw new Error(
          `Choose up to ${MAX_SUITE_ENVIRONMENTS} client/model combinations.`,
        );
      setDraft(next);
      setSaving(true);
      if (lossless) {
        // One transaction: derive, compose, keep, and repoint, refused if
        // someone else changed the suite's environments meanwhile.
        await deriveSuiteEnvironments({
          suiteId: suite._id,
          expectedEnvironmentIds: suite.environmentIds ?? [],
          targets: plan.map((item) => {
            if (item.environmentId) return { keep: item.environmentId };
            if (item.derive) {
              const { replaces, ...derive } = item.derive;
              return { derive, ...(replaces ? { replaces } : {}) };
            }
            return { compose: item.stack! };
          }),
        });
        return;
      }
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
    readOnly ||
    saving ||
    loading ||
    Boolean(unresolved) ||
    !capable ||
    pendingChoice !== null;
  const hostName = (hostId: string) =>
    hosts.find((host) => host.hostId === hostId)?.name ?? "Client";

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
      {pendingChoice ? (
        <div
          className="space-y-2 rounded-lg border border-border p-3"
          data-testid="suite-clients-template-choice"
        >
          <p className="text-xs text-muted-foreground">
            {pendingChoice.message} Everything but the client, model and server
            group is copied from it.
          </p>
          <RadioGroup
            aria-label="Setup to copy"
            value={pickedSource ?? ""}
            onValueChange={setPickedSource}
            className="grid gap-1.5"
          >
            {pendingChoice.candidates.map((row) => {
              const id = `suite-clients-source-${row.environmentId}`;
              return (
                <Label
                  key={row.environmentId}
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-xs has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
                >
                  <RadioGroupItem id={id} value={row.environmentId} />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block">
                      {row.name?.trim() ||
                        [hostName(row.hostId), row.modelId ?? "client model"]
                          .filter(Boolean)
                          .join(" · ")}
                    </span>
                    <span className="block font-normal text-muted-foreground">
                      {describeSetup(row)}
                    </span>
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPendingChoice(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!pickedSource}
              onClick={() => {
                const choice = pendingChoice;
                setPendingChoice(null);
                void commit(choice.next, {
                  ...choice.options,
                  sourceEnvironmentId: pickedSource,
                });
              }}
            >
              Copy this setup
            </Button>
          </div>
        </div>
      ) : null}
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
