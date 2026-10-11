import { useMemo, useState } from "react";
import { useConvexAuth, useQueries } from "convex/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";
import { useServerActionsOptional } from "@/state/server-actions-context";
import { shouldQueryProjectId, useProjectServers } from "@/hooks/useProjects";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useHostList } from "@/hooks/useClients";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  loadedOrgModelConfig,
  useHostedOrgModelConfig,
} from "@/hooks/use-hosted-org-model-config";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";
import { ASK_ORG_ADMIN, MANAGE_AI_PROVIDERS } from "@/lib/org-keys-refusal";
import {
  CHOOSE_ORG_JUDGE_MODEL,
  orgKeyProblemsOf,
  preflightJudgeOf,
  type PreflightJudge,
  type PreflightModel,
  type PreflightOrgConfig,
  type PreflightSelection,
} from "./suite-run-preflight-org-keys";
import { useOrgModelsHandoff } from "@/hooks/use-org-models-handoff";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { convexErrMessage } from "@/lib/convex-error";
import { getMcpServerDisplayName } from "@/lib/mcp-server-display-name";
import { getProviderDisplayName } from "@/lib/provider-registry";
import {
  classifyModelIdProvider,
  isRuntimeChosenModelSentinel,
} from "@/shared/model-provider";
import { isMCPJamProvidedModel } from "@/shared/types";
import {
  allModelsOutOfCredits,
  OUT_OF_CREDITS_MODEL_REASON,
} from "@/components/chat-v2/shared/available-models";
import { getEffectiveSuiteServers } from "../evals/helpers";
import { normalizeSuiteServerRefs } from "../evals/use-eval-handlers";
import type { EvalCase, EvalSuite } from "../evals/types";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { EnsureServersReadyResult } from "@/hooks/use-server-state";

export type RunPreflight = {
  /** Servers the browser has not connected: Start still tries to connect them. */
  disconnected: string[];
  /** Servers the project no longer has: the run cannot start. */
  removed: string[];
  /** The backend's own launch refusals (`ENV_*`): the run cannot start. */
  refused: string[];
  /** Each refusal by the environment that answered it. */
  refusalByEnvironment?: Readonly<Record<string, string>>;
  /** Org provider keys a run model needs that the org has not enabled. */
  disabledProviders: string[];
  /**
   * While the organization requires its own provider keys: each required AI
   * dependency that cannot run on its providers (an MCPJam-provided or
   * personal target model, a hosted judge, a judge nobody chose, a harness
   * client's model that is not an organization model on the harness's own
   * vendor). The run cannot start; the backend refuses the same launch.
   * Absent when there are none.
   */
  orgKeyProblems?: string[];
};

export type RunPreflightState = RunPreflight & {
  /** Every model the launch runs is out of MCPJam credits: why it cannot start. */
  outOfCreditsReason?: string | null;
  /** The same answer for only the environments picked in the sheet. */
  outOfCreditsReasonForEnvironments?: (
    environmentIds: readonly string[],
  ) => string | null;
  serverName: (ref: string) => string;
  connect?: (ref: string) => Promise<string | null>;
  manageModels?: () => void;
};

// The policy's checks live in `./suite-run-preflight-org-keys`; these stay
// importable from here.
export { CHOOSE_ORG_JUDGE_MODEL, preflightJudgeOf };
export type { PreflightJudge };

