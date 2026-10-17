import type { PlatformApiClient } from "./client.js";
import type {
  PlatformProject,
  PlatformEvalSuite,
  PlatformEvalSuiteDetail,
} from "./types.js";
import type { RunTargetHost } from "./suite-run-plans.js";
import {
  operationInputError,
  resolveByIdOrName,
} from "./resource-selectors.js";

/**
 * Display names for a suite's attached environment ids.
 *
 * BEST EFFORT on purpose: these names are read by people, never matched on, so
 * a listing that fails or omits a row costs a nicer message and nothing else.
 * Failing the launch over it would trade a real run for a cosmetic lookup.
 */
export async function environmentNamesFor(
  client: PlatformApiClient,
  project: PlatformProject,
  environmentIds: string[],
  signal: AbortSignal | undefined
): Promise<Map<string, string>> {
  if (environmentIds.length === 0) return new Map();
  try {
    const page = await client.listEnvironments(
      { projectId: project.id },
      { signal }
    );
    const wanted = new Set(environmentIds);
    return new Map(
      page.items
        .filter((environment) => wanted.has(environment.id) && environment.name)
        .map((environment) => [environment.id, environment.name])
    );
  } catch {
    return new Map();
  }
}

/** Host selectors → attached hosts, by id or unique name. Same rationale as
 *  the environment resolver above: validated here so a fan-out cannot spend on
 *  its first targets and then discover a bad one. */
export function resolveSuiteHostTargets(
  suite: PlatformEvalSuite,
  detail: PlatformEvalSuiteDetail | undefined,
  selectors: string[]
): RunTargetHost[] {
  if (selectors.length === 0) return [];
  const hosts = detail?.hosts ?? [];
  if (hosts.length === 0) {
    throw operationInputError(
      `Suite "${
        suite.name ?? suite.id
      }" has no attached hosts, so there is no host to run. Attach one to the suite first, or omit the host selector.`
    );
  }
  return selectors.map((selector) =>
    resolveByIdOrName(
      hosts,
      selector,
      "Suite host",
      `suite "${suite.name ?? suite.id}"`
    )
  );
}
