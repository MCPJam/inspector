/**
 * Which servers a suite file run would connect, resolved against a live
 * project with the launch's own precedence and matching rules.
 *
 * `eval-import-live-validation.ts` builds the tool-reference check on top of
 * this.
 */

import type { ResolvedEvalSuiteFile } from "@mcpjam/sdk";
import {
  resolveEnvironmentOperation,
  type PlatformApiClient,
} from "@mcpjam/sdk/platform";
import { cliError } from "./output.js";

/** Refusing to launch is the same "no verdict was reached" exit a bad file gets. */
export const IMPORT_VALIDATION_EXIT_CODE = 2;

/** One execution target, with the closed server set a run would connect. */
export type ImportValidationTarget = {
  /** Human-readable, and stable: it lands in findings and in error text. */
  label: string;
  servers: Array<{ id: string; name: string }>;
};

/** The knobs that can move a file run off the target its file declares. */
export type ImportValidationKnobs = {
  server?: string[];
  environment?: string[];
  host?: string[];
  allTargets?: boolean;
  compose?: unknown;
  /** `--case` selectors, when the launch narrows the run. */
  case?: string[];
};

// ── resolving what the run will actually connect ─────────────────────────────

/**
 * The targets a file run would execute against, using launch's own precedence.
 *
 * Mirrors `executeEvalRunFromFile`: an explicit CLI target wins over the file's
 * `target.environment`, which wins over `target.hosts`, which wins over
 * `target.servers`. Anything else would validate against a target the run does
 * not use, which is worse than not validating at all — it reports confidence
 * about the wrong thing.
 *
 * Returns `null` when the effective target set cannot be enumerated before the
 * suite exists (`--all-targets` brings in the suite's attachments; `--compose`
 * mints an environment as a side effect of launching). Callers turn that into
 * "we could not look", never into "your file is fine".
 */
export async function resolveValidationTargets(
  client: PlatformApiClient,
  params: {
    projectId: string;
    resolved: ResolvedEvalSuiteFile;
    knobs?: ImportValidationKnobs;
    signal?: AbortSignal;
  }
): Promise<ImportValidationTarget[] | null> {
  const knobs = params.knobs ?? {};
  const target = params.resolved.target;

  // `--all-targets` fans out over the suite's ATTACHED environments, and
  // `--compose` mints one. Neither exists yet at the moment this check runs
  // (deliberately: the check is before any write), so neither can be
  // enumerated. Unknowable, not empty.
  if (knobs.allTargets || knobs.compose) return null;

  if (knobs.environment?.length) {
    return Promise.all(
      knobs.environment.map((selector) =>
        environmentTarget(client, params.projectId, selector, params.signal)
      )
    );
  }

  if (knobs.server?.length) {
    return [
      {
        label: `servers ${knobs.server.join(", ")}`,
        // EXPLICIT: `--server` is resolved at launch by `resolveByIdOrName`,
        // which requires a unique name. See `resolveServersByName`.
        servers: await resolveServersByName(
          client,
          params.projectId,
          knobs.server,
          params.signal,
          "explicit"
        ),
      },
    ];
  }

  // A HOST runs against its OWN configured server set, not the file's. The
  // launch contract is explicit about it — "running an attached host uses that
  // host's own configured server set, which servers cannot override"
  // (`assertRunTargetSelectorsCoherent` in sdk/src/platform/operations.ts) —
  // and validating the file's `target.servers` here instead would be wrong in
  // both directions: it could approve a tool that exists only on the file
  // target and then start a paid run on a host that cannot execute it, or
  // refuse a case the host would have run fine.
  if (knobs.host?.length) {
    return Promise.all(
      knobs.host.map((selector) =>
        hostTarget(client, params.projectId, selector, undefined, params.signal)
      )
    );
  }

  if (target.environment) {
    return [
      await environmentTarget(
        client,
        params.projectId,
        target.environment,
        params.signal
      ),
    ];
  }

  const fileServers = target.servers ?? [];
  if (target.hosts?.length) {
    // A file host that DECLARES servers has them attached to it before launch,
    // so the declared set is what it will run. One that declares none keeps
    // whatever it already has configured, which only the platform can tell us.
    //
    // Each host is its own target: a tool present on one host's servers and
    // absent from another's is exactly the multi-target false positive a union
    // would hide.
    return Promise.all(
      target.hosts.map(async (host) => {
        const selector = host.id ?? host.name;
        // `undefined` and `[]` are DIFFERENT, and the suite-file contract says
        // so in as many words ("an empty set is meaningful and preserved").
        // Only an omitted list falls back to the host's current config; an
        // explicitly empty one is forwarded to `updateEvalSuiteOperation`
        // before launch and CLEARS the attachment, so treating it as omitted
        // would validate against servers the run is about to remove and let a
        // reference resolve against a set that no longer exists.
        if (host.servers === undefined) {
          return hostTarget(
            client,
            params.projectId,
            selector,
            host.name,
            params.signal
          );
        }
        return {
          label: `host ${host.name}`,
          servers: await resolveServersByName(
            client,
            params.projectId,
            host.servers.map((server) => server.id ?? server.name),
            params.signal
          ),
        };
      })
    );
  }

  return [
    {
      label: "the file's target.servers",
      servers: await resolveServersByName(
        client,
        params.projectId,
        fileServers.map((server) => server.id ?? server.name),
        params.signal
      ),
    },
  ];
}

