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

type ClientEnvironment = { id: string; name?: string };

/**
 * The suite's attached environment that runs the selected client. Attached
 * environments are read by id because unnamed composed rows are missing from
 * the project listing. A lookup failure propagates: guessing past it could
 * launch the wrong target.
 */
async function clientEnvironment(
  client: PlatformApiClient,
  project: PlatformProject,
  detail: PlatformEvalSuiteDetail | undefined,
  selector: string,
  signal: AbortSignal | undefined
): Promise<ClientEnvironment | undefined> {
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
    const named = clients.items.some(
      (candidate) =>
        candidate.id === clientId ||
        candidate.name?.toLocaleLowerCase() === clientId.toLocaleLowerCase()
    );
    if (named) {
      clientId = resolveByIdOrName(
        clients.items,
        selector,
        "Client",
        `project "${project.name}"`
      ).id;
    }
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

/**
 * Client selectors resolved to the suite's saved target axes, by id or unique
 * name. Validated here so a fan-out cannot spend on its first targets and then
 * discover a bad one. A client that is not a direct host attachment runs
 * through its attached environment.
 */
export async function resolveSuiteHostTargets(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  detail: PlatformEvalSuiteDetail | undefined,
  selectors: string[],
  signal: AbortSignal | undefined
): Promise<{ hosts: RunTargetHost[]; environments: ClientEnvironment[] }> {
  const hosts: RunTargetHost[] = [];
  const environments: ClientEnvironment[] = [];
  const attached = detail?.hosts ?? [];
  for (const selector of selectors) {
    const wanted = selector.trim().toLocaleLowerCase();
    const direct = attached.some(
      (host) =>
        host.id === selector.trim() || host.name?.toLocaleLowerCase() === wanted
    );
    if (!direct) {
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
