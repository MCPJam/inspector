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
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import {
  isOrgConnectionEligible,
  orgKeysRequired,
} from "@/components/chat-v2/shared/org-ai-policy";
import { MANAGED_DEFAULT_JUDGE_MODEL } from "@/components/shared/session-quality/judge-config";
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
   * personal target model, a hosted judge). The run cannot start; the backend
   * refuses the same launch. Absent when there are none.
   */
  orgKeyProblems?: string[];
};

export type RunPreflightState = RunPreflight & {
  serverName: (ref: string) => string;
  connect?: (ref: string) => Promise<string | null>;
  manageModels?: () => void;
};

type PreflightModel = {
  model: string;
  provider: string;
  /** The saved selection beside a case model, when it has one. */
  selection?: PreflightSelection | null;
};

type PreflightSelection = {
  source?: string;
  connectionRef?: { kind?: string; id?: string } | null;
};

type PreflightOrgConfig = {
  providers: Array<
    Pick<OrgModelProvider, "providerKey" | "enabled"> &
      Partial<Pick<OrgModelProvider, "id" | "hasSecret" | "runtimeLocation">>
  >;
  aiKeyPolicy?: OrgVisibleConfig["aiKeyPolicy"];
  aiReadiness?: OrgVisibleConfig["aiReadiness"];
};

/**
 * The judge a launch requires: `default` grades on the platform default (on
 * the organization's keys, its Smart model); `explicit` names a saved model.
 */
export type PreflightJudge =
  | { kind: "default" }
  | {
      kind: "explicit";
      modelId: string;
      selection?: PreflightSelection | null;
    };

const CHOOSE_ORG_MODEL = "Choose a model from an organization provider.";

function eligibleConnection(
  orgConfig: PreflightOrgConfig,
  predicate: (provider: PreflightOrgConfig["providers"][number]) => boolean,
): boolean {
  return orgConfig.providers.some(
    (provider) =>
      predicate(provider) &&
      isOrgConnectionEligible(
        {
          hasSecret: true,
          ...provider,
        },
        orgConfig,
      ),
  );
}

/**
 * Whether a saved model can run while the organization requires its own
 * keys: an org selection on an eligible connection, or (for a legacy id) a
 * provider the organization serves on an eligible connection. Hosted and
 * personal-key models never can.
 */
function orgKeyModelProblem(
  orgConfig: PreflightOrgConfig,
  model: PreflightModel,
  label: string,
): string | null {
  const source = model.selection?.source;
  if (source === "org") {
    const id = model.selection?.connectionRef?.id;
    return eligibleConnection(orgConfig, (provider) =>
      id ? provider.id === id : provider.providerKey === model.provider,
    )
      ? null
      : `${label} uses an organization provider connection that can't run it while the organization requires its own keys. ${CHOOSE_ORG_MODEL}`;
  }
  if (
    source === "hosted" ||
    (!source && isMCPJamProvidedModel(model.model, model.provider))
  ) {
    return `${label} is an MCPJam-provided model, which this organization doesn't allow. ${CHOOSE_ORG_MODEL}`;
  }
  if (
    !source &&
    eligibleConnection(
      orgConfig,
      (provider) => provider.providerKey === model.provider,
    )
  ) {
    return null;
  }
  return `${label} runs on a personal or local key, which this organization doesn't allow. ${CHOOSE_ORG_MODEL}`;
}

