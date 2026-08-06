/**
 * MCPJam's Tasks **product policy** — distinct from, and never confused with,
 * the wire extension.
 *
 * ```text
 * hostConfig.mcpProfile.extensions["com.mcpjam/tasks"] = { enabled: boolean }
 * ```
 *
 * `com.mcpjam/tasks` is MCPJam configuration. It MUST NOT be advertised to an
 * MCP server, ever. The only thing that goes on the wire is
 * `io.modelcontextprotocol/tasks: {}` in a request's client capabilities. The
 * two are kept in separate modules for exactly this reason: nothing here
 * produces a capability value, and nothing in `tasks-ext.ts` reads a host
 * config.
 *
 * ## Why tri-state, not a boolean
 *
 * Three states are genuinely distinct and a two-state switch cannot express
 * them:
 *
 *  - **unset** — the host has said nothing. The Tools tab keeps its existing
 *    explicit per-call task controls, and every newly-added surface stays off.
 *    This is what makes adding a Tasks-capable surface a non-event for hosts
 *    that never opted in.
 *  - **on** — enable Tasks on the *supported interactive surfaces* listed in
 *    the matrix. Not "all surfaces": replay surfaces never create work, and
 *    the API/CLI keep their own explicit opt-in.
 *  - **off** — remove every task affordance and every declaration.
 *
 * A binary switch would collapse unset into one of the other two, silently
 * changing behavior for hosts that never expressed an opinion. So the editor
 * must offer On, Off, and "Use default" — the third is a real choice, not a
 * reset button.
 *
 * `invalid` is a fourth *observed* state, never a stored one: a malformed
 * value fails closed to the same behavior as `off`, and is reported so the
 * editor can show a repair warning instead of silently ignoring what the user
 * wrote.
 */

/** MCPJam's own extension id. Never sent to a server. */
export const MCPJAM_TASKS_POLICY_EXTENSION_ID = "com.mcpjam/tasks" as const;

/** What the stored config says. */
export type TasksPolicy = "unset" | "on" | "off" | "invalid";

/**
 * What a given surface should actually do.
 *
 *  - `off` — no task affordances, no declaration on any request.
 *  - `expose` — declare eligibility, surface the handle, and let the user (or
 *    a later turn) follow it. The call itself returns promptly.
 *  - `await` — declare eligibility and drive the task to a bounded terminal
 *    result before returning. For automation, where nobody is watching a tab.
 */
export type TaskMode = "off" | "expose" | "await";

/**
 * The surfaces the policy distinguishes. Adding one here is deliberate: it
 * forces a decision about its `unset` and `on` behavior in
 * {@link taskModeForSurface} rather than letting it inherit something by
 * accident.
 */
export type TaskSurface =
  /** Local or hosted Tools tab. Has its own explicit per-call controls. */
  | "tools"
  /** Local, hosted-emulated, or BYOK chat and playground. */
  | "chat"
  /** The MCPJam agent. */
  | "agent"
  /** Eval / simulation execution — automation, so `await` rather than `expose`. */
  | "eval"
  /** Protocol + conformance harness. The test owns the exact wire. */
  | "conformance"
  /** Saved-result and pinned replay. Must NEVER create new work. */
  | "replay"
  /** Public API and CLI. Their own explicit request flag is the boundary. */
  | "api";

interface TasksPolicyHost {
  mcpProfile?: {
    extensions?: Record<string, unknown>;
  };
}

/**
 * A PLAIN JSON object — not merely "an object".
 *
 * Host config is JSON, so anything with an exotic prototype (`new Map()`, a
 * class instance) did not come from a config file and cannot be read as one.
 * A looser `typeof === "object"` check would let `new Map()` through as an
 * empty extensions container and report `unset`, which PRESERVES task controls
 * on a config we cannot actually understand. Failing closed to `invalid` is
 * the only safe reading, and it surfaces the repair warning.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads the stored policy.
 *
 * Anything that is not a `{ enabled: boolean }` object is `invalid` rather
 * than being coerced. Coercion here is how a typo becomes silently-enabled
 * Tasks on every surface.
 */
