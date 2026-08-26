/**
 * Live, project-aware validation of a suite file's DETERMINISTIC tool
 * references.
 *
 * `loadEvalSuiteFile` answers "is this a valid suite file?" offline. It cannot
 * answer "will this actually run?", because that question is about a project's
 * live tool inventory rather than about the bytes. This module answers the
 * second question, and it is deliberately the ONLY implementation of it: both
 * `eval validate --project` and every `eval run --file` call
 * {@link validateImportToolReferences}, so the check a human runs before
 * committing a converted suite and the check the launcher runs before spending
 * money cannot drift into two different verdicts.
 *
 * What counts as a DETERMINISTIC reference, and why the line is where it is:
 *
 *   - A `toolCall` step IS one. It names a server and a tool and executes them
 *     with no model in the loop, so a name that does not exist is a certain
 *     failure, knowable now.
 *   - Prompt text is NOT one, even when it names a tool. The model decides what
 *     to call; a mention is a hint, not a call.
 *   - An `assert` step (`toolCalledWith`, `widgetToolCalled`) is NOT one. It is
 *     an EXPECTATION about what happened, and "the model was supposed to call a
 *     tool that does not exist" is a case that legitimately fails at run time
 *     rather than a file that cannot be launched. Refusing to launch over one
 *     would make a negative test unwritable.
 *
 * Two properties this module is built around:
 *
 *   - **Per-target, never a union.** A case that runs against three targets has
 *     to resolve in all three. Taking the union of their tool inventories would
 *     green-light a case that fails on two of them, which is precisely the
 *     false negative a pre-flight check exists to prevent.
 *   - **Fail closed, and never fabricate.** An auth failure, an unreachable
 *     project, or a target set this deployment cannot enumerate is a COMMAND
 *     error — it says the check could not be made. It is never reported as a
 *     finding about the file, because "your file names a tool that does not
 *     exist" and "we could not look" send the author to two different places.
 */

import type {
  ResolvedEvalSuiteFile,
  ResolvedEvalSuiteFileCase,
} from "@mcpjam/sdk";
import { suiteFilePointer } from "@mcpjam/sdk";
import type { ToolCallStep } from "@mcpjam/sdk/contract";
import {
  listServerToolsOperation,
  resolveEnvironmentOperation,
  type PlatformApiClient,
} from "@mcpjam/sdk/platform";
import { cliError } from "./output.js";

/** Refusing to launch is the same "no verdict was reached" exit a bad file gets. */
export const IMPORT_VALIDATION_EXIT_CODE = 2;

/**
 * Pages of tool listings followed for one server before giving up.
 *
 * A bound, not a budget. A cursor that never terminates is a deployment bug,
 * and looping on it forever would hang a launch instead of failing it; hitting
 * this cap is reported as discovery being unavailable, never as a resolved
 * inventory that happens to be short.
 */
const MAX_TOOL_PAGES = 50;

export type ImportToolFindingCode =
  | "TOOL_REFERENCE_UNRESOLVED"
  | "TOOL_DISCOVERY_UNAVAILABLE";

/**
 * One deterministic reference that does not resolve, reported against the file
 * the author can edit.
 *
 * `imported` and `disabled` are on the finding rather than left to the caller
 * to look up, because they are what decides the OUTCOME: an imported case is
 * rewritten to `unresolved`, a disabled one is persisted rather than run, and a
 * selected one refuses the launch outright.
 */
export type ImportToolFinding = {
  code: ImportToolFindingCode;
  /** Path into the AUTHORED file, e.g. `["cases", 2, "steps", 1, "toolName"]`. */
  path: Array<string | number>;
  /** {@link path} rendered the way every other suite-file finding renders it. */
  pointer: string;
  caseId: string;
  caseTitle: string;
  toolName: string;
  serverName?: string;
  /** Which target the reference failed against — absent when none was known. */
  targetLabel?: string;
  disabled: boolean;
  /** True when the case carries an import claim; false when authored natively. */
  imported: boolean;
  message: string;
};

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

export type ImportToolValidationResult = {
  /** Every target the run resolved to, in resolution order. */
  targets: ImportValidationTarget[];
  /** Sorted deterministically; see {@link compareFindings}. */
  findings: ImportToolFinding[];
};

