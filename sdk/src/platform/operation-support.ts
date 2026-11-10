/**
 * Project and server resolution shared by every platform operation module.
 *
 * Separate from `operations.ts` so an operation module beside it can import
 * these without importing `operations.ts` back: that file builds its input
 * schemas at module load, so a value cycle through it would read a schema
 * before it exists and throw at import.
 */
import { z } from "zod";
import type { PlatformApiClient } from "./client.js";
import type { PlatformOperationContext } from "./operations.js";
import { resolveByIdOrName, resolutionError } from "./resource-selectors.js";
import {
  projectResolutionError,
  resolveProject,
  type SelectedProjectInfo,
} from "./show-servers.js";
import type { PlatformProject, PlatformProjectServer } from "./types.js";

export const PROJECT_SELECTOR_DESCRIPTION =
  "Project name or ID. Defaults to the most recently updated accessible project.";

/**
 * Resolve the caller's project selector, and REPORT what it resolved to.
 *
 * The report is the reason this is the one shared resolution path: a selector
 * is usually a name, or absent entirely, so the project id exists only here.
 * Firing `onScopeResolved` at the single point where resolution succeeds is
 * what lets an adapter build a permalink for the project the operation
 * actually read, instead of one it guessed — and doing it here rather than at
 * 154 call sites is what stops half of them from forgetting.
 */
export async function resolveProjectOrThrow(
  context: Pick<
    PlatformOperationContext,
    "client" | "signal" | "onScopeResolved"
  >,
  selector: string | undefined
): Promise<{ project: PlatformProject; sortedProjects: PlatformProject[] }> {
  const { client, signal, onScopeResolved } = context;
  const page = await client.listProjects({}, { signal });
  const resolution = resolveProject(page.items, selector);
  if (!resolution.ok) {
    throw projectResolutionError(resolution.message);
  }
  reportResolvedScope(onScopeResolved, resolution.project);
  return {
    project: resolution.project,
    sortedProjects: resolution.sortedProjects,
  };
}

/**
 * Deliver the resolved-scope receipt, best-effort.
 *
 * A caller's own synchronous failure is the caller's problem, not a reason to
 * fail an operation that already succeeded — the same contract
 * `notifyDisclosure` keeps one screen up.
 */
function reportResolvedScope(
  onScopeResolved: PlatformOperationContext["onScopeResolved"],
  project: PlatformProject
): void {
  if (!onScopeResolved) return;
  try {
    onScopeResolved({
      projectId: project.id,
      ...(project.organizationId
        ? { organizationId: project.organizationId }
        : {}),
    });
  } catch {
    // Best-effort by contract.
  }
}

export function toSelectedProjectInfo(
  project: PlatformProject
): SelectedProjectInfo {
  return {
    id: project.id,
    name: project.name,
    organizationId: project.organizationId ?? "",
  };
}

export const SERVER_SELECTOR_DESCRIPTION =
  "Server name or ID, as saved in the project.";

export const serverScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  server: z.string().trim().min(1).describe(SERVER_SELECTOR_DESCRIPTION),
});

export type ServerScopedInput = z.infer<typeof serverScopedInput>;

export type ResolvedServerInfo = { id: string; name: string };

/**
 * Resolve a server selector and require it to be hosted-operable: live ops
 * connect from the hosted runtime, which can never spawn stdio servers.
 * Failing here is deterministic and names the reason, instead of a
 * downstream connect error.
 */
export async function resolveLiveServer(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformProjectServer> {
  const page = await client.listProjectServers(
    { projectId: project.id },
    { signal }
  );
  const server = resolveByIdOrName(
    page.items,
    selector,
    "Server",
    `project "${project.name}"`
  );
  if (server.transportType === "stdio" || !server.url) {
    throw resolutionError(
      `Server "${selector.trim()}" can't run hosted operations: ${
        server.transportType === "stdio"
          ? "stdio servers are not supported on the hosted platform"
          : "it has no URL"
      }.`
    );
  }
  return server;
}

export function toServerInfo(
  server: PlatformProjectServer
): ResolvedServerInfo {
  return { id: server.id, name: server.name };
}
