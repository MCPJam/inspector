/**
 * Composition state shared by every surface that picks where a run executes
 * (Swarms journeys, Eval suites, User Testing scenarios).
 *
 * Two layers, and the relationship between them is the whole feature:
 *
 *  - `environmentIds` — SAVED project environments the user picked from the
 *    Environments list. Curated, named, reusable.
 *  - `stack` — the loose slots a saved environment is made of (clients, server
 *    group, pinned skills, sandbox image), editable in place so "same setup,
 *    different client" costs one click instead of a trip to /environments.
 *
 * Selecting a saved environment SEEDS the stack from it; editing any slot flips
 * `customized`. That flag is what tells a surface it can no longer just hand
 * `environmentIds` to the backend and must resolve the stack into real
 * environment rows first.
 *
 * Model is a designed next axis (it lives on the client) but out of v1 wiring —
 * no surface passes a modelId today. Keep the field as an extension point only.
 */
import type {
  ProjectEnvironmentSkillSelection,
  ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { isNamedEnvironment } from "@/lib/environment-label";

export type EnvironmentStack = {
  /** Primary fan-out axis. Required for the compose (resolve) path. */
  hostIds: string[];
  /** Optional; null/empty = each client's own server picks. */
  serverAttachmentId: string | null;
  skillSelection: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId: string | null;
  /**
   * Reserved for a future model axis. Do not wire a picker in v1.
   * Callers must leave this unset.
   */
  modelId?: undefined;
};

export type EnvironmentComposerState = {
  /** Selected saved environment ids. Cap: the surface's `maxTargets`. */
  environmentIds: string[];
  stack: EnvironmentStack;
  /**
   * True once the user edits the stack after (or without) seeding from saved
   * environments. A pure saved-environment selection keeps this false and skips
   * resolution entirely.
   */
  customized: boolean;
};

export function emptyEnvironmentStack(): EnvironmentStack {
  return {
    hostIds: [],
    serverAttachmentId: null,
    skillSelection: null,
    computerEnvironmentId: null,
  };
}

export function emptyComposerState(): EnvironmentComposerState {
  return {
    environmentIds: [],
    stack: emptyEnvironmentStack(),
    customized: false,
  };
}

/** The slots of a saved environment, as a loose stack the user can now edit. */
export function stackFromEnvironment(
  env: ProjectEnvironmentView
): EnvironmentStack {
  return {
    hostIds: env.hostId ? [env.hostId] : [],
    serverAttachmentId: env.serverAttachmentId ?? null,
    skillSelection: env.skillSelection ?? null,
    computerEnvironmentId: env.computerEnvironmentId ?? null,
  };
}

/**
 * Composer state for a surface whose `environmentIds` are already PERSISTED.
 *
 * The stack is what the selection has in common: every attached environment's
 * client, plus the shared slots when all of them agree. When they disagree the
 * slot reads empty rather than picking a winner — editing another slot would
 * otherwise silently impose one environment's server group on the rest.
 *
 * Ad-hoc rows seed as a COMPOSITION, not a selection: they are deliberately not
 * offerable in the saved-environment picker, so presenting them there would
 * render a row of identical, undetachable "Automatic environment" chips. Their
 * stack is the honest description of them.
 */
export function composerStateFromEnvironments(
  environments: ProjectEnvironmentView[]
): EnvironmentComposerState {
  const hostIds: string[] = [];
  for (const env of environments) {
    if (env.hostId && !hostIds.includes(env.hostId)) hostIds.push(env.hostId);
  }
  const first = environments[0];
  const shared =
    first &&
    environments.every((env) =>
      stackFieldsEqual(
        {
          serverAttachmentId: env.serverAttachmentId ?? null,
          skillSelection: env.skillSelection ?? null,
          computerEnvironmentId: env.computerEnvironmentId ?? null,
        },
        {
          serverAttachmentId: first.serverAttachmentId ?? null,
          skillSelection: first.skillSelection ?? null,
          computerEnvironmentId: first.computerEnvironmentId ?? null,
        }
      )
    )
      ? first
      : undefined;

  const allNamed = environments.length > 0 && environments.every(isNamedEnvironment);
  return {
    environmentIds: allNamed ? environments.map((e) => e.environmentId) : [],
    stack: {
      hostIds,
      serverAttachmentId: shared?.serverAttachmentId ?? null,
      skillSelection: shared?.skillSelection ?? null,
      computerEnvironmentId: shared?.computerEnvironmentId ?? null,
    },
    customized: !allNamed,
  };
}

/** Compose path: customized with clients, or clients-only with no selection. */
export function isComposeMode(state: EnvironmentComposerState): boolean {
  if (state.environmentIds.length === 0) return state.stack.hostIds.length > 0;
  return state.customized;
}

/** Count used for intensity / session estimates before resolution. */
export function composerTargetCount(state: EnvironmentComposerState): number {
  if (isComposeMode(state)) return state.stack.hostIds.length;
  return state.environmentIds.length;
}

export function sameSkillSelection(
  a: ProjectEnvironmentSkillSelection | null | undefined,
  b: ProjectEnvironmentSkillSelection | null | undefined
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right;
  if (left.skillIds.length !== right.skillIds.length) return false;
  return left.skillIds.every((id, i) => id === right.skillIds[i]);
}

export function stackFieldsEqual(
  a: Pick<
    EnvironmentStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >,
  b: Pick<
    EnvironmentStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >
): boolean {
  return (
    (a.serverAttachmentId ?? null) === (b.serverAttachmentId ?? null) &&
    (a.computerEnvironmentId ?? null) === (b.computerEnvironmentId ?? null) &&
    sameSkillSelection(a.skillSelection, b.skillSelection)
  );
}
