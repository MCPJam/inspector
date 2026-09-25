/**
 * ENVIRONMENT quick runs — the case editor's Run executing an environment.
 *
 * A quick run on an environment suite used to read the suite's LEGACY fields
 * (its own server list and host config) and ignore its environments, which is
 * how a single case could pass while Start run failed. This module is the
 * inspector half of the fix. The contract, in order:
 *
 *   1. PREFLIGHT — the route resolves the environment eval-only
 *      (`resolveEnvironmentForLaunch`, `EVAL_LAUNCH_SERVER_SOURCE`) before it
 *      connects anything, and connects exactly that closed server set as the
 *      environment's client. Anything a quick run cannot honor (a sandbox
 *      image) is refused here, before a row exists.
 *   2. COMMIT — `testSuites:startQuickRunIterations` reserves, inserts and
 *      pins EVERY attempt in one backend transaction, re-checking the
 *      preflight (revision, host config, server set) and the admission rules.
 *      It returns the committed iteration ids and the frozen execution: model,
 *      provider, host config, plugin provenance. Any failure throws here, with
 *      no row written and nothing executed.
 *   3. VALIDATE — the committed execution must describe what the preflight
 *      connected. A mismatch (deploy skew, a backend that ignored the
 *      environment) fails closed rather than running something else.
 *   4. FREEZE SKILLS — the committed pins (never the live skills) and the
 *      live re-gate of pinned plugin versions become the runner's frozen
 *      skill channels. From here on a failure marks the committed rows failed.
 *   5. EXECUTE — the runner runs the committed ids and creates no row of its
 *      own.
 */
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { logger } from "../../utils/logger.js";
import {
  environmentEffectiveServerIds,
  environmentLaunchConflictError,
  environmentLaunchRejectionError,
  environmentModelRequiredError,
  isEnvironmentLaunchConflict,
  translateEnvironmentResolveError,
  type ResolvedEnvironmentForLaunch,
} from "../environments/resolve.js";
import { resolveQuickRunPluginServers } from "../plugins/run-plugin-servers.js";
import { asBillingRouteError } from "./recorder.js";
import {
  buildPinnedSkillSource,
  type BuiltPinnedSkillSource,
} from "./pinned-skill-source.js";
import type {
  RunPinnedPluginVersion,
  RunPinnedSkill,
} from "./run-plugin-snapshot.js";

/** What the backend committed for an environment quick run. */
export type QuickRunExecution = {
  environmentRef: { environmentId: string; name: string; revision: number };
  hostId: string;
  /** The frozen run-level host config the runner executes with. */
  hostConfig: Record<string, unknown>;
  /** The iteration's own config (case overlays applied); absent model-free. */
  hostConfigId?: string;
  model: string;
  provider: string;
  modelSource: "environment" | "host";
  selectedServerIds: string[];
  pluginServerIds: string[];
  effectiveServerIds: string[];
  pluginVersions: RunPinnedPluginVersion[];
  pinnedSkillCount: number;
};

export type CommittedQuickRun = {
  iterationIds: string[];
  execution: QuickRunExecution;
  /**
   * True when the backend recognized the idempotency key: these iterations
   * were committed by an EARLIER request, which is executing (or executed)
   * them. The caller must not execute them again.
   */
  replayed: boolean;
};

