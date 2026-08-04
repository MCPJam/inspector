/**
 * Materialize a lego composition into resolvable project environment ids.
 *
 * Launch still requires real `environmentIds` + compat `hostIds` via
 * `buildEnvJourneyPayload` — never unsaved inline journey specs.
 */
import {
  buildEnvJourneyPayload,
  MAX_ENVIRONMENTS_PER_JOURNEY,
} from "@/components/swarms/journey-environments";
import {
  stackFieldsEqual,
  type SwarmLegoStack,
} from "@/components/swarms/swarm-target-types";
import type {
  ProjectEnvironmentSkillSelection,
  ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";

export type CreateProjectEnvironmentFn = (args: {
  projectId: string;
  name: string;
  hostId: string;
  serverAttachmentId?: string | null;
  skillSelection?: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId?: string;
}) => Promise<ProjectEnvironmentView>;

export type MaterializeSwarmTargetsArgs = {
  projectId: string;
  /** Draft / stack name prefix → `{stackName} · {clientName}`. */
  stackName: string;
  legos: SwarmLegoStack;
  /** Host id → display name for auto-naming. Missing → truncated id. */
  hostName: (hostId: string) => string;
  liveEnvironments: ProjectEnvironmentView[];
  createEnvironment: CreateProjectEnvironmentFn;
  skillsEnabled: boolean;
  computersEnabled: boolean;
};

export type MaterializeSwarmTargetsResult = {
  environmentIds: string[];
  /** Ordered views (reused + newly created) for buildEnvJourneyPayload. */
  environments: ProjectEnvironmentView[];
  createdIds: string[];
  reusedIds: string[];
};

export class SwarmTargetMaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmTargetMaterializeError";
  }
}

/** Live (non-archived) env matching host + shared stack fields. */
export function findMatchingLiveEnvironment(
  hostId: string,
  stack: Pick<
    SwarmLegoStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >,
  liveEnvironments: ProjectEnvironmentView[]
): ProjectEnvironmentView | undefined {
  return liveEnvironments.find(
    (env) =>
      !env.archivedAt &&
      env.hostId === hostId &&
      stackFieldsEqual(
        {
          serverAttachmentId: env.serverAttachmentId ?? null,
          skillSelection: env.skillSelection ?? null,
          computerEnvironmentId: env.computerEnvironmentId ?? null,
        },
        stack
      )
  );
}

function autoEnvironmentName(stackName: string, clientName: string): string {
  const stack = stackName.trim() || "Swarm setup";
  const client = clientName.trim() || "Client";
  return `${stack} · ${client}`;
}

/**
 * For each selected client: reuse a matching live env or create one with the
 * shared stack. Caps at MAX_ENVIRONMENTS_PER_JOURNEY. Returns ordered ids +
 * views suitable for `buildEnvJourneyPayload`.
 */
export async function materializeSwarmTargets(
  args: MaterializeSwarmTargetsArgs
): Promise<MaterializeSwarmTargetsResult> {
  const {
    projectId,
    stackName,
    legos,
    hostName,
    createEnvironment,
    skillsEnabled,
    computersEnabled,
  } = args;

  const hostIds = [...new Set(legos.hostIds.filter(Boolean))];
  if (hostIds.length === 0) {
    throw new SwarmTargetMaterializeError(
      "Pick at least one client to compose targets."
    );
  }
  if (hostIds.length > MAX_ENVIRONMENTS_PER_JOURNEY) {
    throw new SwarmTargetMaterializeError(
      `At most ${MAX_ENVIRONMENTS_PER_JOURNEY} environments per journey.`
    );
  }

  const stack = {
    serverAttachmentId: legos.serverAttachmentId ?? null,
    skillSelection: skillsEnabled ? (legos.skillSelection ?? null) : null,
    computerEnvironmentId: computersEnabled
      ? (legos.computerEnvironmentId ?? null)
      : null,
  };

  // Working list grows with creates so later clients in the same batch can
  // reuse an env created earlier for a duplicate host id (shouldn't happen
  // after Set, but keeps match consistent with freshly written rows).
  const working = args.liveEnvironments.filter((e) => !e.archivedAt);
  const environmentIds: string[] = [];
  const environments: ProjectEnvironmentView[] = [];
  const createdIds: string[] = [];
  const reusedIds: string[] = [];

  for (const hostId of hostIds) {
    const match = findMatchingLiveEnvironment(hostId, stack, working);
    if (match) {
      environmentIds.push(match.environmentId);
      environments.push(match);
      reusedIds.push(match.environmentId);
      continue;
    }

    const created = await createEnvironment({
      projectId,
      name: autoEnvironmentName(stackName, hostName(hostId)),
      hostId,
      ...(stack.serverAttachmentId
        ? { serverAttachmentId: stack.serverAttachmentId }
        : {}),
      ...(skillsEnabled && stack.skillSelection
        ? { skillSelection: stack.skillSelection }
        : {}),
      ...(computersEnabled && stack.computerEnvironmentId
        ? { computerEnvironmentId: stack.computerEnvironmentId }
        : {}),
    });
    working.push(created);
    environmentIds.push(created.environmentId);
    environments.push(created);
    createdIds.push(created.environmentId);
  }

  if (environmentIds.length > MAX_ENVIRONMENTS_PER_JOURNEY) {
    throw new SwarmTargetMaterializeError(
      `At most ${MAX_ENVIRONMENTS_PER_JOURNEY} environments per journey.`
    );
  }

  return { environmentIds, environments, createdIds, reusedIds };
}

/** Materialize (if needed) then build the journey env payload. */
export async function resolveSwarmJourneyPayload(args: {
  compose: boolean;
  castleIds: string[];
  legos: SwarmLegoStack;
  liveEnvironments: ProjectEnvironmentView[];
  materialize: MaterializeSwarmTargetsArgs;
}): Promise<{
  environmentIds: string[];
  hostIds: string[];
  environments: ProjectEnvironmentView[];
  materialized: MaterializeSwarmTargetsResult | null;
} | null> {
  if (!args.compose) {
    const payload = buildEnvJourneyPayload(
      args.castleIds,
      args.liveEnvironments
    );
    if (!payload) return null;
    return {
      ...payload,
      environments: args.liveEnvironments,
      materialized: null,
    };
  }

  const materialized = await materializeSwarmTargets(args.materialize);
  const payload = buildEnvJourneyPayload(
    materialized.environmentIds,
    materialized.environments
  );
  if (!payload) return null;
  return {
    ...payload,
    environments: materialized.environments,
    materialized,
  };
}