/** What a run would fail on, judged only from what the browser already knows. */
export function runPreflight(input: {
  serverRefs: readonly string[];
  servers: Readonly<Record<string, { connectionStatus?: string }>>;
  /** Absent while loading or outside a project: nothing reads as removed. */
  projectServers?: readonly { _id: string; name: string }[];
  models: readonly PreflightModel[];
  availableModelIds?: readonly string[];
  /** Absent while loading: no provider reads as disabled. */
  orgConfig?: PreflightOrgConfig;
  /** The suite's judge, when grading is required for this launch. */
  judge?: PreflightJudge;
  refused?: readonly string[];
  refusalByEnvironment?: Readonly<Record<string, string>>;
  /**
   * Skip a server neither the browser nor the project lists. An environment's
   * resolution includes its pinned plugins' servers, which the project's list
   * leaves out; the backend already refuses a server that is really gone.
   */
  knownOnly?: boolean;
}): RunPreflight {
  const disconnected: string[] = [];
  const removed: string[] = [];
  for (const ref of new Set(input.serverRefs)) {
    if (input.servers[ref]?.connectionStatus === "connected") continue;
    const known =
      Boolean(input.servers[ref]) ||
      Boolean(
        input.projectServers?.some(
          (server) => server._id === ref || server.name === ref,
        ),
      );
    if (!known && input.knownOnly) continue;
    const gone = !known && input.projectServers !== undefined;
    (gone ? removed : disconnected).push(ref);
  }
  const orgConfig = input.orgConfig;
  if (orgConfig && orgRequiresOwnKeys(orgConfig)) {
    // Under the policy the organization's own connections are the only
    // source; "is the provider enabled" is subsumed by these problems.
    const problems = orgKeyProblemsOf(orgConfig, input.models, input.judge);
    return {
      disconnected,
      removed,
      refused: [...(input.refused ?? [])],
      ...(input.refusalByEnvironment
        ? { refusalByEnvironment: input.refusalByEnvironment }
        : {}),
      disabledProviders: [],
      ...(problems.length > 0 ? { orgKeyProblems: problems } : {}),
    };
  }
  const disabledProviders = new Set<string>();
  for (const { model, provider } of input.orgConfig ? input.models : []) {
    if (
      !provider ||
      provider === "none" ||
      isRuntimeChosenModelSentinel(model) ||
      isMCPJamProvidedModel(model, provider) ||
      input.availableModelIds?.includes(model)
    )
      continue;
    if (
      !input.orgConfig!.providers.some(
        (row) => row.providerKey === provider && row.enabled,
      )
    )
      disabledProviders.add(provider);
  }
  return {
    disconnected,
    removed,
    refused: [...(input.refused ?? [])],
    ...(input.refusalByEnvironment
      ? { refusalByEnvironment: input.refusalByEnvironment }
      : {}),
    disabledProviders: [...disabledProviders],
  };
}

type PreflightEnvironment = Pick<
  ProjectEnvironmentView,
  "environmentId" | "hostId" | "modelId"
> & {
  /** The saved selection behind the environment's model override. */
  modelSelection?: PreflightSelection | null;
};

type PreflightTarget = {
  hostId: string;
  modelId?: string;
  /** The saved selection behind `modelId` (an org pick names its connection). */
  modelSelection?: PreflightSelection | null;
};

/**
 * `selection` when it was saved for `model` (or names no model), else
 * `undefined`: a selection is never carried onto another model.
 */
function selectionForModel(
  selection: PreflightSelection | null | undefined,
  model: string,
): PreflightSelection | undefined {
  if (!selection) return undefined;
  return !selection.modelId || selection.modelId === model
    ? selection
    : undefined;
}

