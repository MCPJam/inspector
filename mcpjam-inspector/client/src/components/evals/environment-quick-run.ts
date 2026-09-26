/**
 * Quick runs of an ENVIRONMENT suite: which environment each picked target
 * executes.
 *
 * The editor keeps its client / model / server-group dropdowns — the
 * environments UI is flag-gated off for most users — and the environment is
 * resolved behind them. Each target (a client and a model, on the picked
 * server group) becomes exactly one environment:
 *
 *  - REUSE the suite's own environment for that client, model and group, with
 *    every setting it carries beyond those three (skills, plugin pins, secret
 *    grants, captured server skills). Two such environments are ambiguous, and
 *    ambiguity is refused rather than guessed.
 *  - Otherwise DERIVE one on the backend from the one setup the suite's
 *    environments share, overriding only the client, model and group. The
 *    backend reads the source row itself, so nothing the browser's redacted
 *    view lacks is dropped. Never a browser-side copy of a stack literal.
 *
 * Every target is resolved before any of them runs; the quick-run request then
 * names the environment and nothing it owns.
 */
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import {
  chooseTemplate,
  lacksServerSource,
  sharedServerGroup,
} from "../evaluate/environment-template";
import { parseModelValue } from "./compare-playground-helpers";

export type QuickRunTargetRequest = {
  /** The caller's handle for the target (the editor's model value). */
  key: string;
  hostId: string;
  /** Explicit model id; absent means the client's own model. */
  modelId?: string;
};

export type QuickRunTargetPlan =
  | { kind: "reuse"; key: string; environmentId: string }
  | {
      kind: "derive";
      key: string;
      source: ProjectEnvironmentView;
      overrides: {
        hostId: string;
        modelId: string | null;
        serverAttachmentId: string;
      };
    }
  | { kind: "blocked"; key: string; reason: string };

/**
 * The suite's attached environments, in suite order — or `null` while any of
 * them is still loading (a plan made from a partial list could miss the
 * environment a target should reuse).
 */
export function attachedSuiteEnvironments(
  suite: { environmentIds?: readonly string[] | null },
  environments: readonly ProjectEnvironmentView[] | undefined,
): ProjectEnvironmentView[] | null {
  if (!environments) return null;
  const attached: ProjectEnvironmentView[] = [];
  for (const id of suite.environmentIds ?? []) {
    const environment = environments.find(
      (candidate) => candidate.environmentId === id,
    );
    if (!environment) return null;
    attached.push(environment);
  }
  return attached;
}

/** The clients a quick run offers: the suite environments' clients, in order. */
export function quickRunClientIds(
  attached: readonly ProjectEnvironmentView[],
): string[] {
  return [...new Set(attached.map((environment) => environment.hostId))];
}

/**
 * The server group the picker starts on: the one every environment of the
 * suite shares, or none (the user picks) when they disagree or have none.
 */
export function defaultQuickRunServerGroup(
  attached: readonly ProjectEnvironmentView[],
): string | null {
  const shared = sharedServerGroup(attached);
  return shared.kind === "group" ? shared.serverAttachmentId : null;
}

/**
 * The models the editor starts on for a client: what the suite's environments
 * on that client run. An environment that inherits its client's model
 * contributes that model when it is known.
 */
export function defaultQuickRunModelIds(
  attached: readonly ProjectEnvironmentView[],
  hostId: string,
  clientModelId?: (hostId: string) => string | undefined,
): string[] {
  const out: string[] = [];
  for (const environment of attached) {
    if (environment.hostId !== hostId) continue;
    const modelId = environment.modelId ?? clientModelId?.(hostId);
    if (modelId && !out.includes(modelId)) out.push(modelId);
  }
  return out;
}

function runsModel(
  environment: ProjectEnvironmentView,
  target: QuickRunTargetRequest,
  clientModelId?: (hostId: string) => string | undefined,
): boolean {
  if (target.modelId === undefined) return environment.modelId === undefined;
  if (environment.modelId !== undefined) {
    return environment.modelId === target.modelId;
  }
  // An environment that inherits its client's model runs that model.
  return clientModelId?.(environment.hostId) === target.modelId;
}