export function readTasksPolicy(
  host: TasksPolicyHost | undefined
): TasksPolicy {
  const mcpProfile = host?.mcpProfile as unknown;
  // Same fail-closed rule as `extensions`, one level up. `host.mcpProfile` is
  // typed but the value comes from JSON, so `mcpProfile: "on"` is reachable —
  // and optional chaining would read `"on".extensions` as `undefined` and
  // report `unset`, i.e. PRESERVE task controls on a config nobody can read.
  if (mcpProfile !== undefined && !isRecord(mcpProfile)) return "invalid";
  const extensions = host?.mcpProfile?.extensions;
  if (extensions === undefined) return "unset";
  // Present but not a plain object: a config we cannot read must fail closed,
  // not be treated as "nothing was configured".
  if (!isRecord(extensions)) return "invalid";
  if (
    !Object.prototype.hasOwnProperty.call(
      extensions,
      MCPJAM_TASKS_POLICY_EXTENSION_ID
    )
  ) {
    return "unset";
  }
  const entry = extensions[MCPJAM_TASKS_POLICY_EXTENSION_ID];
  if (!isRecord(entry)) return "invalid";
  // OWN property only. `entry.enabled` would otherwise read through the
  // prototype chain, so a polluted `Object.prototype.enabled` could make an
  // entry that says nothing read as an explicit on or off — turning Tasks on
  // across every surface without anything in the config saying so. This module
  // fails closed; that has to include the lookup itself.
  if (!Object.prototype.hasOwnProperty.call(entry, "enabled")) return "invalid";
  const enabled = entry.enabled;
  if (enabled === true) return "on";
  if (enabled === false) return "off";
  // Present but not a boolean — including absent `enabled`, which is a
  // half-written config rather than a default.
  return "invalid";
}

/** Human-readable reason for an `invalid` policy, for the editor's warning. */
export function describeInvalidTasksPolicy(
  host: TasksPolicyHost | undefined
): string | undefined {
  if (readTasksPolicy(host) !== "invalid") return undefined;
  if (host?.mcpProfile !== undefined && !isRecord(host.mcpProfile)) {
    return `"mcpProfile" must be a plain JSON object.`;
  }
  const entry =
    host?.mcpProfile?.extensions?.[MCPJAM_TASKS_POLICY_EXTENSION_ID];
  if (!isRecord(host?.mcpProfile?.extensions)) {
    return `"mcpProfile.extensions" must be a plain JSON object.`;
  }
  if (!isRecord(entry)) {
    return `"${MCPJAM_TASKS_POLICY_EXTENSION_ID}" must be an object of the form { "enabled": true | false }.`;
  }
  return `"${MCPJAM_TASKS_POLICY_EXTENSION_ID}.enabled" must be true or false.`;
}

/**
 * Returns a host with the policy set. Pure: the input is not mutated, so a
 * caller can diff before and after.
 */
export function setTasksPolicy<T extends TasksPolicyHost>(
  host: T | undefined,
  enabled: boolean
): T {
  const base = (host ?? {}) as T;
  return {
    ...base,
    mcpProfile: {
      ...(base.mcpProfile ?? {}),
      extensions: {
        ...(isRecord(base.mcpProfile?.extensions)
          ? base.mcpProfile.extensions
          : {}),
        [MCPJAM_TASKS_POLICY_EXTENSION_ID]: { enabled },
      },
    },
  };
}

