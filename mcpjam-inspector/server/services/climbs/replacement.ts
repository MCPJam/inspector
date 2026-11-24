/**
 * A run that replaces one server of its environment by name.
 *
 * The launch routes take `serverReplacements` (and a climb's launches add
 * `climbId`); this module is everything the Inspector does with them. The
 * backend swaps the server in the run's own bindings, keeping the real
 * server's name there. Here the manager has to connect the replacement in the
 * real server's place, so the environment the launch resolved is rewritten
 * once, before the manager is built, and the same rewritten value is what
 * `prepareEvalRun` records the run against.
 */
import { z } from "zod";
import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { convexErrorData } from "../../routes/v1/convex-errors.js";
import {
  environmentServerIds,
  environmentServerNames,
  type ResolvedEnvironmentForLaunch,
} from "../environments/resolve.js";

export const serverReplacementSchema = z.strictObject({
  /** The real server's name in the environment. It stays the run's binding. */
  serverName: z.string().trim().min(1),
  /** The saved server that stands in for it, usually a mock. */
  replacementServerId: z.string().trim().min(1),
  /** The mock's version. Opens that version, and is recorded on the run. */
  replacementVersion: z.string().trim().min(1).max(64).optional(),
  /** Hash of the real server's listing. Read here when the caller sends none. */
  realListingHash: z.string().trim().min(1).max(128).optional(),
});

export type ServerReplacementInput = z.infer<typeof serverReplacementSchema>;

/** A replacement as the backend takes it: the hash is always present. */
export type ServerReplacement = ServerReplacementInput & {
  realListingHash: string;
};

/** The launch fields, spread into both launch bodies. */
export const climbLaunchShape = {
  serverReplacements: z.array(serverReplacementSchema).min(1).max(5).optional(),
  climbId: z.string().trim().min(1).optional(),
};

/** For `.refine(...climbRunRule)`: a climb's runs always replace a server. */
export const climbRunRule = [
  (body: { climbId?: string; serverReplacements?: unknown }) =>
    body.climbId === undefined || body.serverReplacements !== undefined,
  {
    message:
      "climbId launches the climb's own run groups, which replace a server. Send serverReplacements with it.",
  },
] as const;

/** What a launch body says about the servers it replaces. */
export type ReplacementSpec = {
  list: ServerReplacementInput[];
  climbId?: string;
  hashFor: (realServerId: string) => Promise<string>;
};

export type ReplacedServer = { serverName: string; realServerId: string };

/**
 * The environment with each named server swapped for its replacement. A name
 * the environment does not have is refused here, before any connection.
 */
export async function applyServerReplacements(
  environment: ResolvedEnvironmentForLaunch | undefined,
  replacements: readonly ServerReplacementInput[],
  hashFor: (realServerId: string) => Promise<string>,
): Promise<{
  environment: ResolvedEnvironmentForLaunch;
  replacements: ServerReplacement[];
  replaced: ReplacedServer[];
}> {
  if (!environment) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "serverReplacements replaces one server of an environment. Launch an environment of this suite, or attach one first.",
      { reason: "REPLACEMENT_NEEDS_ENVIRONMENT" },
    );
  }
  if (!Array.isArray(environment.servers)) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "This backend does not list the environment's servers by name, so a server cannot be replaced. Update the backend, then try again.",
      { reason: "REPLACEMENT_UNSUPPORTED" },
    );
  }
  const servers = environment.servers.map((server) => ({ ...server }));
  const replaced: ReplacedServer[] = [];
  const recorded: ServerReplacement[] = [];
  for (const replacement of replacements) {
    const key = replacement.serverName.toLowerCase();
    const at = servers.findIndex((server) => server.name.trim().toLowerCase() === key);
    if (at < 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `The environment has no server named "${replacement.serverName}" to replace. Name a server of the environment, as list_project_servers shows it.`,
        { reason: "REPLACEMENT_SERVER_NOT_IN_ENVIRONMENT", serverName: replacement.serverName },
      );
    }
    const realServerId = servers[at]!.serverId;
    servers[at] = { ...servers[at]!, serverId: replacement.replacementServerId };
    replaced.push({ serverName: servers[at]!.name, realServerId });
    recorded.push({
      ...replacement,
      realListingHash: replacement.realListingHash ?? (await hashFor(realServerId)),
    });
  }
  return { environment: { ...environment, servers }, replacements: recorded, replaced };
}

const getMock = makeFunctionReference<"query">("mockServers:getMock");

export type MockPin = { serverId: string; version: number; contentHash: string };

/**
 * The mock versions a launch opens, and the pins the run records. A
 * replacement with no version, or one that is not a mock, opens the head and
 * pins nothing.
 */
export async function resolveMockPins(
  convex: Pick<ConvexHttpClient, "query">,
  replacements: readonly ServerReplacement[],
): Promise<{ mockVersions: Record<string, number>; mockPins: MockPin[] }> {
  const mockVersions: Record<string, number> = {};
  const mockPins: MockPin[] = [];
  for (const replacement of replacements) {
    const version = Number(replacement.replacementVersion);
    if (!Number.isInteger(version) || version < 1) continue;
    let row: { contentHash?: unknown } | null;
    try {
      row = await convex.query(getMock, { mockId: replacement.replacementServerId, version });
    } catch (error) {
      if (isNotAMock(error)) continue;
      throw error;
    }
    if (typeof row?.contentHash !== "string") continue;
    mockVersions[replacement.replacementServerId] = version;
    mockPins.push({ serverId: replacement.replacementServerId, version, contentHash: row.contentHash });
  }
  return { mockVersions, mockPins };
}

/** `MOCK_NOT_FOUND` on the server id: an ordinary saved server, not a mock. */
function isNotAMock(error: unknown): boolean {
  return convexErrorData(error)?.code === "MOCK_NOT_FOUND";
}

/** What a launch with replacements carries into its manager and its run. */
export type ReplacementLaunch = {
  replacements: ServerReplacement[];
  mockVersions: Record<string, number>;
  mockPins: MockPin[];
  climbId?: string;
};

/**
 * Rewrites a resolved environment for a launch that replaces servers, and
 * reads what the run records about them. The whole step, so a launch route
 * calls it once after it resolves the environment.
 */
export async function resolveReplacementLaunch(
  convex: Pick<ConvexHttpClient, "query">,
  environment: ResolvedEnvironmentForLaunch | undefined,
  spec: ReplacementSpec,
): Promise<{
  environment: ResolvedEnvironmentForLaunch;
  serverIds: string[];
  serverNames: string[];
  launch: ReplacementLaunch;
}> {
  const applied = await applyServerReplacements(environment, spec.list, spec.hashFor);
  const pins = await resolveMockPins(convex, applied.replacements);
  return {
    environment: applied.environment,
    serverIds: environmentServerIds(applied.environment),
    serverNames: environmentServerNames(applied.environment),
    launch: {
      replacements: applied.replacements,
      ...pins,
      ...(spec.climbId ? { climbId: spec.climbId } : {}),
    },
  };
}