/**
 * Decide, for every target, which environment it runs — without writing
 * anything. A blocked target carries the reason to show.
 */
export function planQuickRunTargets(args: {
  attached: readonly ProjectEnvironmentView[];
  /** The picked server group; `null` when none is picked. */
  serverAttachmentId: string | null;
  targets: readonly QuickRunTargetRequest[];
  clientModelId?: (hostId: string) => string | undefined;
}): QuickRunTargetPlan[] {
  const group = args.serverAttachmentId || null;
  return args.targets.map((target): QuickRunTargetPlan => {
    const exact = args.attached.filter(
      (environment) =>
        environment.hostId === target.hostId &&
        (environment.serverAttachmentId || null) === group &&
        runsModel(environment, target, args.clientModelId),
    );
    if (exact.length > 1) {
      return {
        kind: "blocked",
        key: target.key,
        reason:
          "Several of this suite's environments run this client and model on this server group, so a quick run can't tell which one you mean. Run the suite, or remove the duplicate in suite settings.",
      };
    }
    if (exact.length === 1) {
      const environment = exact[0]!;
      if (lacksServerSource(environment)) {
        return {
          kind: "blocked",
          key: target.key,
          reason:
            "This environment has no server group, so the run would connect no servers. Pick a server group.",
        };
      }
      return {
        kind: "reuse",
        key: target.key,
        environmentId: environment.environmentId,
      };
    }
    if (!group) {
      return {
        kind: "blocked",
        key: target.key,
        reason: "Pick a server group to run this case.",
      };
    }
    // A new combination copies the one setup its candidates share: the
    // client's own environments, or the suite's for a client it does not
    // use yet. The group is being replaced, so only the rest must agree.
    const onClient = args.attached.filter(
      (environment) => environment.hostId === target.hostId,
    );
    const choice = chooseTemplate(onClient.length ? onClient : args.attached, {
      ignoreServerGroup: true,
    });
    if (choice.kind === "ambiguous") {
      return {
        kind: "blocked",
        key: target.key,
        reason: onClient.length
          ? "This client's environments differ, so a new model has no single setup to copy. Add it in suite settings first."
          : "This suite's environments don't share one setup, so a new client has no single setup to copy. Add it in suite settings first.",
      };
    }
    if (choice.kind === "none") {
      return {
        kind: "blocked",
        key: target.key,
        reason:
          "This suite has no environment to copy a setup from. Add a client in suite settings first.",
      };
    }
    return {
      kind: "derive",
      key: target.key,
      source: choice.source,
      overrides: {
        hostId: target.hostId,
        modelId: target.modelId ?? null,
        serverAttachmentId: group,
      },
    };
  });
}

type ConvexLike = {
  query: (name: any, args: any) => Promise<unknown>;
  mutation: (name: any, args: any) => Promise<unknown>;
};

type Capabilities = {
  environmentQuickRuns?: boolean;
  environmentDerivation?: boolean;
};

async function readCapabilities(
  convex: ConvexLike,
  projectId: string,
): Promise<Capabilities> {
  try {
    const caps = await convex.query(
      "projectEnvironments:getCapabilities" as any,
      { projectId },
    );
    return caps && typeof caps === "object" ? (caps as Capabilities) : {};
  } catch {
    // A deployment that cannot answer cannot run environment quick runs.
    return {};
  }
}

/**
 * Resolve every planned target to an environment id — deriving the new ones
 * in ONE backend call — before any of them runs. Throws with the first
 * blocked target's reason, and refuses on a deployment that cannot run
 * environment quick runs rather than falling back to the suite's legacy
 * configuration.
 */
