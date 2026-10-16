import type { PlatformApiClient } from "./client.js";
import type {
  PlatformProject,
  PlatformEvalSuite,
  PlatformEvalSuiteDetail,
} from "./types.js";
import type { RunTargetHost } from "./suite-run-plans.js";
import {
  formatResourceList,
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

/** Resolve an attached client's environment, including unnamed composed rows. */
async function clientEnvironment(
  client: PlatformApiClient,
  project: PlatformProject,
  detail: PlatformEvalSuiteDetail | undefined,
  selector: string,
  signal: AbortSignal | undefined
): Promise<{ id: string; name?: string } | undefined> {
  const attached = await Promise.all(
    (detail?.environmentIds ?? []).map((environmentId) =>
      client.getEnvironment(
        { projectId: project.id, environmentId },
        { signal }
      )
    )
  );
  let clientId = selector.trim();
  if (
    attached.length > 0 &&
    !attached.some((environment) => environment.hostId === clientId)
  ) {
    const clients = await client.listClients(
      { projectId: project.id },
      { signal }
    );
    const matches = clients.items.filter(
      (candidate) =>
        candidate.id === clientId ||
        candidate.name?.toLocaleLowerCase() === clientId.toLocaleLowerCase()
    );
    if (matches.length > 0)
      clientId = resolveByIdOrName(
        clients.items,
        selector,
        "Client",
        `project "${project.name}"`
      ).id;
  }
  const matches = attached.filter(
    (environment) => environment.hostId === clientId
  );
  if (matches.length > 1) {
    throw operationInputError(
      `TARGET_REQUIRED: Client "${selector}" has several attached environments: ${formatResourceList(
        matches
      )}. Select one with environment.`
    );
  }
  const environment = matches[0];
  return environment
    ? {
        id: environment.id,
        ...(environment.name ? { name: environment.name } : {}),
      }
    : undefined;
}

/** Resolve clients to their saved target axis before any launch can spend. */
export async function resolveSuiteHostTargets(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  detail: PlatformEvalSuiteDetail | undefined,
  selectors: string[],
  signal: AbortSignal | undefined
): Promise<{
  hosts: RunTargetHost[];
  environments: Array<{ id: string; name?: string }>;
}> {
  const hosts: RunTargetHost[] = [];
  const environments: Array<{ id: string; name?: string }> = [];
  const attached = detail?.hosts ?? [];
  for (const selector of selectors) {
    const matched = attached.some(
      (host) =>
        host.id === selector.trim() ||
        host.name?.toLocaleLowerCase() === selector.trim().toLocaleLowerCase()
    );
    if (!matched) {
      const environment = await clientEnvironment(
        client,
        project,
        detail,
        selector,
        signal
      );
      if (environment) {
        environments.push(environment);
        continue;
      }
    }
    if (attached.length === 0) {
      throw operationInputError(
        `Suite "${
          suite.name ?? suite.id
        }" has no attached hosts, so there is no host to run. Attach one to the suite first, or omit the host selector.`
      );
    }
    hosts.push(
      resolveByIdOrName(
        attached,
        selector,
        "Suite host",
        `suite "${suite.name ?? suite.id}"`
      )
    );
  }
  return { hosts, environments };
}