/** The request fields an environment quick run owns and a caller may not set. */
export type EnvironmentQuickRunRequestFields = {
  environmentId?: string;
  projectId?: string;
  model?: string;
  provider?: string;
  namedHostId?: string;
  hostConfigOverride?: unknown;
  serverIds?: string[];
};

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = sortedUnique(a);
  const right = sortedUnique(b);
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Refuse a request that names an environment AND tries to set what the
 * environment owns. The environment decides the model, the client, the
 * servers and the client configuration; a quick run edits case CONTENT only.
 *
 * A redundant legacy field that MATCHES the resolution (an older client
 * echoing the environment's model, or its servers) is accepted and ignored —
 * never forwarded to execution. Anything that differs is a 400, not a silent
 * pick of one or the other.
 */
export function assertNoConflictingEnvironmentOverrides(
  request: EnvironmentQuickRunRequestFields,
  resolved?: ResolvedEnvironmentForLaunch,
): void {
  const conflict = (field: string, detail: string) =>
    new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `This quick run names an environment, which decides its ${detail}; remove \`${field}\` from the request.`,
      { reason: "ENVIRONMENT_OVERRIDE_CONFLICT", field },
    );
  if (!request.projectId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "projectId is required for environment quick runs",
    );
  }
  if (request.hostConfigOverride !== undefined) {
    throw conflict("hostConfigOverride", "client configuration");
  }
  if (!resolved) return;
  if (request.namedHostId && request.namedHostId !== resolved.hostId) {
    throw conflict("namedHostId", "client");
  }
  if (
    request.model &&
    resolved.effectiveModelId &&
    request.model.trim() !== resolved.effectiveModelId.trim()
  ) {
    throw conflict("model", "model");
  }
  const requestedServers = request.serverIds ?? [];
  if (
    requestedServers.length > 0 &&
    !sameIdSet(requestedServers, environmentEffectiveServerIds(resolved)) &&
    !sameIdSet(
      requestedServers,
      (resolved.servers ?? []).map((server) => server.serverId),
    )
  ) {
    throw conflict("serverIds", "servers");
  }
}

/**
 * Refuse, before any row exists, an environment a quick run cannot honor. The
 * backend commit enforces the same rules (and the secret-delivery one, which
 * only it can see); this answers early with the reason.
 */
export function assertEnvironmentQuickRunAdmissible(
  resolved: ResolvedEnvironmentForLaunch,
): void {
  if (resolved.computerEnvironmentId) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `Environment "${resolved.environmentRef.name}" pins a sandbox image, and a quick run does not boot one. Use Start run to run this case in its image.`,
      {
        code: "ENV_QUICK_RUN_UNSUPPORTED",
        reason: "sandbox_image",
        environmentId: resolved.environmentRef.environmentId,
      },
    );
  }
}

/**
 * Map a commit rejection onto the route envelope. Every refusal here happens
 * BEFORE anything was reserved or written, so each is the caller's to act on:
 * drift is a 409 to retry, admission a 409 naming the reason, a cap a 402.
 */