export async function resolveQuickRunEnvironments(
  convex: ConvexLike,
  args: { projectId: string; plans: readonly QuickRunTargetPlan[] },
): Promise<Map<string, string>> {
  const blocked = args.plans.find((plan) => plan.kind === "blocked");
  if (blocked?.kind === "blocked") throw new Error(blocked.reason);
  const capabilities = await readCapabilities(convex, args.projectId);
  if (!capabilities.environmentQuickRuns) {
    throw new Error(
      "This deployment can't run a single case of an environment suite yet. Run the suite instead, or try again after the update.",
    );
  }
  const resolved = new Map<string, string>();
  const derivations: Array<Extract<QuickRunTargetPlan, { kind: "derive" }>> =
    [];
  for (const plan of args.plans) {
    if (plan.kind === "reuse") resolved.set(plan.key, plan.environmentId);
    else if (plan.kind === "derive") derivations.push(plan);
  }
  if (derivations.length) {
    if (!capabilities.environmentDerivation) {
      throw new Error(
        "This deployment can't copy an environment for a new client or model yet. Pick one of the suite's own client and model pairs, or add the pair in suite settings.",
      );
    }
    const results = (await convex.mutation(
      "projectEnvironments:deriveEnvironments" as any,
      {
        projectId: args.projectId,
        derivations: derivations.map((plan) => ({
          sourceEnvironmentId: plan.source.environmentId,
          expectedRevision: plan.source.revision,
          overrides: plan.overrides,
        })),
      },
    )) as Array<{ environment?: { environmentId?: string } }> | null;
    derivations.forEach((plan, index) => {
      const environmentId = results?.[index]?.environment?.environmentId;
      if (!environmentId) {
        throw new Error(
          "Could not prepare an environment for the selected client and model. Try again.",
        );
      }
      resolved.set(plan.key, environmentId);
    });
  }
  return resolved;
}

type ResolvedLaunchServers = {
  servers?: Array<{ serverId: string; name?: string }>;
  effectiveServerIds?: string[];
  selectedServerIds?: string[];
} | null;

/**
 * LOCAL (self-hosted) inspector only: connect every server the resolved
 * environments run before a quick run of them.
 *
 * The hosted single-case routes build an authorized per-request manager from
 * the environment itself. The local `/api/mcp` routes run on the shared
 * connection pool, which they look servers up in by name and never connect
 * into — so an environment server the user had not connected by hand made the
 * run fail as "not connected". This is the same pre-run connect a legacy
 * suite's quick run does, fed from the environment's eval resolution (the
 * query the run route itself asserts against) instead of the suite's legacy
 * server list.
 *
 * Returns the readiness that blocks the run, or null when it may go ahead.
 * Deliberately NOT blockers, because the run route answers them precisely:
 *  - an environment that fails to resolve here (the route resolves it again
 *    and reports the exact ENV_* refusal);
 *  - a server the local pool does not know. The resolution already dropped
 *    deleted servers, so an unknown one is a plugin-contributed server the
 *    local pool cannot hold, and "no longer in this project" would be false.
 */
export async function ensureLocalEnvironmentServers(args: {
  convex: ConvexLike;
  projectId: string;
  environmentIds: Iterable<string>;
  ensureServersReady: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
}): Promise<EnsureServersReadyResult | null> {
  const resolutions = await Promise.all(
    [...new Set(args.environmentIds)].map(
      (environmentId) =>
        args.convex
          .query("projectEnvironments:resolveEnvironmentForLaunch" as any, {
            projectId: args.projectId,
            environmentId,
            // The rule the run route resolves with: the environment's server
            // group and plugin pins, never its client's own servers.
            serverSource: "environment_only",
          })
          .catch(() => null) as Promise<ResolvedLaunchServers>,
    ),
  );
  const serverRefs = new Set<string>();
  for (const resolved of resolutions) {
    if (!resolved) continue;
    // The pool keys servers by display name, which is the ref the run route
    // falls back to; ids are for a backend that returns no names.
    const refs = Array.isArray(resolved.servers)
      ? resolved.servers.map((server) => server.name?.trim() || server.serverId)
      : (resolved.effectiveServerIds ?? resolved.selectedServerIds ?? []);
    for (const ref of refs) if (ref) serverRefs.add(ref);
  }
  if (serverRefs.size === 0) return null;
  const readiness = await args.ensureServersReady([...serverRefs]);
  return readiness.failedServerNames.length > 0 ||
    readiness.reauthServerNames.length > 0
    ? { ...readiness, missingServerNames: [] }
    : null;
}