/**
 * Returns a host with the policy removed — back to `unset`.
 *
 * Distinct from `setTasksPolicy(host, false)`: this restores default behavior
 * (Tools keeps its explicit controls), whereas `false` actively disables Tasks
 * everywhere including those controls.
 *
 * ## No residue
 *
 * `hostConfigs` are content-addressed: the stored id IS the hash of the
 * serialized host, so an empty container left behind by a set→clear round trip
 * is not cosmetic — it mints a new hostConfig row for a host that is, in every
 * observable way, the one that existed before the feature shipped. So the
 * emptied containers are removed rather than kept: `extensions` goes away when
 * nothing else lives in it, and `mcpProfile` goes away when `extensions` was
 * all it held.
 *
 * The one thing this does NOT round-trip is a host that stored an *explicitly
 * empty* `mcpProfile: {}` or `extensions: {}` before any policy was set — that
 * is normalized to absent. Deliberate: absent and empty already mean exactly
 * the same thing to every reader in this module, and preserving the difference
 * would mean keeping the residue in the far more common case.
 */
export function clearTasksPolicy<T extends TasksPolicyHost>(
  host: T | undefined
): T {
  const base = (host ?? {}) as T;
  const extensions = base.mcpProfile?.extensions;
  // Nothing stored (or an unreadable container): clearing is a no-op, and
  // rebuilding the host here would churn the hash for no change.
  if (!isRecord(extensions)) return base;
  if (
    !Object.prototype.hasOwnProperty.call(
      extensions,
      MCPJAM_TASKS_POLICY_EXTENSION_ID
    )
  ) {
    return base;
  }
  const { [MCPJAM_TASKS_POLICY_EXTENSION_ID]: _removed, ...rest } = extensions;
  const { extensions: _dropped, ...profileRest } = (base.mcpProfile ??
    {}) as Record<string, unknown>;

  if (Object.keys(rest).length > 0) {
    return {
      ...base,
      mcpProfile: { ...profileRest, extensions: rest },
    };
  }
  if (Object.keys(profileRest).length > 0) {
    return { ...base, mcpProfile: profileRest } as unknown as T;
  }
  const { mcpProfile: _removedProfile, ...hostRest } = base as Record<
    string,
    unknown
  >;
  return hostRest as unknown as T;
}

/**
 * The published surface matrix.
 *
 * | Surface     | unset             | on            |
 * | ----------- | ----------------- | ------------- |
 * | tools       | explicit controls | expose        |
 * | chat        | off               | expose        |
 * | agent       | off               | expose        |
 * | eval        | off               | await         |
 * | conformance | explicit test     | explicit test |
 * | replay      | off               | off           |
 * | api         | explicit request  | explicit request |
 *
 * Two rows never move, whatever the policy says:
 *
 *  - **replay** is `off` in every state. A replay surface renders a recorded
 *    result; creating new server-side work from one would be a side effect the
 *    user never asked for and cannot see.
 *  - **conformance** and **api** are caller-driven. The conformance harness
 *    owns the exact wire it is testing — a host policy that silently added a
 *    declaration would corrupt the very thing under test — and the public API's
 *    per-request opt-in IS its policy boundary.
 *
 * `off` and `invalid` force `off` everywhere, including the Tools tab's
 * explicit controls: an explicit Off is a statement, and failing closed on a
 * malformed value is the only safe reading of one.
 */
export function taskModeForSurface(
  policy: TasksPolicy,
  surface: TaskSurface
): TaskMode {
  // Never creates work, whatever anyone configured.
  if (surface === "replay") return "off";

  // Caller-owned: the request itself decides, so the host policy only ever
  // acts as a kill switch.
  if (surface === "conformance" || surface === "api") {
    return policy === "off" || policy === "invalid" ? "off" : "expose";
  }

  if (policy === "off" || policy === "invalid") return "off";

  if (policy === "unset") {
    // Preserve today's behavior exactly: Tools keeps its explicit per-call
    // controls; nothing that was not already on turns on.
    return surface === "tools" ? "expose" : "off";
  }

  // policy === "on"
  return surface === "eval" ? "await" : "expose";
}

/**
 * Whether this surface may put `io.modelcontextprotocol/tasks` on a request.
 *
 * The one predicate a route should call. It reads as the question the route
 * actually has, rather than making every route re-derive it from a mode.
 */
export function surfaceMayDeclareTasks(
  policy: TasksPolicy,
  surface: TaskSurface
): boolean {
  return taskModeForSurface(policy, surface) !== "off";
}