function orgKeyJudgeProblem(
  orgConfig: PreflightOrgConfig,
  judge: PreflightJudge,
): string | null {
  if (judge.kind === "default") {
    const status = orgConfig.aiReadiness?.operations.find(
      (operation) => operation.operation === "judge",
    )?.status;
    return status === "unconfigured"
      ? "The judge uses the organization's Smart model, and none is configured. An organization admin can set one in Organization → AI providers."
      : null;
  }
  return orgKeyModelProblem(
    orgConfig,
    {
      model: judge.modelId,
      provider:
        classifyModelIdProvider(judge.modelId)?.provider ??
        judge.modelId.split("/")[0] ??
        "",
      selection: judge.selection ?? { source: "hosted" },
    },
    "The judge",
  );
}

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
  if (orgConfig && orgKeysRequired(orgConfig)) {
    // Under the policy the organization's own connections are the only
    // source; "is the provider enabled" is subsumed by the problems below.
    const problems = new Set<string>();
    for (const model of input.models) {
      if (
        !model.provider ||
        model.provider === "none" ||
        isRuntimeChosenModelSentinel(model.model)
      )
        continue;
      const problem = orgKeyModelProblem(orgConfig, model, model.model);
      if (problem) problems.add(problem);
    }
    const judgeProblem = input.judge
      ? orgKeyJudgeProblem(orgConfig, input.judge)
      : null;
    if (judgeProblem) problems.add(judgeProblem);
    return {
      disconnected,
      removed,
      refused: [...(input.refused ?? [])],
      ...(input.refusalByEnvironment
        ? { refusalByEnvironment: input.refusalByEnvironment }
        : {}),
      disabledProviders: [],
      ...(problems.size > 0 ? { orgKeyProblems: [...problems] } : {}),
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
>;

type PreflightTarget = { hostId: string; modelId?: string };

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
  hosts: readonly { hostId: string; modelId?: string | null }[];
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
  // A cell runs its own model, else its client's.
  const cells =
    targets ??
    environmentIds.flatMap((id) => {
      const environment = environments.find(
        (item) => item.environmentId === id,
      );
      return environment
        ? [{ hostId: environment.hostId, modelId: environment.modelId }]
        : [];
    });
  const models = cells.flatMap((cell) => {
    const model =
      cell.modelId ||
      hosts.find((host) => host.hostId === cell.hostId)?.modelId;
    const provider = model ? classifyModelIdProvider(model) : null;
    return model && provider ? [{ model, provider: provider.provider }] : [];
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
} {
  const serverRefs: string[] = [];
  const refusals = new Set<string>();
  const refusalByEnvironment: Record<string, string> = {};
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
    const servers = (resolved as { servers?: unknown } | undefined)?.servers;
    if (Array.isArray(servers))
      for (const server of servers as Array<{
        serverId: string;
        name?: string;
      }>)
        serverRefs.push(server.name?.trim() || server.serverId);
  }
  return { serverRefs, refusals: [...refusals], refusalByEnvironment };
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
  const { availableModels } = useAvailableModels({ projectId });
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
  const preflight = runPreflight({
    ...preflightTargets({
      suite,
      cases,
      environments,
      hosts,
      environmentServerRefs: environment.serverRefs,
      targets: planned?.targets,
      serverRefs: planned?.serverRefs,
    }),
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
  return {
    ...preflight,
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

/** An environment suite's refusals, kept only for the environments selected. */
export function scopePreflightToEnvironments<T extends RunPreflight>(
  preflight: T,
  selectedEnvironmentIds: readonly string[],
): T {
  const byEnvironment = preflight.refusalByEnvironment;
  if (!byEnvironment) return preflight;
  return {
    ...preflight,
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

/**
 * The judge a launch of this suite requires, as the backend's launch
 * preflight reads it: only when grading is on and automatic or gating.
 */
export function preflightJudgeOf(
  suite: Pick<EvalSuite, "judgeConfig">,
): PreflightJudge | undefined {
  const goal = suite.judgeConfig?.goalCompletion;
  if (goal?.enabled === false) return undefined;
  const required =
    goal?.autoRun === true ||
    goal?.role === "gating" ||
    goal?.role === "required";
  if (!required) return undefined;
  const modelId = goal?.judgeModel?.trim();
  const selection = goal?.judgeSelection as PreflightSelection | undefined;
  if (selection?.source === "org" && modelId) {
    return { kind: "explicit", modelId, selection };
  }
  if (!modelId || modelId === MANAGED_DEFAULT_JUDGE_MODEL) {
    return { kind: "default" };
  }
  return { kind: "explicit", modelId, selection: selection ?? null };
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
              Manage AI providers
            </Button>
          ) : (
            <p className="text-muted-foreground">
              Ask an organization admin if no organization model fits.
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