/**
 * A case run from the suite's case list (row play button, sidebar, the
 * post-generate loop) — the editor-less entry point, resolved the same way.
 *
 * With a picked model it runs that model on the picked client (the suite's
 * first one when none is picked), on the server group the suite's
 * environments share. With no model picked it runs every environment of the
 * suite — on the picked client, when there is one — exactly as configured.
 */
export async function planEnvironmentSuiteCaseRun(
  convex: ConvexLike,
  args: {
    projectId: string;
    suite: { environmentIds?: readonly string[] | null };
    /** An editor-style `provider/model` value. */
    selectedModel: string | null;
    namedHostId?: string;
  },
): Promise<{
  targets: QuickRunTargetRequest[];
  plans: QuickRunTargetPlan[];
}> {
  const [environments, hosts] = await Promise.all([
    convex.query("projectEnvironments:listEnvironments" as any, {
      projectId: args.projectId,
      // Attached environments may be ad-hoc rows.
      origin: "all",
    }) as Promise<ProjectEnvironmentView[] | null>,
    (
      convex.query("hosts:listHosts" as any, {
        projectId: args.projectId,
      }) as Promise<Array<{ hostId: string; modelId?: string }> | null>
    ).catch(() => null),
  ]);
  const attached = attachedSuiteEnvironments(
    args.suite,
    environments ?? undefined,
  );
  if (!attached?.length) {
    throw new Error(
      "One of this suite's environments is archived or unavailable. Update the suite's clients in suite settings and try again.",
    );
  }
  const clientModelId = (hostId: string) =>
    hosts?.find((host) => host.hostId === hostId)?.modelId?.trim() || undefined;

  if (args.selectedModel) {
    const hostId =
      args.namedHostId &&
      attached.some((environment) => environment.hostId === args.namedHostId)
        ? args.namedHostId
        : quickRunClientIds(attached)[0]!;
    const modelId = parseModelValue(args.selectedModel).model || undefined;
    const target = {
      key: args.selectedModel,
      hostId,
      ...(modelId ? { modelId } : {}),
    };
    return {
      targets: [target],
      plans: planQuickRunTargets({
        attached,
        serverAttachmentId: defaultQuickRunServerGroup(attached),
        targets: [target],
        clientModelId,
      }),
    };
  }

  const onClient = args.namedHostId
    ? attached.filter((environment) => environment.hostId === args.namedHostId)
    : [];
  const pool = onClient.length ? onClient : attached;
  const seen = new Map<string, number>();
  const targets: QuickRunTargetRequest[] = [];
  const plans: QuickRunTargetPlan[] = [];
  for (const environment of pool) {
    // Keyed by the model it runs (what the run toasts and analytics name),
    // disambiguated when two environments run the same model.
    const model =
      environment.modelId ?? clientModelId(environment.hostId) ?? "default";
    const count = (seen.get(model) ?? 0) + 1;
    seen.set(model, count);
    const key = count === 1 ? model : `${model} (${count})`;
    targets.push({
      key,
      hostId: environment.hostId,
      ...(environment.modelId ? { modelId: environment.modelId } : {}),
    });
    plans.push(
      lacksServerSource(environment)
        ? {
            kind: "blocked",
            key,
            reason:
              "One of this suite's environments has no server group, so it would run with no servers. Pick a server group in suite settings.",
          }
        : { kind: "reuse", key, environmentId: environment.environmentId },
    );
  }
  return { targets, plans };
}
