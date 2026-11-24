/**
 * The parts of the mock server routes that are not HTTP: the address, the merge
 * patch, the checks a definition passes before the backend sees it, what the
 * real server holds for the fields a definition edits, and how a backend
 * refusal becomes a public error.
 */
import type { Tool } from "@modelcontextprotocol/server";
import {
  findUncallableInputs,
  realToolNameFor,
  validateMockDefinition,
  type MockDefinition,
  type MockIssue,
} from "@mcpjam/sdk/mocks";
import type { PlatformMockRealItem, PlatformMockRealServer } from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { convexErrorData, translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";

type Obj = Record<string, unknown>;

/** What a connection to the real server read: its tools and its handshake. */
export type RealServerRead = {
  tools: Tool[];
  /** Read only for the families the definition edits. */
  prompts?: Obj[];
  resources?: Obj[];
  resourceTemplates?: Obj[];
  serverInfo?: { name: string; version: string; title?: string };
  instructions?: string;
};

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

/** The definition as the SDK validates it, or a 400 naming what to fix. */
export function validatedDefinition(input: unknown): MockDefinition {
  const checked = validateMockDefinition(input);
  if (!checked.ok) throw invalidDefinition(checked.issues);
  return checked.definition;
}

/** Refuses an input change that leaves a real tool impossible to call. */
export function assertCallable(definition: MockDefinition, real: RealServerRead): void {
  const issues = findUncallableInputs(definition, real.tools);
  if (issues.length > 0) throw invalidDefinition(issues);
}

const TOOL_FIELDS = ["title", "description", "inputSchema", "outputSchema", "annotations", "icons", "_meta"] as const;

const ITEM_FIELDS = ["title", "description", "name", "mimeType", "size", "arguments", "annotations", "icons", "_meta"] as const;

/** What the real server holds today for each entry of a prompts, resources or templates map. */
function describeRealItems(
  entries: Record<string, object> | undefined,
  items: Obj[] | undefined,
  keyField: string,
): PlatformMockRealItem[] | undefined {
  if (!entries || Object.keys(entries).length === 0) return undefined;
  const byKey = new Map((items ?? []).map((item): [string, Obj] => [String(item[keyField]), item]));
  return Object.entries(entries).map(([key, entry]) => {
    const found = byKey.get(key);
    const current: Obj = {};
    for (const field of ITEM_FIELDS) {
      if ((entry as Obj)[field] !== undefined && found?.[field] !== undefined) current[field] = found[field];
    }
    return { key, found: found !== undefined, current };
  });
}

/** What the real server holds today for each field the definition edits. */
export function describeRealEdits(definition: MockDefinition, real: RealServerRead): PlatformMockRealServer {
  const byName = new Map(real.tools.map((tool): [string, Obj] => [tool.name, { ...tool }]));
  const tools = Object.entries(definition.tools ?? {}).map(([tool, entry]) => {
    const realTool = realToolNameFor(tool, entry);
    const found = byName.get(realTool);
    const current: Obj = {};
    for (const field of TOOL_FIELDS) {
      if (entry[field] !== undefined && found?.[field] !== undefined) current[field] = found[field];
    }
    const properties = isRecord(found?.inputSchema) ? found.inputSchema.properties : undefined;
    for (const param of Object.keys(entry.params ?? {})) {
      if (isRecord(properties) && properties[param] !== undefined) current[`params.${param}`] = properties[param];
    }
    return { tool, realTool, found: found !== undefined, current };
  });
  return {
    status: "read",
    ...(definition.serverInfo && real.serverInfo ? { serverInfo: real.serverInfo } : {}),
    ...(definition.instructions !== undefined && real.instructions !== undefined
      ? { instructions: real.instructions }
      : {}),
    tools,
    ...itemsField("prompts", describeRealItems(definition.prompts, real.prompts, "name")),
    ...itemsField("resources", describeRealItems(definition.resources, real.resources, "uri")),
    ...itemsField(
      "resourceTemplates",
      describeRealItems(definition.resourceTemplates, real.resourceTemplates, "uriTemplate"),
    ),
  };
}

const itemsField = (name: string, items: PlatformMockRealItem[] | undefined) =>
  items ? { [name]: items } : {};

/** The backend's own mock codes, answered with the status each deserves. */
function mockRefusal(error: unknown): WebRouteError | undefined {
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : "";
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