/** The servers and models a launch of this suite would need. */
export function preflightTargets({
  suite,
  cases,
  environments,
  hosts,
  environmentServerRefs,
  targets,
  serverRefs,
}: {
  suite: EvalSuite;
  cases: readonly EvalCase[];
  environments: readonly PreflightEnvironment[];
  /**
   * A client's model, its saved selection when the browser knows it, and the
   * harness it runs.
   */
  hosts: readonly {
    hostId: string;
    modelId?: string | null;
    modelSelection?: PreflightSelection | null;
    harness?: string | null;
  }[];
  environmentServerRefs: readonly string[];
  /** The client/model cells the run will launch; else the attached ones. */
  targets?: readonly PreflightTarget[];
  /** The servers those cells run on, when the sheet picks them (a group). */
  serverRefs?: readonly string[];
}): { serverRefs: string[]; models: PreflightModel[] } {
  const environmentIds = suite.environmentIds ?? [];
  // Without planned cells, a suite without environments keeps its own launch:
  // an SDK suite's servers and models are what its CI ran, a legacy suite's
  // are its own.
  if (!targets && !environmentIds.length && suite.source === "sdk")
    return { serverRefs: [], models: [] };
  if (!targets && !environmentIds.length)
    return {
      serverRefs: normalizeSuiteServerRefs(getEffectiveSuiteServers(suite)),
      models: cases.flatMap((item) => item.models ?? []),
    };
  // A cell runs its own model, else its client's, each with the selection
  // saved for it: an organization model and MCPJam's model of the same id are
  // told apart only by that selection.
  const cells: readonly PreflightTarget[] =
    targets ??
    environmentIds.flatMap((id) => {
      const environment = environments.find(
        (item) => item.environmentId === id,
      );
      return environment
        ? [
            {
              hostId: environment.hostId,
              modelId: environment.modelId,
              ...(environment.modelSelection
                ? { modelSelection: environment.modelSelection }
                : {}),
            },
          ]
        : [];
    });
  const models = cells.flatMap((cell): PreflightModel[] => {
    const client = hosts.find((item) => item.hostId === cell.hostId);
    const host = cell.modelId ? undefined : client;
    const model = cell.modelId || host?.modelId;
    const provider = model ? classifyModelIdProvider(model) : null;
    if (!model || !provider) return [];
    const selection = selectionForModel(
      cell.modelId ? cell.modelSelection : host?.modelSelection,
      model,
    );
    return [
      {
        model,
        provider: provider.provider,
        ...(selection ? { selection } : {}),
        ...(client?.harness ? { harness: client.harness } : {}),
      },
    ];
  });
  return { serverRefs: [...(serverRefs ?? environmentServerRefs)], models };
}

/**
 * Refusals that depend on where the run executes. The run route picks a local
 * or hosted venue server-side, and the browser resolves as hosted, so these
 * may not apply to the real launch.
 */
const VENUE_DEPENDENT_REFUSALS = new Set([
  "ENV_LOCAL_SERVERS_REQUIRED",
  "ENV_PLUGIN_COMPONENT_UNSUPPORTED",
]);

/**
 * About an environment's own client and model. A new cell that only copies an
 * environment's setup brings its own, so these don't apply to it.
 */
const CLIENT_AND_MODEL_REFUSALS = new Set([
  "ENV_HOST_MISSING",
  "ENV_MODEL_REQUIRED",
]);

/**
 * Each environment's launch resolution: the servers its run would connect,
 * and the `ENV_*` refusals the launch itself would answer with. Any other
 * failure is left to the run route to report.
 */
export function readEnvironmentResolutions(
  results: Readonly<Record<string, unknown>>,
  /** Environments the run only copies a setup from, never launches. */
  templateOnly: ReadonlySet<string> = new Set(),
): {
  serverRefs: string[];
  refusals: string[];
  refusalByEnvironment: Record<string, string>;
  /**
   * Each client's saved model selection, from environments that inherit the
   * client's model. Absent when none does.
   */
  hostModelSelections?: Record<string, PreflightSelection>;
} {
  const serverRefs: string[] = [];
  const refusals = new Set<string>();
  const refusalByEnvironment: Record<string, string> = {};
  const hostModelSelections: Record<string, PreflightSelection> = {};
  for (const [environmentId, resolved] of Object.entries(results)) {
    if (resolved instanceof Error) {
      const code = (resolved as { data?: { code?: unknown } }).data?.code;
      if (
        typeof code === "string" &&
        code.startsWith("ENV_") &&
        !VENUE_DEPENDENT_REFUSALS.has(code) &&
        !(
          templateOnly.has(environmentId) && CLIENT_AND_MODEL_REFUSALS.has(code)
        )
      )
        refusals.add(
          (refusalByEnvironment[environmentId] = convexErrMessage(
            resolved,
            resolved.message,
          )),
        );
      else if (typeof code !== "string" || !code.startsWith("ENV_"))
        console.warn(
          "[Setup Run] Could not preflight an environment; the launch will check it.",
          resolved,
        );
      continue;
    }
    const resolution = resolved as
      | {
          servers?: unknown;
          hostId?: unknown;
          modelSource?: unknown;
          effectiveModelId?: unknown;
          effectiveModelSelection?: unknown;
        }
      | undefined;
    const servers = resolution?.servers;
    if (Array.isArray(servers))
      for (const server of servers as Array<{
        serverId: string;
        name?: string;
      }>)
        serverRefs.push(server.name?.trim() || server.serverId);
    // An environment that inherits its client's model resolves the client's
    // saved selection, which the client list does not carry.
    const selection = resolution?.effectiveModelSelection as
      PreflightSelection | null | undefined;
    if (
      resolution?.modelSource === "host" &&
      typeof resolution.hostId === "string" &&
      typeof resolution.effectiveModelId === "string" &&
      selection &&
      typeof selection === "object" &&
      selection.modelId === resolution.effectiveModelId
    )
      hostModelSelections[resolution.hostId] = selection;
  }
  return {
    serverRefs,
    refusals: [...refusals],
    refusalByEnvironment,
    ...(Object.keys(hostModelSelections).length > 0
      ? { hostModelSelections }
      : {}),
  };
}

