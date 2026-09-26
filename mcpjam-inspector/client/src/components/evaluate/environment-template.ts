/**
 * Which saved environment a NEW eval cell copies its setup from, and whether
 * the browser can copy it at all.
 *
 * A suite's "Where it runs" and the run dialog both add cells — a client, or a
 * model on a client — that have no environment yet. The cell has to run
 * somewhere, and everything except its client and model (server group,
 * skills, captured server skills, secrets, plugin pins, sandbox image) comes
 * from an existing environment: its TEMPLATE.
 *
 * Two ways that used to go wrong, and the rule each one now follows:
 *
 *  - The template was guessed. With no environment on the edited client the
 *    cell fell back to the suite's legacy `serverAttachmentId`, which an
 *    environment suite does not read — most old suites keep their servers
 *    somewhere else — so the new environment got no server group and every
 *    run connected nothing. With several different environments, the first
 *    one silently won. Now a template is either the one setup every candidate
 *    shares, or the edit is refused as ambiguous: the user has to pick.
 *
 *  - The template was copied lossily. The browser sees a REDACTED view of an
 *    environment (secret grants are filtered to what the viewer may see) and
 *    has no field for plugin pins or captured server skills in the ad-hoc
 *    composition it sends. Copying that view would drop those pins and still
 *    report success. Now such a template is refused by the browser; the
 *    backend's lossless derivation (which reads the source server-side) is
 *    the only path that may copy it.
 */
import type {
  ProjectEnvironmentView,
  ProjectEnvironmentSkillSelection,
} from "@/hooks/useProjectEnvironments";

/** Every execution field of an environment except its client and its model. */
export type EnvironmentComposition = Pick<
  ProjectEnvironmentView,
  | "serverAttachmentId"
  | "skillSelection"
  | "serverSkillSelection"
  | "secretSelection"
  | "pluginVersionIds"
  | "computerEnvironmentId"
>;

/**
 * The composition an environment runs, normalized so two rows that resolve
 * identically compare equal: `null`, `undefined` and an empty list all mean
 * "nothing selected".
 */
export function environmentComposition(
  environment: EnvironmentComposition,
): EnvironmentComposition {
  const out: EnvironmentComposition = {};
  if (environment.serverAttachmentId)
    out.serverAttachmentId = environment.serverAttachmentId;
  if (environment.skillSelection?.skillIds.length)
    out.skillSelection = environment.skillSelection;
  if (environment.serverSkillSelection?.serverSkillIds.length)
    out.serverSkillSelection = environment.serverSkillSelection;
  if (environment.secretSelection?.secretIds.length)
    out.secretSelection = environment.secretSelection;
  if (environment.pluginVersionIds?.length)
    out.pluginVersionIds = environment.pluginVersionIds;
  if (environment.computerEnvironmentId)
    out.computerEnvironmentId = environment.computerEnvironmentId;
  return out;
}

/**
 * A stable identity for a composition. Arrays keep their order — the backend
 * fingerprint treats skill and plugin order as meaningful, so two rows that
 * differ only by order are two different setups here too.
 */
export function compositionKey(
  environment: EnvironmentComposition,
  options: { ignoreServerGroup?: boolean } = {},
): string {
  const c = environmentComposition(environment);
  return JSON.stringify([
    options.ignoreServerGroup ? null : (c.serverAttachmentId ?? null),
    c.skillSelection
      ? [
          c.skillSelection.skillIds,
          (c.skillSelection.versionPins ?? []).map((pin) => [
            pin.skillId,
            pin.versionId,
          ]),
        ]
      : null,
    c.serverSkillSelection
      ? [
          c.serverSkillSelection.serverSkillIds,
          (c.serverSkillSelection.versionPins ?? []).map((pin) => [
            pin.serverSkillId,
            pin.versionId,
          ]),
        ]
      : null,
    c.secretSelection ? c.secretSelection.secretIds : null,
    c.pluginVersionIds ?? null,
    c.computerEnvironmentId ?? null,
  ]);
}

/**
 * Why the BROWSER cannot copy this composition into a new environment without
 * losing part of it, or `null` when it can.
 *
 * Not a statement that the setup is invalid — only that this client is the
 * wrong place to copy it. Plugin pins and captured server skills have no slot
 * in the composition the browser sends, and a secret grant is filtered to what
 * the viewer may see, so the view can be missing ids the environment really
 * delivers.
 */
export function unpreservableReason(
  environment: EnvironmentComposition,
): string | null {
  const c = environmentComposition(environment);
  if (c.pluginVersionIds) return "pins plugin versions";
  if (c.serverSkillSelection) return "selects captured server skills";
  if (c.secretSelection) return "grants project secrets";
  return null;
}

export type TemplateChoice =
  /** No candidate exists: the cell starts from nothing but its server group. */
  | { kind: "none" }
  /** Every candidate runs the same setup; `source` is one of them. */
  | {
      kind: "template";
      composition: EnvironmentComposition;
      source: ProjectEnvironmentView;
    }
  /** Candidates disagree; copying any one of them would be a guess. */
  | { kind: "ambiguous" };

/**
 * The one setup every candidate shares, or `ambiguous`.
 *
 * `ignoreServerGroup` is for an edit that is replacing the group anyway: the
 * candidates then only have to agree on everything else.
 */
export function chooseTemplate(
  candidates: readonly ProjectEnvironmentView[],
  options: { ignoreServerGroup?: boolean } = {},
): TemplateChoice {
  if (candidates.length === 0) return { kind: "none" };
  const keys = new Set(
    candidates.map((candidate) => compositionKey(candidate, options)),
  );
  if (keys.size > 1) return { kind: "ambiguous" };
  const source = candidates[0]!;
  return {
    kind: "template",
    composition: environmentComposition(source),
    source,
  };
}

export type SharedServerGroup =
  /** The suite has no environments to agree on anything. */
  | { kind: "empty" }
  /** Every environment uses this group. */
  | { kind: "group"; serverAttachmentId: string }
  /** No environment has a group. */
  | { kind: "none" }
  /** The environments use different groups (or some have none). */
  | { kind: "mixed" };

/** The server group all of these environments share, if they share one. */
export function sharedServerGroup(
  environments: readonly Pick<ProjectEnvironmentView, "serverAttachmentId">[],
): SharedServerGroup {
  if (environments.length === 0) return { kind: "empty" };
  const groups = new Set(
    environments.map((environment) => environment.serverAttachmentId || null),
  );
  if (groups.size > 1) return { kind: "mixed" };
  const [only] = [...groups];
  return only ? { kind: "group", serverAttachmentId: only } : { kind: "none" };
}

/**
 * An environment that would run with no servers: no group, and no plugin pin
 * contributing one. The backend refuses to launch these (`ENV_NO_SERVERS`);
 * the eval UI refuses to create or start them first.
 */
export function lacksServerSource(
  environment: EnvironmentComposition,
): boolean {
  const c = environmentComposition(environment);
  return !c.serverAttachmentId && !c.pluginVersionIds;
}

/** The skill selection in the shape an ad-hoc composition sends. */
export function adhocSkillSelection(
  composition: EnvironmentComposition,
): ProjectEnvironmentSkillSelection | undefined {
  return environmentComposition(composition).skillSelection ?? undefined;
}