/**
 * One host's OWN configured server set.
 *
 * `config.serverIds` is the host-config v2 field the rest of the product reads
 * for exactly this question. An EMPTY array is a real answer — a host with no
 * servers attached — and is passed through as an empty target, where every
 * deterministic reference correctly fails to resolve.
 *
 * A config with no readable `serverIds` at all is a different thing, and it
 * THROWS rather than degrading to the file's servers: checking the wrong
 * inventory is how this preflight would start a paid run against a host that
 * cannot execute the case, which is the failure it exists to prevent. "We could
 * not look" is the honest answer, and a command error is how this module says
 * it.
 */
/**
 * A host selector, resolved the way THE LAUNCH resolves it.
 *
 * `resolveByIdOrName` (sdk/src/platform/operations.ts) trims the selector,
 * matches an id exactly, and otherwise takes a UNIQUE case-insensitive name
 * match — refusing outright when a name matches more than one host. Matching
 * exactly here would report `TOOL_DISCOVERY_UNAVAILABLE` for `claude code`
 * against a host named `Claude Code` and block a run that launches fine, which
 * is the same defect as the server display-name fold: a preflight stricter
 * than the thing it gates refuses good work.
 */
function resolveHostSelector<T extends { id: string; name?: string | null }>(
  items: readonly T[],
  selector: string
): { kind: "resolved"; host: T | undefined } | { kind: "ambiguous" } {
  const trimmed = selector.trim();
  const byId = items.find((item) => item.id === trimmed);
  if (byId) return { kind: "resolved", host: byId };
  const normalized = trimmed.toLocaleLowerCase();
  const byName = items.filter(
    (item) => item.name?.toLocaleLowerCase() === normalized
  );
  if (byName.length > 1) return { kind: "ambiguous" };
  return { kind: "resolved", host: byName[0] };
}

async function hostTarget(
  client: PlatformApiClient,
  projectId: string,
  selector: string,
  displayName: string | undefined,
  signal: AbortSignal | undefined
): Promise<ImportValidationTarget> {
  const page = await client.listHosts({ projectId }, { signal });
  const resolved = resolveHostSelector(page.items, selector);
  if (resolved.kind === "ambiguous") {
    // `resolveByIdOrName` refuses an ambiguous name rather than picking one,
    // so the launch would fail here too. Saying which host is meant is more
    // use than reporting the tools of whichever one sorted first.
    throw cliError(
      "TOOL_DISCOVERY_UNAVAILABLE",
      `Host name "${selector}" matches more than one host in this project, so the suite file's deterministic tool references could not be checked against it. Name the host by id. Nothing was written.`,
      IMPORT_VALIDATION_EXIT_CODE
    );
  }
  const host = resolved.host;
  if (!host) {
    throw cliError(
      "TOOL_DISCOVERY_UNAVAILABLE",
      `Host "${selector}" is not in this project, so the suite file's deterministic tool references could not be checked against it. Nothing was written.`,
      IMPORT_VALIDATION_EXIT_CODE
    );
  }
  const detail = await client.getHost(
    { projectId, hostId: host.id },
    { signal }
  );
  const serverIds = (detail.config as { serverIds?: unknown } | undefined)
    ?.serverIds;
  if (!Array.isArray(serverIds)) {
    throw cliError(
      "TOOL_DISCOVERY_UNAVAILABLE",
      `Host "${host.name}" did not report a server set, so the suite file's deterministic tool references could not be checked against it. Nothing was written.`,
      IMPORT_VALIDATION_EXIT_CODE
    );
  }
  const pinned = serverIds.filter((id): id is string => typeof id === "string");
  const servers = await resolveServersByName(client, projectId, pinned, signal);
  // A host pinning a server the project no longer has is an inconsistency in
  // the PROJECT, not in the file. Silently validating against the narrowed set
  // would still fail closed, but it would fail closed with the wrong sentence —
  // reporting "your file names a tool that does not exist" and sending the
  // author to edit YAML that is fine.
  const missing = pinned.filter(
    (id) => !servers.some((server) => server.id === id)
  );
  if (missing.length > 0) {
    throw cliError(
      "TOOL_DISCOVERY_UNAVAILABLE",
      `Host "${host.name}" pins server(s) ${missing.join(
        ", "
      )} that this project no longer has, so the suite file's deterministic tool references could not be checked against it. Nothing was written.`,
      IMPORT_VALIDATION_EXIT_CODE
    );
  }
  return { label: `host ${displayName ?? host.name}`, servers };
}