export function useEnvironmentResolutions(
  projectId: string,
  environmentIds: readonly string[],
  enabled = true,
  templateOnly: readonly string[] = [],
) {
  // Convex resubscribes whenever this object changes identity, and every
  // resubscribe re-renders, so it is rebuilt only when its inputs change.
  const key = environmentIds.join(",");
  const queries = useMemo(
    () =>
      Object.fromEntries(
        (enabled && key ? key.split(",") : []).map((environmentId) => [
          environmentId,
          {
            query: "projectEnvironments:resolveEnvironmentForLaunch" as any,
            // The rule the run route resolves with. Only arguments every
            // backend accepts: an unknown one fails validation, and the
            // preflight would go quiet.
            args: {
              projectId,
              environmentId,
              serverSource: "environment_only",
            },
          },
        ]),
      ),
    [projectId, key, enabled],
  );
  return readEnvironmentResolutions(useQueries(queries), new Set(templateOnly));
}

export function useSuiteRunPreflight({
  projectId,
  suite,
  cases,
  environments = [],
  planned,
}: {
  projectId: string;
  suite: EvalSuite;
  cases: readonly EvalCase[];
  environments?: readonly PreflightEnvironment[];
  /** What the sheet will launch, when it plans cells of its own. */
  planned?: {
    environmentIds: readonly string[];
    templateOnlyIds: readonly string[];
    targets: readonly PreflightTarget[];
    /** The servers the cells run on, when the sheet picks them. */
    serverRefs?: readonly string[];
  };
}): RunPreflightState {
  const appState = useOptionalSharedAppState();
  const actions = useServerActionsOptional();
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const organizationId =
    findProjectByAnyId(appState?.projects ?? {}, projectId)?.organizationId ??
    null;
  const { servers: projectServers } = useProjectServers({
    projectId,
    isAuthenticated,
  });
  const { hosts } = useHostList({ isAuthenticated, projectId });
  const { availableModels, outOfCreditsReason } = useAvailableModels({
    projectId,
  });
  const orgConfig = useHostedOrgModelConfig({ projectId, organizationId });
  const manageModels = useOrgModelsHandoff(organizationId);
  const environment = useEnvironmentResolutions(
    projectId,
    planned?.environmentIds ?? suite.environmentIds ?? [],
    // The gate `useProjectServers` reads with: a signed-out browser or a
    // placeholder project id would only collect validator errors.
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId),
    planned?.templateOnlyIds,
  );
  const hostModelSelections = environment.hostModelSelections;
  // Each client with the saved selection its environments resolved, so an
  // organization model and MCPJam's model of the same id are told apart.
  const hostsWithSelections = hostModelSelections
    ? hosts.map((host) => {
        const selection = hostModelSelections[host.hostId];
        return selection && selection.modelId === host.modelId
          ? { ...host, modelSelection: selection }
          : host;
      })
    : hosts;
  const targets = preflightTargets({
    suite,
    cases,
    environments,
    hosts: hostsWithSelections,
    environmentServerRefs: environment.serverRefs,
    targets: planned?.targets,
    serverRefs: planned?.serverRefs,
  });
  const preflight = runPreflight({
    ...targets,
    refused: environment.refusals,
    refusalByEnvironment: environment.refusalByEnvironment,
    servers: appState?.servers ?? {},
    projectServers,
    knownOnly: Boolean(planned ?? suite.environmentIds?.length),
    availableModelIds: availableModels.map((model) => String(model.id)),
    // Pending reads as loading: nothing is judged before the policy is known.
    orgConfig: loadedOrgModelConfig(orgConfig),
    judge: preflightJudgeOf(suite),
  });
  // The models are locked in `availableModels` only while the org is out.
  const creditsReasonFor = (models: typeof targets.models) =>
    allModelsOutOfCredits(models, availableModels)
      ? (outOfCreditsReason ?? OUT_OF_CREDITS_MODEL_REASON)
      : null;
  return {
    ...preflight,
    outOfCreditsReason: creditsReasonFor(targets.models),
    // Planned cells are already what launches; otherwise the sheet picks
    // environments, and only theirs count.
    ...(planned
      ? {}
      : {
          outOfCreditsReasonForEnvironments: (environmentIds) =>
            creditsReasonFor(
              preflightTargets({
                suite: { ...suite, environmentIds: [...environmentIds] },
                cases,
                environments,
                hosts: hostsWithSelections,
                environmentServerRefs: [],
              }).models,
            ),
        }),
    serverName: (ref) =>
      getMcpServerDisplayName(ref, { remoteServers: projectServers }),
    ...(actions
      ? {
          connect: async (ref: string) => {
            const name = getMcpServerDisplayName(ref, {
              remoteServers: projectServers,
            });
            return connectOutcome(
              name,
              await actions.ensureServersReady([ref]),
            );
          },
        }
      : {}),
    ...(manageModels ? { manageModels } : {}),
  };
}

