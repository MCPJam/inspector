/**
 * Which targets one `run_eval_suite` call launches.
 *
 * FAN-OUT IS EXPLICIT AND NEVER INFERRED FROM OMISSION. A bare "run this
 * suite" against a suite with three attached hosts is ambiguous — it could
 * reasonably mean "the default one", "the first one", or "all three", and the
 * last of those spends three times as much as the caller may have meant.
 * Guessing is the one thing this must not do, so:
 *
 *   - zero attachments   → one run on the suite's saved selection (today's
 *                          behaviour, unchanged, byte-for-byte);
 *   - exactly one        → one run on IT, automatically. This is not a guess:
 *                          there is only one thing the run could target, and
 *                          the platform resolves it that way regardless. It is
 *                          also the fix for the old silent mis-attribution, in
 *                          which a single-host suite ran under the suite's
 *                          default host config and reported the wrong host;
 *   - more than one      → `target-required`. The caller picks, or asks for all
 *                          of them explicitly.
 *
 * ONE AXIS, never a cross product. Environments win over hosts when a suite has
 * both, matching the web fan-out's own precedence — an environment already
 * resolves a host, so running "every host × every environment" would execute
 * combinations the suite never described.
 *
 * Pure and dependency-free so the rules can be tested without a client, and so
 * the surfaces that present them (CLI flags, MCP tool schema, the agent's
 * approval copy) all read the same decision.
 */

/** A suite-attached host, as `getEvalSuite` reports it. */
export interface RunTargetHost {
  id: string;
  name: string;
}

/** One resolved launch target. Exactly one of the two ids is set. */
export type RunTarget =
  | { kind: "environment"; id: string; name?: string }
  | { kind: "host"; id: string; name: string };

export type RunTargetPlan =
  /**
   * One run. `target` absent means the suite's own saved selection (the legacy
   * path, and the only shape that carries an explicit `serverIds` override).
   */
  | { kind: "single"; target?: RunTarget; serverIds?: string[] }
  /** One run per target, launched as a group. */
  | { kind: "group"; targets: RunTarget[] }
  /**
   * The caller has to choose. Carries both axes so the message can enumerate
   * exactly what is pickable instead of saying "be more specific".
   */
  | {
      kind: "target-required";
      attachedEnvironments: RunTarget[];
      attachedHosts: RunTarget[];
    };

export interface ComputeRunTargetsInput {
  /** The suite's attached environments, in attach order. */
  attachedEnvironments: Array<{ id: string; name?: string }>;
  /** The suite's attached hosts, in attach order. */
  attachedHosts: RunTargetHost[];
  /** Environments the caller named explicitly, already resolved to ids. */
  selectedEnvironments?: Array<{ id: string; name?: string }>;
  /** Hosts the caller named explicitly, already resolved to ids. */
  selectedHosts?: RunTargetHost[];
  /** "Run every attached target." */
  allAttached?: boolean;
  /** An explicit server override, which is a single legacy-path run. */
  serverIds?: string[];
}

/** Dedupe by resolved id, keeping first-seen order. */
function dedupe(targets: RunTarget[]): RunTarget[] {
  const seen = new Set<string>();
  const out: RunTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    out.push(target);
  }
  return out;
}

function asEnvironmentTargets(
  environments: Array<{ id: string; name?: string }>,
): RunTarget[] {
  return environments.map((environment) => ({
    kind: "environment" as const,
    id: environment.id,
    ...(environment.name ? { name: environment.name } : {}),
  }));
}

function asHostTargets(hosts: RunTargetHost[]): RunTarget[] {
  return hosts.map((host) => ({
    kind: "host" as const,
    id: host.id,
    name: host.name,
  }));
}

/** One target ⇒ one run; several ⇒ a group. */
function planFor(targets: RunTarget[]): RunTargetPlan {
  return targets.length === 1
    ? { kind: "single", target: targets[0]! }
    : { kind: "group", targets };
}

export function computeRunTargets(
  input: ComputeRunTargetsInput,
): RunTargetPlan {
  // An explicit server override is, by definition, not a fan-out: it replaces
  // the suite's selection for ONE run and is mutually exclusive with both
  // target axes (the callers enforce that before getting here).
  if (input.serverIds && input.serverIds.length > 0) {
    return { kind: "single", serverIds: input.serverIds };
  }

  const selectedEnvironments = dedupe(
    asEnvironmentTargets(input.selectedEnvironments ?? []),
  );
  const selectedHosts = dedupe(asHostTargets(input.selectedHosts ?? []));
  // Two NAMED axes describe two different launches, and picking one silently
  // would drop targets the caller asked for and paid to think about. The SDK's
  // own callers are rejected upstream by `assertRunTargetSelectorsCoherent`,
  // but this function is exported, so a direct caller must get the refusal
  // rather than a winner. Deliberately unlike `allAttached` below, where the
  // caller asked for "everything" and one axis is the honest answer.
  if (selectedEnvironments.length > 0 && selectedHosts.length > 0) {
    return {
      kind: "target-required",
      attachedEnvironments: selectedEnvironments,
      attachedHosts: selectedHosts,
    };
  }
  if (selectedEnvironments.length > 0) return planFor(selectedEnvironments);
  if (selectedHosts.length > 0) return planFor(selectedHosts);

  const attachedEnvironments = dedupe(
    asEnvironmentTargets(input.attachedEnvironments),
  );
  const attachedHosts = dedupe(asHostTargets(input.attachedHosts));

  if (input.allAttached) {
    // The environment axis wins outright when both exist — an environment
    // already resolves a host, so a cross product would execute combinations
    // the suite never described. Same precedence the web fan-out follows.
    const axis =
      attachedEnvironments.length > 0 ? attachedEnvironments : attachedHosts;
    // `allAttached` on a suite with NOTHING attached is not an error: the
    // suite has exactly one thing to run — its saved selection — and refusing
    // would make "run everything" fail on the simplest suite there is.
    return axis.length === 0 ? { kind: "single" } : planFor(axis);
  }

  const attachmentCount = attachedEnvironments.length + attachedHosts.length;
  if (attachmentCount === 0) return { kind: "single" };
  if (attachmentCount === 1) {
    return {
      kind: "single",
      target: attachedEnvironments[0] ?? attachedHosts[0]!,
    };
  }
  return { kind: "target-required", attachedEnvironments, attachedHosts };
}
