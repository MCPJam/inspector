/**
 * The `apps-ui-resources` probe: grades MCP Apps over the tool and resource
 * lists the connect capture already holds, plus `resources/read` of the
 * server's own `ui://` resources on the existing connection.
 *
 * The capture's doctor state keeps each tool's `_meta` apart, in
 * `toolsMetadata`; it is put back on the tool before planning and grading,
 * since `_meta.ui.resourceUri` is what makes a tool an Apps tool.
 *
 * Reads use `readOnConnection` (`connection-reads.ts`), never the manager's
 * multi-round-trip loop, so a read that asks for input is abandoned instead of
 * reaching the user. A 2025-era `elicitation/create` during a read is kept
 * from the user by the input guard (`input-guard.ts`), which also decides
 * whether reads may run at all. At most {@link MAX_UI_RESOURCE_READS} reads
 * run, each bounded, and the caller's signal stops them all.
 *
 * Without complete tool and resource lists the probe does not run: it reports
 * `failed`, which the backend records without replacing the last good
 * summary. Only checks the intrusiveness map calls passive or read-only are
 * graded. Checks that grade read results grade the reads that ran, which for a
 * server with more UI resources than the cap is a sample, as the skills probe
 * grades its sample. They need at least one read, and are left out when any
 * read was skipped, abandoned, unanswered or stopped, since a partial set of
 * reads would grade wrongly. A sample keeps the summary's coverage `partial`,
 * because the catalog takes a complete summary as proof that no UI resource
 * declares a field. A read that timed out or lost its connection is never
 * graded as a failure.
 */
import {
  MCP_APPS_CHECK_IDS,
  gradeMCPApps,
  isBackgroundSafeCheck,
  planMCPAppsResourceReads,
  type CheckStatus,
  type ConformanceCheckRef,
  type ConnectedServerDoctorState,
  type MCPAppsCheckId,
  type MCPAppsResourceReadOutcome,
  type MCPClientManager,
  type ProbeSummary,
} from "@mcpjam/sdk";
import { readOnConnection, type ConnectionRead } from "./connection-reads.js";
import { LOCAL_LEGACY_READS_SKIPPED, type ProbeInputGuard } from "./input-guard.js";
import { isRecord, probeSummary, unranProbe } from "./shared.js";

export const MAX_UI_RESOURCE_READS = 8;
export const UI_RESOURCE_READ_TIMEOUT_MS = 2_500;

/** Checks that grade `resources/read` results. */
const READ_CHECKS: readonly MCPAppsCheckId[] = [
  "ui-resources-readable",
  "ui-resource-contents-valid",
  "ui-resource-meta-valid",
];

type ListedTool = Parameters<typeof planMCPAppsResourceReads>[0][number];
type ListedResource = Parameters<typeof planMCPAppsResourceReads>[1][number];

export interface AppsProbeDependencies {
  grade?: typeof gradeMCPApps;
}

function isListedTool(value: unknown): value is ListedTool {
  return isRecord(value) && typeof value.name === "string";
}

function isListedResource(value: unknown): value is ListedResource {
  return isRecord(value) && typeof value.uri === "string";
}

/** The listed tools, each with the `_meta` the doctor kept in `toolsMetadata`. */
function listedTools(doctor: ConnectedServerDoctorState): ListedTool[] {
  return doctor.tools.filter(isListedTool).map((tool) => {
    const meta = doctor.toolsMetadata[tool.name];
    return isRecord(meta) ? { ...tool, _meta: meta } : tool;
  });
}

/** The server's own `ui://` resources the probe would read. */
export function plannedUiResourceUris(doctor: ConnectedServerDoctorState): string[] {
  const plan = planMCPAppsResourceReads(
    listedTools(doctor),
    doctor.resources.filter(isListedResource),
  );
  return plan.uris.filter((uri) => uri.startsWith("ui://"));
}

async function guardedRead(
  manager: Pick<MCPClientManager, "getManagedClient">,
  managerKey: string,
  uri: string,
  signal: AbortSignal,
  guard: ProbeInputGuard,
): Promise<ConnectionRead> {
  const end = guard.track();
  const read = await readOnConnection(manager, managerKey, uri, {
    signal,
    timeoutMs: UI_RESOURCE_READ_TIMEOUT_MS,
  });
  // The server asked for input while this read was in flight.
  return end() ? { kind: "input" } : read;
}

/** Whether any read content item declares `_meta.ui[field]`. */
function contentDeclares(results: readonly unknown[], field: string): boolean {
  return results.some((result) => {
    const contents = isRecord(result) ? result.contents : undefined;
    if (!Array.isArray(contents)) return false;
    return contents.some((item) => {
      const meta = isRecord(item) ? item._meta : undefined;
      const ui = isRecord(meta) ? meta.ui : undefined;
      return isRecord(ui) && ui[field] !== undefined;
    });
  });
}

function listed(state: ConnectedServerDoctorState, part: "tools" | "resources"): boolean {
  return state.checks[part].status !== "error";
}

const NOT_LISTED =
  "The connect capture did not list the server's tools and resources, so MCP Apps were not checked.";