async function environmentTarget(
  client: PlatformApiClient,
  projectId: string,
  selector: string,
  signal: AbortSignal | undefined
): Promise<ImportValidationTarget> {
  // The SAME operation launch resolves an environment with, so the closed
  // server set validated here is the one the run connects — including servers
  // contributed by pinned plugin versions, which a raw environment read would
  // miss.
  const resolvedEnvironment = await resolveEnvironmentOperation.execute(
    { project: projectId, environment: selector },
    { client, signal }
  );
  return {
    label: `environment ${resolvedEnvironment.environment.name}`,
    servers: resolvedEnvironment.servers.map((server) => ({
      id: server.serverId,
      name: server.name,
    })),
  };
}

/**
 * Turn the file's server selectors into live project servers.
 *
 * A selector that matches nothing is dropped rather than raised: the file's
 * `target.servers` names servers by the name a project may not have yet, and
 * the resulting findings ("tool X on server Y does not resolve") say more than
 * a bare "no such server" would. The one thing that is NOT dropped is a failure
 * to READ the project's servers — that is the check being unavailable.
 */
async function resolveServersByName(
  client: PlatformApiClient,
  projectId: string,
  selectors: string[],
  signal: AbortSignal | undefined,
  /**
   * Which of the launch's TWO server-resolution rules this call gates.
   *
   *   - `"binding"` — a server named by the FILE (`target.servers`, or a
   *     host's declared set). The runtime resolves these with
   *     `resolveConfiguredServerIds`, which takes the first case-insensitive
   *     match and never complains about ambiguity, so this preflight must not
   *     either: refusing here would block a run that executes fine.
   *   - `"explicit"` — a server named on the COMMAND LINE via `--server`. The
   *     launch resolves these with `resolveRunServers` -> `resolveByIdOrName`,
   *     which requires a UNIQUE case-insensitive name and throws otherwise.
   *
   * The two genuinely differ, and collapsing them re-creates the defect this
   * whole preflight exists to prevent — in the direction that costs the most:
   * accepting `--server GITHUB` against project servers `GitHub` and `github`
   * would validate, sync the suite and its cases, and only THEN have the
   * launch reject the selector as ambiguous, leaving writes behind for a run
   * that never started.
   */
  rule: "binding" | "explicit" = "binding"
): Promise<Array<{ id: string; name: string }>> {
  if (selectors.length === 0) return [];
  const page = await client.listProjectServers({ projectId }, { signal });
  const byId = new Map(page.items.map((server) => [server.id, server]));
  const byName = new Map(page.items.map((server) => [server.name, server]));
  // Exact first, then folded — the order both runtime resolvers use.
  const foldedMatches = new Map<string, Array<(typeof page.items)[number]>>();
  for (const server of page.items) {
    const key = foldServerName(server.name);
    const bucket = foldedMatches.get(key);
    if (bucket) bucket.push(server);
    else foldedMatches.set(key, [server]);
  }
  const resolvedServers: Array<{ id: string; name: string }> = [];
  for (const rawSelector of selectors) {
    const selector = rawSelector.trim();
    if (!selector) continue;
    // An exact ID short-circuits under BOTH rules — every runtime resolver
    // checks ids first, and an id is unique by construction.
    const byIdHit = byId.get(selector);
    if (byIdHit) {
      resolvedServers.push({ id: byIdHit.id, name: byIdHit.name });
      continue;
    }
    // An exact DISPLAY NAME short-circuits only under the binding rule.
    // `resolveByIdOrName` has no exact-name fast path: after the id check it
    // goes straight to the folded set and refuses a name matching more than
    // one server — so with `GitHub` and `github` both present, even the exact
    // spelling `--server GitHub` is ambiguous at launch. Accepting it here
    // because it matched a name exactly would sync the suite and its cases and
    // leave the launch to reject the selector afterwards.
    if (rule === "binding") {
      const byNameHit = byName.get(selector);
      if (byNameHit) {
        resolvedServers.push({ id: byNameHit.id, name: byNameHit.name });
        continue;
      }
    }
    const folded = foldedMatches.get(foldServerName(selector)) ?? [];
    if (rule === "explicit" && folded.length > 1) {
      throw cliError(
        "TOOL_DISCOVERY_UNAVAILABLE",
        `Server name "${selector}" matches more than one server in this project, so the run's target could not be checked. The launch refuses an ambiguous --server too; name the server by id. Nothing was written.`,
        IMPORT_VALIDATION_EXIT_CODE
      );
    }
    const hit = folded[0];
    if (hit) resolvedServers.push({ id: hit.id, name: hit.name });
  }
  return resolvedServers;
}

/**
 * A server DISPLAY NAME, folded the way the runtime folds it.
 *
 * `resolveConfiguredServerIds` (mcpjam-inspector/server/services/evals-runner.ts)
 * trims a server reference and then matches it exactly, falling back to a
 * case-insensitive match. A preflight that only matched exactly would be
 * STRICTER THAN THE THING IT GATES: a suite naming `github` for a project
 * server called `GitHub` would have every deterministic call reported
 * unresolved and the run refused, when the runtime would have resolved it and
 * executed. Refusing a run that works is as much a defect here as approving one
 * that does not.
 *
 * IDS ARE NEVER FOLDED. An id is an exact identifier rather than a label, and
 * two ids differing only by case are two different servers.
 */
export function foldServerName(name: string): string {
  return name.trim().toLocaleLowerCase();
}
