/**
 * Castle + lego composition types for New Swarm Shared setup.
 *
 * Castle = a saved project environment (or tentative draft).
 * Legos = the stack slots that fan out across clients on materialize.
 *
 * Model is a designed next axis (lives on the client) but out of v1 wiring —
 * swarm launch has no modelId today. Keep the field as an extension point only.
 */
import type { ProjectEnvironmentSkillSelection } from "@/hooks/useProjectEnvironments";

export type SwarmLegoStack = {
  /** Primary fan-out axis. Required for the compose (materialize) path. */
  hostIds: string[];
  /** Optional; null/empty = each client's own server picks. */
  serverAttachmentId: string | null;
  skillSelection: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId: string | null;
  /**
   * Reserved for a future persona-run model axis. Do not wire a picker in v1.
   * Callers must leave this unset.
   */
  modelId?: undefined;
};

export type SwarmTargetComposerState = {
  /** Selected saved environment ids (castles). Cap: MAX_ENVIRONMENTS_PER_JOURNEY. */
  castleIds: string[];
  legos: SwarmLegoStack;
  /**
   * True once the user edits the lego strip after (or without) seeding from
   * castles. Pure castle multi-select keeps this false and skips materialize.
   */
  customized: boolean;
};

export function emptySwarmLegoStack(): SwarmLegoStack {
  return {
    hostIds: [],
    serverAttachmentId: null,
    skillSelection: null,
    computerEnvironmentId: null,
  };
}

export function emptySwarmTargetComposerState(): SwarmTargetComposerState {
  return {
    castleIds: [],
    legos: emptySwarmLegoStack(),
    customized: false,
  };
}

/** Compose path: customized with clients, or clients-only with no castles. */
export function isSwarmComposeMode(state: SwarmTargetComposerState): boolean {
  if (state.castleIds.length === 0) return state.legos.hostIds.length > 0;
  return state.customized;
}

/** Count used for intensity / session estimates before materialize. */
export function swarmTargetCount(state: SwarmTargetComposerState): number {
  if (isSwarmComposeMode(state)) return state.legos.hostIds.length;
  return state.castleIds.length;
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
    SwarmLegoStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >,
  b: Pick<
    SwarmLegoStack,
    "serverAttachmentId" | "skillSelection" | "computerEnvironmentId"
  >
): boolean {
  return (
    (a.serverAttachmentId ?? null) === (b.serverAttachmentId ?? null) &&
    (a.computerEnvironmentId ?? null) === (b.computerEnvironmentId ?? null) &&
    sameSkillSelection(a.skillSelection, b.skillSelection)
  );
}