/**
 * An environment suite's refusals and credits gate, kept only for the
 * environments selected.
 */
export function scopePreflightToEnvironments<
  T extends RunPreflight &
    Pick<RunPreflightState, "outOfCreditsReasonForEnvironments">,
>(preflight: T, selectedEnvironmentIds: readonly string[]): T {
  const credits = preflight.outOfCreditsReasonForEnvironments
    ? {
        outOfCreditsReason: preflight.outOfCreditsReasonForEnvironments(
          selectedEnvironmentIds,
        ),
      }
    : {};
  const byEnvironment = preflight.refusalByEnvironment;
  if (!byEnvironment) return { ...preflight, ...credits };
  return {
    ...preflight,
    ...credits,
    refused: [
      ...new Set(
        selectedEnvironmentIds.flatMap((id) =>
          byEnvironment[id] ? [byEnvironment[id]] : [],
        ),
      ),
    ],
  };
}

/** A legacy suite's server problems, kept only for the clients selected. */
export function scopePreflightToHosts<T extends RunPreflight>(
  preflight: T,
  suite: EvalSuite,
  selectedHostIds: readonly string[],
): T {
  const refs = new Set(
    normalizeSuiteServerRefs(
      getEffectiveSuiteServers({
        ...suite,
        hostAttachments: suite.hostAttachments?.filter((host) =>
          selectedHostIds.includes(host.namedHostId),
        ),
      }),
    ),
  );
  return {
    ...preflight,
    disconnected: preflight.disconnected.filter((ref) => refs.has(ref)),
    removed: preflight.removed.filter((ref) => refs.has(ref)),
  };
}

/** What a Connect from the sheet came to: nothing to say once it's ready. */
export function connectOutcome(
  name: string,
  result: EnsureServersReadyResult,
): string | null {
  if (result.readyServerNames.length) return null;
  return result.reauthServerNames.length
    ? `${name} needs authorizing before it can connect.`
    : `${name} didn't connect.`;
}