export function translateQuickRunCommitError(error: unknown): unknown {
  if (error instanceof WebRouteError) return error;
  const billing = asBillingRouteError(error);
  if (billing) return billing;
  if (isEnvironmentLaunchConflict(error)) {
    return environmentLaunchConflictError(error);
  }
  const modelRequired = environmentModelRequiredError(error);
  if (modelRequired) return modelRequired;
  const rejection = environmentLaunchRejectionError(error);
  if (rejection) return rejection;
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const { code, message } = data as { code?: unknown; message?: unknown };
    if (code === "IDEMPOTENCY_CONFLICT") {
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        typeof message === "string"
          ? message
          : "This idempotency key was already used for a different quick run.",
        { code },
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /could not find public function/i.test(message) ||
    /extra field [`'"]?environment/i.test(message)
  ) {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This deployment cannot run environment quick runs yet. Retry after the backend deploys.",
      { reason: "ENVIRONMENT_QUICK_RUN_UNAVAILABLE" },
    );
  }
  return translateEnvironmentResolveError(error);
}

function isQuickRunExecution(value: unknown): value is QuickRunExecution {
  const candidate = value as Partial<QuickRunExecution> | null | undefined;
  return (
    !!candidate &&
    typeof candidate.model === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.hostId === "string" &&
    !!candidate.environmentRef &&
    typeof candidate.environmentRef.revision === "number" &&
    !!candidate.hostConfig &&
    typeof candidate.hostConfig === "object" &&
    Array.isArray(candidate.selectedServerIds) &&
    Array.isArray(candidate.effectiveServerIds) &&
    Array.isArray(candidate.pluginServerIds) &&
    Array.isArray(candidate.pluginVersions)
  );
}

/**
 * Step 2: commit every attempt in one backend transaction, echoing the
 * preflight so the backend refuses anything that moved since.
 */
export async function commitEnvironmentQuickRun(
  convexClient: Pick<ConvexHttpClient, "action">,
  args: {
    testCaseId: string;
    testCaseSnapshot: Record<string, unknown>;
    count: number;
    startedAt: number;
    resolved: ResolvedEnvironmentForLaunch;
    idempotencyKey: string;
  },
): Promise<CommittedQuickRun> {
  let raw: unknown;
  try {
    raw = await convexClient.action(
      "testSuites:startQuickRunIterations" as any,
      {
        testCaseId: args.testCaseId,
        testCaseSnapshot: args.testCaseSnapshot,
        count: args.count,
        startedAt: args.startedAt,
        environment: {
          environmentId: args.resolved.environmentRef.environmentId,
          expectedRevision: args.resolved.environmentRef.revision,
          ...(args.resolved.hostConfigId
            ? { expectedHostConfigId: args.resolved.hostConfigId }
            : {}),
          expectedServerIds: environmentEffectiveServerIds(args.resolved),
        },
        idempotencyKey: args.idempotencyKey,
      },
    );
  } catch (error) {
    throw translateQuickRunCommitError(error);
  }
  const response = raw as {
    iterationIds?: unknown;
    execution?: unknown;
    replayed?: unknown;
  } | null;
  const iterationIds = Array.isArray(response?.iterationIds)
    ? response!.iterationIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  if (
    iterationIds.length !== args.count ||
    !isQuickRunExecution(response?.execution)
  ) {
    // A backend that accepted the call but froze no environment would run
    // the case on whatever it resolved itself. Fail closed instead.
    throw new WebRouteError(
      502,
      ErrorCode.INTERNAL_ERROR,
      "The backend did not return a committed environment for this quick run, so it was not executed. Retry after the backend deploys.",
      { reason: "ENVIRONMENT_QUICK_RUN_UNCOMMITTED" },
    );
  }
  return {
    iterationIds,
    execution: response!.execution as QuickRunExecution,
    replayed: response?.replayed === true,
  };
}

/**
 * Step 3: the committed execution must be the one the preflight prepared —
 * same environment revision, same client, same server set. The backend
 * enforces this on commit; checking it here too means a deploy-skewed or
 * misbehaving backend can never make the runner execute inputs the connected
 * manager does not match.
 */
export function assertCommittedExecutionMatchesPreflight(
  resolved: ResolvedEnvironmentForLaunch,
  execution: QuickRunExecution,
): void {
  const mismatches: string[] = [];
  if (
    execution.environmentRef.environmentId !==
    resolved.environmentRef.environmentId
  ) {
    mismatches.push("environment");
  }
  if (execution.environmentRef.revision !== resolved.environmentRef.revision) {
    mismatches.push("revision");
  }
  if (execution.hostId !== resolved.hostId) mismatches.push("client");
  if (
    !sameIdSet(
      execution.effectiveServerIds,
      environmentEffectiveServerIds(resolved),
    )
  ) {
    mismatches.push("servers");
  }
  if (mismatches.length > 0) {
    throw new WebRouteError(
      409,
      ErrorCode.ENVIRONMENT_REVISION_CONFLICT,
      `This environment changed while the quick run was being prepared (${mismatches.join(
        ", ",
      )}) — run it again.`,
      { reason: "ENVIRONMENT_QUICK_RUN_DRIFT", mismatches },
    );
  }
}

const PINNED_SKILLS_RETRY_DELAYS_MS = [250, 1000] as const;

/**
 * The committed pins, content joined. Retried like the suite-run fetch; a
 * persistent failure throws rather than running without the environment's
 * skills. `[]` is a real answer (the environment pins none) and never falls
 * back to live skills.
 */
export async function fetchQuickRunPinnedSkills(
  convexClient: { query: (name: any, ...args: any[]) => Promise<any> },
  iterationId: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RunPinnedSkill[]> {
  const attempts = PINNED_SKILLS_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = (await convexClient.query(
        "testSuites:getQuickRunPinnedSkills" as any,
        { iterationId },
      )) as { pinnedSkills?: RunPinnedSkill[] } | null;
      if (!res || !Array.isArray(res.pinnedSkills)) {
        // `null` is the backend saying this is not an environment iteration
        // — impossible for ids it just committed as one. Not retryable.
        throw new WebRouteError(
          502,
          ErrorCode.INTERNAL_ERROR,
          "This quick run's committed skills could not be read, so it was not executed. Run it again.",
          { reason: "ENVIRONMENT_QUICK_RUN_UNCOMMITTED" },
        );
      }
      return res.pinnedSkills;
    } catch (error) {
      if (error instanceof WebRouteError) throw error;
      logger.warn("[evals] getQuickRunPinnedSkills failed", {
        iterationId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < PINNED_SKILLS_RETRY_DELAYS_MS.length) {
        await sleep(PINNED_SKILLS_RETRY_DELAYS_MS[attempt]!);
      }
    }
  }
  throw new Error(
    `Failed to load this quick run's pinned skills after ${attempts} attempts — ` +
      "stopping so the case doesn't silently run without its environment's skills. " +
      "Run it again.",
  );
}

/**
 * Step 4: the committed pins and the live re-gate of the committed plugin
 * versions, as the runner's frozen skill channels. The pins come from the
 * FIRST committed iteration: every attempt of one commit froze the same set.
 */
export async function loadCommittedQuickRunSkills(
  convexClient: ConvexHttpClient,
  args: {
    committed: CommittedQuickRun;
    effectiveServerIds: readonly string[];
    serverNames?: readonly string[];
  },
): Promise<BuiltPinnedSkillSource> {
  const firstIterationId = args.committed.iterationIds[0]!;
  const pins = await fetchQuickRunPinnedSkills(convexClient, firstIterationId);
  if (pins.length !== args.committed.execution.pinnedSkillCount) {
    throw new WebRouteError(
      502,
      ErrorCode.INTERNAL_ERROR,
      `This quick run committed ${args.committed.execution.pinnedSkillCount} skill pin(s) but ${pins.length} could be read, so it was not executed. Run it again.`,
      { reason: "ENVIRONMENT_QUICK_RUN_UNCOMMITTED" },
    );
  }
  const pluginServers = await resolveQuickRunPluginServers(() => convexClient, {
    iterationId: firstIterationId,
  });
  return await buildPinnedSkillSource({
    pins,
    pluginVersions: args.committed.execution.pluginVersions,
    pluginServers,
    effectiveServerIds: args.effectiveServerIds,
    ...(args.serverNames ? { serverNames: args.serverNames } : {}),
  });
}

/**
 * A committed quick run that cannot start (setup failed after the commit):
 * every committed row is finalized `setup_failed` so none is left running,
 * and the backend settles the batch's reservation by its usual rule once the
 * last attempt is terminal. Best-effort per row; the original failure is what
 * the caller reports.
 */
export async function failCommittedQuickRun(
  convexClient: Pick<ConvexHttpClient, "action">,
  iterationIds: readonly string[],
  reason: string,
): Promise<void> {
  const message = reason.slice(0, 500);
  await Promise.allSettled(
    iterationIds.map(async (iterationId) => {
      try {
        await convexClient.action("testSuites:updateTestIteration" as any, {
          iterationId,
          status: "setup_failed",
          result: "failed",
          actualToolCalls: [],
          tokensUsed: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          messages: [{ role: "assistant", content: message }],
          error: message,
          resultSource: "derived",
        });
      } catch (error) {
        logger.warn("[evals] Failed to mark committed quick run failed", {
          iterationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