// ── reading the file ─────────────────────────────────────────────────────────

type DeterministicReference = {
  caseIndex: number;
  testCase: ResolvedEvalSuiteFileCase;
  stepIndex: number;
  step: ToolCallStep;
};

/**
 * Every deterministic tool reference in the file, in document order.
 *
 * Reads `cases` rather than `enabledCases`: a disabled case is still persisted
 * with its claim, so an unresolved reference inside one is still a fact worth
 * recording — it just is not a reason to refuse a launch that never runs it.
 */
export function collectDeterministicToolReferences(
  resolved: ResolvedEvalSuiteFile
): DeterministicReference[] {
  const references: DeterministicReference[] = [];
  resolved.cases.forEach((testCase, caseIndex) => {
    testCase.steps.forEach((step, stepIndex) => {
      if (step.kind !== "toolCall") return;
      references.push({ caseIndex, testCase, stepIndex, step });
    });
  });
  return references;
}

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
        servers: await resolveServersByName(
          client,
          params.projectId,
          knobs.server,
          params.signal
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
async function hostTarget(
  client: PlatformApiClient,
  projectId: string,
  selector: string,
  displayName: string | undefined,
  signal: AbortSignal | undefined
): Promise<ImportValidationTarget> {
  const page = await client.listHosts({ projectId }, { signal });
  const host =
    page.items.find((entry) => entry.id === selector) ??
    page.items.find((entry) => entry.name === selector);
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
  signal: AbortSignal | undefined
): Promise<Array<{ id: string; name: string }>> {
  if (selectors.length === 0) return [];
  const page = await client.listProjectServers({ projectId }, { signal });
  const byId = new Map(page.items.map((server) => [server.id, server]));
  const byName = new Map(page.items.map((server) => [server.name, server]));
  const resolvedServers: Array<{ id: string; name: string }> = [];
  for (const selector of selectors) {
    const hit = byId.get(selector) ?? byName.get(selector);
    if (hit) resolvedServers.push({ id: hit.id, name: hit.name });
  }
  return resolvedServers;
}

// ── the check ────────────────────────────────────────────────────────────────

/**
 * Every tool name one server exposes right now.
 *
 * Follows the cursor: a server whose tools do not fit one page would otherwise
 * report its later tools as missing, which is the worst possible failure mode
 * for a check whose whole output is "this name does not exist".
 */
async function listToolNames(
  client: PlatformApiClient,
  projectId: string,
  server: { id: string; name: string },
  signal: AbortSignal | undefined
): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await listServerToolsOperation.execute(
      {
        project: projectId,
        server: server.id,
        ...(cursor ? { cursor } : {}),
      },
      { client, signal }
    );
    for (const tool of result.items) {
      const name = (tool as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
    if (!result.nextCursor) return names;
    cursor = result.nextCursor;
  }
  throw cliError(
    "TOOL_DISCOVERY_UNAVAILABLE",
    `Server "${server.name}" kept handing back another page of tools after ${MAX_TOOL_PAGES} requests. The suite file was not validated against it, and nothing was written.`,
    IMPORT_VALIDATION_EXIT_CODE
  );
}

/**
 * Check every deterministic reference in the file against every target.
 *
 * Throws (a command error) when the check cannot be performed — the project is
 * unreachable, an environment will not resolve, a server's tools cannot be
 * listed. Returns findings only for references that were genuinely looked up
 * and genuinely did not resolve.
 */
export async function validateImportToolReferences(
  client: PlatformApiClient,
  params: {
    projectId: string;
    resolved: ResolvedEvalSuiteFile;
    knobs?: ImportValidationKnobs;
    signal?: AbortSignal;
  }
): Promise<ImportToolValidationResult> {
  const references = collectDeterministicToolReferences(params.resolved);
  // Nothing deterministic to check means nothing to resolve — and, importantly,
  // no network call at all. A native prompt-only suite must not start paying
  // for target resolution just because this check is mandatory.
  if (references.length === 0) return { targets: [], findings: [] };

  const targets = await resolveValidationTargets(client, params);
  if (targets === null) {
    return {
      targets: [],
      findings: references.map((reference) =>
        finding(reference, {
          code: "TOOL_DISCOVERY_UNAVAILABLE",
          message:
            `The set of targets this run would execute against cannot be ` +
            `enumerated before the suite is written, so the deterministic ` +
            `reference "${reference.step.toolName}" on server ` +
            `"${reference.step.serverName}" could not be checked. Name an ` +
            `explicit --environment or --server to validate against a known ` +
            `target.`,
        })
      ),
    };
  }

  // One listing per server, shared across every target and every case that
  // references it. Without the cache a 40-case suite over 3 servers pays 120
  // identical round trips before it launches.
  const inventories = new Map<string, Set<string>>();
  const toolsFor = async (server: {
    id: string;
    name: string;
  }): Promise<Set<string>> => {
    const cached = inventories.get(server.id);
    if (cached) return cached;
    const names = await listToolNames(
      client,
      params.projectId,
      server,
      params.signal
    );
    inventories.set(server.id, names);
    return names;
  };

  const findings: ImportToolFinding[] = [];
  for (const target of targets) {
    for (const reference of references) {
      // `serverId` WINS when the step carries one. The step contract says so
      // (`toolCallStepSchema` in sdk/src/contract/steps.ts: "Id wins when both
      // are present"), and `serverName` is a display fallback that can go
      // stale — an OR here would let a stale name match a different server that
      // happens to sort first and check the wrong inventory, approving a call
      // whose real server lacks the tool or blocking one whose real server has
      // it.
      const server = reference.step.serverId
        ? target.servers.find(
            (candidate) => candidate.id === reference.step.serverId
          )
        : target.servers.find(
            (candidate) => candidate.name === reference.step.serverName
          );
      if (!server) {
        findings.push(
          finding(reference, {
            code: "TOOL_REFERENCE_UNRESOLVED",
            targetLabel: target.label,
            message:
              `Server "${reference.step.serverName}" is not part of ` +
              `${target.label}, so the deterministic call to ` +
              `"${reference.step.toolName}" cannot execute there.`,
          })
        );
        continue;
      }
      const names = await toolsFor(server);
      if (names.has(reference.step.toolName)) continue;
      findings.push(
        finding(reference, {
          code: "TOOL_REFERENCE_UNRESOLVED",
          targetLabel: target.label,
          message:
            `Server "${server.name}" in ${target.label} exposes no tool named ` +
            `"${reference.step.toolName}".`,
        })
      );
    }
  }

  findings.sort(compareFindings);
  return { targets, findings };
}

function finding(
  reference: DeterministicReference,
  parts: {
    code: ImportToolFindingCode;
    message: string;
    targetLabel?: string;
  }
): ImportToolFinding {
  const path = [
    "cases",
    reference.caseIndex,
    "steps",
    reference.stepIndex,
    "toolName",
  ];
  return {
    code: parts.code,
    path,
    pointer: suiteFilePointer(path),
    caseId: reference.testCase.id,
    caseTitle: reference.testCase.title,
    toolName: reference.step.toolName,
    ...(reference.step.serverName
      ? { serverName: reference.step.serverName }
      : {}),
    ...(parts.targetLabel ? { targetLabel: parts.targetLabel } : {}),
    disabled: reference.testCase.disabled,
    imported: reference.testCase.import !== undefined,
    message: parts.message,
  };
}

/**
 * Document order, then target, then code — so two runs of the same command over
 * the same file produce byte-identical output.
 *
 * Sorted explicitly rather than trusting the traversal above: the loop order is
 * target-major today, which would group a case's failures apart from each
 * other, and a caller diffing two validate runs should see the file's order.
 */
function compareFindings(a: ImportToolFinding, b: ImportToolFinding): number {
  const length = Math.min(a.path.length, b.path.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.path[index];
    const right = b.path[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  }
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  const target = (a.targetLabel ?? "").localeCompare(b.targetLabel ?? "");
  if (target !== 0) return target;
  return a.code.localeCompare(b.code);
}

/** Findings grouped by the authored case id they belong to. */
export function findingsByCaseId(
  findings: readonly ImportToolFinding[]
): Map<string, ImportToolFinding[]> {
  const grouped = new Map<string, ImportToolFinding[]>();
  for (const entry of findings) {
    const bucket = grouped.get(entry.caseId);
    if (bucket) bucket.push(entry);
    else grouped.set(entry.caseId, [entry]);
  }
  return grouped;
}
