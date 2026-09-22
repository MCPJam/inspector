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
  sameOptionalModel,
  stackFieldsEqual,
  type EnvironmentStack,
} from "@/components/environment-composer/environment-stack";
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
  legos: EnvironmentStack;
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

/**
 * Live (non-archived) env matching host + shared stack fields.
 *
 * A row carrying a model OVERRIDE never matches. The swarm strip has no model
 * slot, so its composition always means "inherit the client's model" — and
 * absent is a real choice here, not a wildcard. Reusing an overridden row
 * because the other slots line up would run the swarm on a model nobody
 * selected on this screen, under a name that says nothing about it.
 */
export function findMatchingLiveEnvironment(
  hostId: string,
  stack: Pick<
    EnvironmentStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >,
  liveEnvironments: ProjectEnvironmentView[]
): ProjectEnvironmentView | undefined {
  return liveEnvironments.find(
    (env) =>
      !env.archivedAt &&
      env.hostId === hostId &&
      sameOptionalModel(env.modelId, undefined) &&
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

/**
 * Mirror of `NAME_MAX_LENGTH` in the backend's `convex/projectEnvironments.ts`.
 * The stack half of an auto-name is the user's whole Describe paragraph, so
 * without a client-side clamp the mutation rejects and the entire launch dies
 * on a name — a field the user never typed.
 */
export const ENVIRONMENT_NAME_MAX_LENGTH = 100;

/** Bound on ` (2)`, ` (3)`… before we stop guessing and surface the collision. */
const MAX_NAME_UNIQUIFY_ATTEMPTS = 20;

/** Bounded re-tries when the backend rejects a name our preflight thought free. */
const MAX_NAME_CONFLICT_RETRIES = 3;

/**
 * `${stack} · ${client}${suffix}`, clamped to the backend's cap.
 *
 * Only the STACK half is truncated: the client name and the uniquifying suffix
 * are what make the row identifiable in the Environments list, so they are
 * preserved whole and the paragraph gives way. Names that already fit come
 * back byte-identical.
 */
function composeEnvironmentName(
  stackName: string,
  clientName: string,
  suffix = ""
): string {
  const stack = stackName.trim() || "Swarm setup";
  const client = clientName.trim() || "Client";
  const tail = ` · ${client}${suffix}`;
  // A client name that alone fills the budget leaves no room to be clever —
  // clamp the whole string rather than emit a name with an empty stack half.
  if (tail.length >= ENVIRONMENT_NAME_MAX_LENGTH) {
    return `${stack}${tail}`.slice(0, ENVIRONMENT_NAME_MAX_LENGTH);
  }
  const room = ENVIRONMENT_NAME_MAX_LENGTH - tail.length;
  return `${stack.slice(0, room).trimEnd()}${tail}`;
}

/**
 * First name in the ` (2)`, ` (3)`… series that no LIVE environment holds.
 *
 * Backend name uniqueness is per-project across live rows, so composing two
 * different stacks under one Describe paragraph would otherwise collide and
 * fail the launch. The suffix is never truncated — it re-enters
 * `composeEnvironmentName`, which gives the stack half back instead.
 */
function uniqueEnvironmentName(
  stackName: string,
  clientName: string,
  taken: ReadonlySet<string>
): string {
  const base = composeEnvironmentName(stackName, clientName);
  if (!taken.has(base)) return base;
  for (let n = 2; n <= MAX_NAME_UNIQUIFY_ATTEMPTS; n += 1) {
    const candidate = composeEnvironmentName(stackName, clientName, ` (${n})`);
    if (!taken.has(candidate)) return candidate;
  }
  throw new SwarmTargetMaterializeError(
    `Too many environments already named like "${base}". Rename some in Environments, or pick saved environments instead.`
  );
}

/** The backend's own sentence, when it sent one. */
function backendErrorMessage(err: unknown): string | undefined {
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data === "string" && data) return data;
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  if (err instanceof Error && err.message) return err.message;
  return undefined;
}

/**
 * `assertNameAvailable` rejected the name. Our preflight only sees the
 * environments this client has loaded, so a teammate's row (or one created
 * between load and write) still races through.
 */
function isEnvironmentNameConflict(err: unknown): boolean {
  const data = (err as { data?: unknown } | null)?.data;
  const code =
    data && typeof data === "object"
      ? (data as { code?: unknown }).code
      : undefined;
  if (code === "CONFLICT") return true;
  return /already exists/i.test(backendErrorMessage(err) ?? "");
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
      `At most ${MAX_ENVIRONMENTS_PER_JOURNEY} environments per goal.`
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
  // Names the backend would reject. Seeded from the live rows this client can
  // see and grown with every row we create, so two clients in one batch can't
  // pick the same auto-name.
  const takenNames = new Set(
    working.flatMap((e) => (e.name === undefined ? [] : [e.name]))
  );
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

    const client = hostName(hostId);
    let created: ProjectEnvironmentView | undefined;
    for (let attempt = 0; attempt <= MAX_NAME_CONFLICT_RETRIES; attempt += 1) {
      const name = uniqueEnvironmentName(stackName, client, takenNames);
      try {
        created = await createEnvironment({
          projectId,
          name,
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
        break;
      } catch (err) {
        // Someone else holds this name. Record it and let the uniquifier move
        // to the next suffix; anything else is a real failure the user needs
        // to read, not a generic "could not resolve environments".
        if (attempt < MAX_NAME_CONFLICT_RETRIES && isEnvironmentNameConflict(err)) {
          takenNames.add(name);
          continue;
        }
        throw new SwarmTargetMaterializeError(
          backendErrorMessage(err) ??
            `Could not create an environment for ${client}.`
        );
      }
    }
    // Unreachable: the loop either breaks with a row or throws.
    if (!created) {
      throw new SwarmTargetMaterializeError(
        `Could not create an environment for ${client}.`
      );
    }
    working.push(created);
    if (created.name !== undefined) takenNames.add(created.name);
    environmentIds.push(created.environmentId);
    environments.push(created);
    createdIds.push(created.environmentId);
  }

  if (environmentIds.length > MAX_ENVIRONMENTS_PER_JOURNEY) {
    throw new SwarmTargetMaterializeError(
      `At most ${MAX_ENVIRONMENTS_PER_JOURNEY} environments per goal.`
    );
  }

  return { environmentIds, environments, createdIds, reusedIds };
}

/** Materialize (if needed) then build the journey env payload. */
export async function resolveSwarmJourneyPayload(args: {
  compose: boolean;
  castleIds: string[];
  legos: EnvironmentStack;
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