export function hasBlockingPreflight(preflight?: RunPreflight): boolean {
  return Boolean(
    preflight?.removed.length ||
    preflight?.refused.length ||
    preflight?.orgKeyProblems?.length,
  );
}

export function RunPreflightNotices({
  preflight,
  disabled = false,
  onEditSettings,
  onConnectingChange,
}: {
  preflight: RunPreflightState;
  disabled?: boolean;
  /** Where an environment's launch refusal is fixed. */
  onEditSettings?: () => void;
  /** Start must wait: a launch connects the same server again. */
  onConnectingChange?: (connecting: boolean) => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  // Kept with its server, so it goes away once that server connects, from
  // here or anywhere else.
  const [failure, setFailure] = useState<{
    ref: string;
    message: string;
  } | null>(null);
  const { disconnected, removed, refused, disabledProviders, serverName } =
    preflight;
  const orgKeyProblems = preflight.orgKeyProblems ?? [];
  if (
    !disconnected.length &&
    !removed.length &&
    !refused.length &&
    !disabledProviders.length &&
    !orgKeyProblems.length
  )
    return null;
  const openServers = (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs"
      onClick={() => navigateApp(routePaths.servers)}
    >
      Open Servers
    </Button>
  );
  const connect = async (ref: string) => {
    if (!preflight.connect) return;
    setConnecting(ref);
    onConnectingChange?.(true);
    setFailure(null);
    try {
      const message = await preflight.connect(ref);
      setFailure(message ? { ref, message } : null);
    } catch (error) {
      console.warn("[Setup Run] Connect failed.", error);
      setFailure({ ref, message: `${serverName(ref)} didn't connect.` });
    } finally {
      setConnecting(null);
      onConnectingChange?.(false);
    }
  };
  return (
    <section
      aria-label="Before you run"
      className="space-y-2 rounded-lg border border-warning/45 bg-warning/10 p-3 text-xs"
    >
      {orgKeyProblems.length > 0 && (
        <div className="space-y-1" data-testid="preflight-org-key-problems">
          {orgKeyProblems.map((message) => (
            <p key={`org-keys:${message}`} className="text-destructive">
              {message}
            </p>
          ))}
          {preflight.manageModels ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={preflight.manageModels}
            >
              {MANAGE_AI_PROVIDERS}
            </Button>
          ) : (
            <p className="text-muted-foreground">
              {ASK_ORG_ADMIN} if no organization model fits.
            </p>
          )}
        </div>
      )}
      {refused.map((message) => (
        <p key={`refused:${message}`} className="text-destructive">
          {message}{" "}
          {onEditSettings && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={onEditSettings}
            >
              Open suite settings
            </Button>
          )}
        </p>
      ))}
      {removed.map((ref) => (
        <p key={`removed:${ref}`} className="text-destructive">
          {serverName(ref)} is no longer in this project, so this suite can't
          run. Re-add it, or point the suite at another server. {openServers}
        </p>
      ))}
      {disconnected.map((ref) => (
        <div key={`disconnected:${ref}`} className="flex items-center gap-2">
          <p className="min-w-0 flex-1">
            {serverName(ref)} isn't connected. Start tries to connect it.
          </p>
          {preflight.connect ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || connecting !== null}
              aria-label={`Connect ${serverName(ref)}`}
              onClick={() => void connect(ref)}
            >
              {connecting === ref && (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              )}
              Connect
            </Button>
          ) : (
            openServers
          )}
        </div>
      ))}
      {failure && disconnected.includes(failure.ref) && (
        <p role="alert" className="text-destructive">
          {failure.message} {openServers}
        </p>
      )}
      {disabledProviders.map((provider) => (
        <div key={`provider:${provider}`} className="flex items-center gap-2">
          <p className="min-w-0 flex-1">
            {getProviderDisplayName(provider)} isn't enabled in your
            organization's AI providers, so its models will fail to run.
          </p>
          {preflight.manageModels && (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={preflight.manageModels}
            >
              Manage models
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