export const UI_READS_SAMPLED =
  `MCPJam read the first ${MAX_UI_RESOURCE_READS} UI resources in the background. Run checks to read the rest.`;

export async function runAppsProbe(
  input: {
    manager: Pick<MCPClientManager, "getManagedClient">;
    managerKey: string;
    doctor: ConnectedServerDoctorState | undefined;
    guard: ProbeInputGuard;
    signal: AbortSignal;
    now: () => number;
  },
  dependencies: AppsProbeDependencies = {},
): Promise<ProbeSummary<"apps-ui-resources">> {
  const { doctor } = input;
  // Grading partial lists would report missing tools as gaps, and a good
  // summary would replace the last one that had the full lists.
  if (!doctor || !listed(doctor, "tools") || !listed(doctor, "resources")) {
    return unranProbe("apps-ui-resources", "failed", input.now(), NOT_LISTED);
  }
  const tools = listedTools(doctor);
  const resources = doctor.resources.filter(isListedResource);
  const plan = planMCPAppsResourceReads(tools, resources);
  const uiUris = plan.uris.filter((uri) => uri.startsWith("ui://"));
  const readsSkipped = uiUris.length > 0 && !input.guard.readsAllowed;
  const toRead = readsSkipped ? [] : uiUris.slice(0, MAX_UI_RESOURCE_READS);

  const reads = await Promise.all(
    toRead.map(async (uri) => ({
      uri,
      read: await guardedRead(
        input.manager,
        input.managerKey,
        uri,
        input.signal,
        input.guard,
      ),
    })),
  );
  const outcomes: MCPAppsResourceReadOutcome[] = [];
  const results: unknown[] = [];
  let abandoned = 0;
  let unfinished = 0;
  for (const { uri, read } of reads) {
    if (read.kind === "input") abandoned += 1;
    if (read.kind === "unanswered" || read.kind === "stopped") unfinished += 1;
    if (read.kind !== "read" && read.kind !== "error") continue;
    const outcome: MCPAppsResourceReadOutcome = {
      uri,
      referencedByTools: plan.uiTools
        .filter((tool) => tool.resourceUri === uri)
        .map((tool) => tool.name),
      listed: plan.listedUiResourceUris.has(uri),
    };
    if (read.kind === "read") {
      outcomes.push({ ...outcome, result: read.result });
      results.push(read.result);
    } else {
      outcomes.push({ ...outcome, error: read.error });
    }
  }

  // The read checks grade the reads that ran, a sample when the server has
  // more UI resources than the cap. With nothing read there is nothing to
  // grade them on.
  const readsFinished = toRead.length > 0 && abandoned === 0 && unfinished === 0;
  const sampled = toRead.length < uiUris.length;
  const checkIds = MCP_APPS_CHECK_IDS.filter(
    (id) =>
      isBackgroundSafeCheck(`apps:${id}`) &&
      (readsFinished || !READ_CHECKS.includes(id)),
  );
  const checks: Partial<Record<ConformanceCheckRef, CheckStatus>> = {};
  let htmlProfileOk: boolean | undefined;
  const grading = (dependencies.grade ?? gradeMCPApps)({
    tools,
    resources,
    readOutcomes: outcomes,
    checkIds,
  });
  for (const check of grading.checks) {
    const ref: ConformanceCheckRef = `apps:${check.id}`;
    if (!isBackgroundSafeCheck(ref)) continue;
    if (check.status === "passed" || check.status === "failed") {
      checks[ref] = check.status;
    }
    if (check.id === "ui-resource-contents-valid" && check.status !== "skipped") {
      htmlProfileOk = check.status === "passed";
    }
  }

  if (readsSkipped) {
    return probeSummary("apps-ui-resources", {
      status: "skipped",
      coverage: "not-captured",
      at: input.now(),
      detail: LOCAL_LEGACY_READS_SKIPPED,
      values: { uiResourceCount: uiUris.length },
      checks,
    });
  }
  const readCount = results.length;
  return probeSummary("apps-ui-resources", {
    status: "ok",
    coverage:
      (readsFinished && !sampled) || uiUris.length === 0 ? "complete" : "partial",
    at: input.now(),
    ...(abandoned > 0
      ? { detail: "A UI resource asked for input, so reading stopped there." }
      : unfinished > 0
        ? { detail: "A UI resource read got no answer in time." }
        : sampled
          ? { detail: UI_READS_SAMPLED }
          : {}),
    values: {
      uiResourceCount: uiUris.length,
      readCount,
      readFailures: outcomes.length - readCount,
      abandonedInputRequired: abandoned,
      ...(htmlProfileOk !== undefined ? { htmlProfileOk } : {}),
      ...(readCount > 0
        ? {
            cspDeclared: contentDeclares(results, "csp"),
            permissionsDeclared: contentDeclares(results, "permissions"),
            domainDeclared: contentDeclares(results, "domain"),
            prefersBorderDeclared: contentDeclares(results, "prefersBorder"),
          }
        : {}),
    },
    checks,
  });
}
