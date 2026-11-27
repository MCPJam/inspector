/**
 * The parts of the mock server routes that are not HTTP: the merge patch, the
 * checks a definition passes before the backend sees it, the listing of the
 * real server saved with a new mock, the small read's counts and paths, and
 * how a backend refusal becomes a public error.
 */
import type { Tool } from "@modelcontextprotocol/server";
import {
  changeEntries,
  checkSavedOutputs,
  findInvalidSchemas,
  findUncallableInputs,
  validateMockDefinition,
  type MockDefinition,
  type MockIssue,
  type RealToolInputShape,
} from "@mcpjam/sdk/mocks";
import type { PlatformMockCounts } from "@mcpjam/sdk/platform";
import { MOCK_SERVERS_FLAG } from "../../../shared/mock-address.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { convexErrorData, translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";

type Obj = Record<string, unknown>;

/** What a connection to the real server read: its tools, other lists and its handshake. */
export type RealServerRead = {
  tools: Tool[];
  prompts?: Obj[];
  resources?: Obj[];
  resourceTemplates?: Obj[];
  serverInfo?: { name: string; version: string; title?: string };
  instructions?: string;
  capabilities?: Obj;
};

/** B1 refuses a saved listing over this many bytes. */
const MAX_DISCOVERY_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** RFC 7396: an object merges key by key, null removes a key, anything else replaces. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  const merged: Obj = isRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = applyMergePatch(merged[key], value);
  }
  return merged;
}

function invalidDefinition(issues: MockIssue[]): WebRouteError {
  const first = issues[0]!;
  const more = issues.length > 1 ? ` ${issues.length - 1} more in details.issues.` : "";
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `The mock definition is not valid at "${first.path || "(root)"}": ${first.message}${more}`,
    { code: "MOCK_DEFINITION_INVALID", issues },
  );
}

/**
 * The definition as the SDK validates it, or a 400 naming what to fix. Create,
 * save and patch all pass through here, so a saved result that breaks its
 * tool's output schema (or a schema that does not compile) is refused at
 * every one of them.
 */
export function validatedDefinition(input: unknown): MockDefinition {
  const checked = validateMockDefinition(input);
  if (!checked.ok) throw invalidDefinition(checked.issues);
  const outputIssues = checkSavedOutputs(checked.definition);
  if (outputIssues.length > 0) throw invalidDefinition(outputIssues);
  return checked.definition;
}

/**
 * Refuses a definition that cannot be served, before the backend sees it:
 * - a change that leaves a real tool impossible to call (a parameter the real
 *   tool requires that the client can no longer send, or one it would refuse),
 *   checked against the listing the version is saved with: the base's on
 *   create, the version's saved listing on a patch or a save. With no listing
 *   there is nothing to check this against, so the save goes on;
 * - a tool whose input or output schema is not valid JSON Schema (named by its
 *   field path), which no client could read.
 */
export function assertCallable(definition: MockDefinition, tools: RealToolInputShape[] | undefined): void {
  const issues = [
    ...findInvalidSchemas(definition),
    ...(tools ? findUncallableInputs(definition, tools) : []),
  ];
  if (issues.length > 0) throw invalidDefinition(issues);
}

/** The tools of a saved listing (the text B1 stores with a version), or undefined when there is none. */
export function savedTools(listingJson: string | undefined): RealToolInputShape[] | undefined {
  return listingJson === undefined ? undefined : (JSON.parse(listingJson) as { tools?: RealToolInputShape[] }).tools;
}

/**
 * The real server's listing as it is now, for B1 to pin with the version, or
 * undefined when it is over the size B1 accepts even without its secondary
 * lists (then the version has no pinned listing and a blocked mock lists none).
 */
export function discoveryOf(real: RealServerRead): string | undefined {
  const base = {
    ...(real.serverInfo && { serverInfo: real.serverInfo }),
    ...(real.instructions !== undefined && { instructions: real.instructions }),
    ...(real.capabilities && { capabilities: real.capabilities }),
  };
  const full = JSON.stringify({
    ...base,
    tools: real.tools,
    ...(real.prompts && { prompts: real.prompts }),
    ...(real.resources && { resources: real.resources }),
    ...(real.resourceTemplates && { resourceTemplates: real.resourceTemplates }),
  });
  if (Buffer.byteLength(full) <= MAX_DISCOVERY_BYTES) return full;
  const toolsOnly = JSON.stringify({ ...base, tools: real.tools });
  return Buffer.byteLength(toolsOnly) <= MAX_DISCOVERY_BYTES ? toolsOnly : undefined;
}

export function countsOf(definition: MockDefinition): PlatformMockCounts {
  const size = (map: object | undefined) => (map ? Object.keys(map).length : 0);
  return {
    changes: changeEntries(definition).length,
    tools: size(definition.tools),
    prompts: size(definition.prompts),
    resources: size(definition.resources),
    resourceTemplates: size(definition.resourceTemplates),
  };
}

/** The backend's own mock codes, answered with the status each deserves. */
function mockRefusal(error: unknown): WebRouteError | undefined {
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : "";
  if (code === "MOCK_SERVERS_FLAG_OFF") {
    return new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      `Mock servers are turned off for this account (the ${MOCK_SERVERS_FLAG} flag is off). Ask an MCPJam admin to turn it on, then try again.`,
      { code, flag: MOCK_SERVERS_FLAG },
    );
  }
  if (!code.startsWith("MOCK_")) return undefined;
  const message =
    typeof data?.message === "string" && data.message.trim() ? data.message : "The mock server request was refused.";
  if (code === "MOCK_NOT_FOUND" || code === "MOCK_VERSION_NOT_FOUND") {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, message, { code });
  }
  if (code === "MOCK_VERSION_STALE") {
    const headVersion = (data as { headVersion?: unknown } | null)?.headVersion;
    return new WebRouteError(409, ErrorCode.CONFLICT, message, {
      code,
      ...(typeof headVersion === "number" ? { headVersion } : {}),
    });
  }
  // A refusal of the caller's role, not of their input: 403, with the backend's code kept in `details`.
  if (code === "MOCK_POLICY_ADMIN_ONLY") {
    return new WebRouteError(403, ErrorCode.FORBIDDEN, message, { code });
  }
  if (code === "MOCK_ANNOTATION_LOOSENING_FORBIDDEN") {
    return new WebRouteError(403, ErrorCode.FORBIDDEN, message, {
      code,
      ...(Array.isArray((data as { tools?: unknown } | null)?.tools) ? { tools: (data as { tools: unknown }).tools } : {}),
    });
  }
  // The rest (a missing name, an unusable base server, a definition over a cap) are the caller's to fix.
  return new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message, { code });
}

/** A failed create or save. */
export function translateMockWriteError(error: unknown): WebRouteError {
  return (
    mockRefusal(error) ??
    translateConvexWriteError(error, {
      resource: "Mock server",
      conflictMessage: "A server with that name already exists in this workspace. Pick another name.",
      fallbackMessage: "Mock server write rejected",
    })
  );
}

/** A failed read of one mock; a caller who cannot see it learns nothing from it. */
export function translateMockReadError(error: unknown): WebRouteError {
  return (
    mockRefusal(error) ??
    translateConvexReadError(error, {
      scope: "v1.mock-servers",
      notFoundMessage: "Mock server not found",
      redactedIsRefusal: true,
    })
  );
}
