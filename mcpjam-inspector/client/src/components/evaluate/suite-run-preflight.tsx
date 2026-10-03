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
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
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

export type RunPreflight = {
  /** Servers the browser has not connected: Start still tries to connect them. */
  disconnected: string[];
  /** Servers the project no longer has: the run cannot start. */
  removed: string[];
  /** The backend's own launch refusals (`ENV_*`): the run cannot start. */
  refused: string[];
  /** Org provider keys a run model needs that the org has not enabled. */
  disabledProviders: string[];
};

export type RunPreflightState = RunPreflight & {
  serverName: (ref: string) => string;
  connect?: (ref: string) => Promise<string | null>;
  manageModels?: () => void;
};

/** What a run would fail on, judged only from what the browser already knows. */
export function runPreflight(input: {
  serverRefs: readonly string[];
  servers: Readonly<Record<string, { connectionStatus?: string }>>;
  /** Absent while loading or outside a project: nothing reads as removed. */
  projectServers?: readonly { _id: string; name: string }[];
  models: readonly { model: string; provider: string }[];
  availableModelIds?: readonly string[];
  /** Absent while loading: no provider reads as disabled. */
  orgConfig?: { providers: { providerKey: string; enabled: boolean }[] };
  refused?: readonly string[];
}): RunPreflight {
  const disconnected: string[] = [];
  const removed: string[] = [];
  for (const ref of new Set(input.serverRefs)) {
    if (input.servers[ref]?.connectionStatus === "connected") continue;
    const gone =
      !input.servers[ref] &&
      input.projectServers !== undefined &&
      !input.projectServers.some(
        (server) => server._id === ref || server.name === ref,
      );
    (gone ? removed : disconnected).push(ref);
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
}: {
  suite: EvalSuite;
  cases: readonly EvalCase[];
  environments: readonly PreflightEnvironment[];
  hosts: readonly { hostId: string; modelId?: string | null }[];
  environmentServerRefs: readonly string[];
  /** The client/model cells the run will launch; else the attached ones. */
  targets?: readonly PreflightTarget[];
}): { serverRefs: string[]; models: { model: string; provider: string }[] } {
  const environmentIds = suite.environmentIds ?? [];
  // An SDK suite runs in the environment picked in the sheet; its own
  // servers and models are what its CI ran.
  if (!environmentIds.length && suite.source === "sdk")
    return { serverRefs: [], models: [] };
  if (!environmentIds.length)
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
  return { serverRefs: [...environmentServerRefs], models };
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
): { serverRefs: string[]; refusals: string[] } {
  const serverRefs: string[] = [];
  const refusals = new Set<string>();
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
        refusals.add(convexErrMessage(resolved, resolved.message));
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
  return { serverRefs, refusals: [...refusals] };
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
            // The rule the run route resolves with. `requireLiveServers`
            // opts in to refusing a group server that was deleted, which the
            // launch itself refuses; it is opt-in because GitHub checks
            // resolve here too and replace every server.
            args: {
              projectId,
              environmentId,
              serverSource: "environment_only",
              requireLiveServers: true,
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
    }),
    refused: environment.refusals,
    servers: appState?.servers ?? {},
    projectServers,
    availableModelIds: availableModels.map((model) => String(model.id)),
    orgConfig,
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
            const result = await actions.ensureServersReady([ref]);
            if (result.readyServerNames.length) return null;
            return result.reauthServerNames.length
              ? `${name} needs authorizing before it can connect.`
              : `${name} didn't connect.`;
          },
        }
      : {}),
    ...(manageModels ? { manageModels } : {}),
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

export function hasBlockingPreflight(preflight?: RunPreflight): boolean {
  return Boolean(preflight?.removed.length || preflight?.refused.length);
}

export function RunPreflightNotices({
  preflight,
  disabled = false,
  onEditSettings,
}: {
  preflight: RunPreflightState;
  disabled?: boolean;
  /** Where an environment's launch refusal is fixed. */
  onEditSettings?: () => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { disconnected, removed, refused, disabledProviders, serverName } =
    preflight;
  if (
    !disconnected.length &&
    !removed.length &&
    !refused.length &&
    !disabledProviders.length
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
    setFailure(null);
    try {
      setFailure(await preflight.connect(ref));
    } catch {
      setFailure(`${serverName(ref)} didn't connect.`);
    } finally {
      setConnecting(null);
    }
  };
  return (
    <section
      aria-label="Before you run"
      className="space-y-2 rounded-lg border border-warning/45 bg-warning/10 p-3 text-xs"
    >
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
      {failure && (
        <p role="alert" className="text-destructive">
          {failure} {openServers}
        </p>
      )}
      {disabledProviders.map((provider) => (
        <div key={`provider:${provider}`} className="flex items-center gap-2">
          <p className="min-w-0 flex-1">
            {getProviderDisplayName(provider)} isn't enabled for this project,
            so its models will fail to run.
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
