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
  type PlatformApiClient,
} from "@mcpjam/sdk/platform";
import {
  foldServerName,
  IMPORT_VALIDATION_EXIT_CODE,
  resolveValidationTargets,
  type ImportValidationKnobs,
  type ImportValidationTarget,
} from "./eval-import-targets.js";
import { cliError } from "./output.js";

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

/**
 * The server a step's display name refers to, exact match winning over folded.
 */
function serverByDisplayName<T extends { name: string }>(
  servers: readonly T[],
  name: string
): T | undefined {
  const wanted = name.trim();
  return (
    servers.find((candidate) => candidate.name === wanted) ??
    servers.find(
      (candidate) => foldServerName(candidate.name) === foldServerName(wanted)
    )
  );
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
        // Presence, not truthiness: MCP 2026-07-28
        // `server/utilities/pagination` makes `""` a valid cursor, and
        // dropping it here would silently re-read page one.
        ...(cursor !== undefined ? { cursor } : {}),
      },
      { client, signal }
    );
    for (const tool of result.items) {
      const name = (tool as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
    // ABSENCE ends the walk, not emptiness. `""` is a valid cursor that MUST
    // NOT be treated as the end of results — stopping on one would drop every
    // tool past page one, and a name this walk never read is reported as a
    // name that does not exist.
    const next =
      typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (next === undefined) return names;
    cursor = next;
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
        : serverByDisplayName(target.servers, reference.step.serverName);
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
