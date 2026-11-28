/**
 * What the route needs to know about a request before the SDK runtime serves
 * it: whether it opens a 2026-07-28 change stream (and for what), and whether
 * it is a task-augmented `tools/call` on 2025-11-25. Read from the headers and
 * a copy of the body; a body that is not JSON-RPC is the runtime's to refuse,
 * so it yields no facts.
 */
import type { SubscriptionFilterShape } from "@mcpjam/sdk";

export const MODERN_REVISION = "2026-07-28";
export const TASKS_LEGACY_REVISION = "2025-11-25";
const MAX_BODY_BYTES = 1_048_576;

export interface MockRequestFacts {
  /** The revision the request names in `MCP-Protocol-Version`, if any. */
  revision?: string;
  /** Set for a `subscriptions/listen` on 2026-07-28: what the stream asked to hear. */
  listen?: SubscriptionFilterShape;
  /** A 2025-11-25 `tools/call` that asks to run as a task. */
  taskCall?: { tool: string };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function listenFilter(params: unknown): SubscriptionFilterShape {
  const asked = isObject(params) && isObject(params.notifications) ? params.notifications : {};
  const uris = Array.isArray(asked.resourceSubscriptions)
    ? asked.resourceSubscriptions.filter((uri): uri is string => typeof uri === "string")
    : [];
  return {
    ...(asked.toolsListChanged === true && { toolsListChanged: true }),
    ...(asked.promptsListChanged === true && { promptsListChanged: true }),
    ...(asked.resourcesListChanged === true && { resourcesListChanged: true }),
    ...(uris.length > 0 && { resourceSubscriptions: uris }),
  };
}

export async function readRequestFacts(request: Request): Promise<MockRequestFacts> {
  const revision = request.headers.get("mcp-protocol-version") ?? undefined;
  const facts: MockRequestFacts = { ...(revision && { revision }) };
  if (request.method !== "POST") return facts;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return facts;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return facts;
  }
  if (!isObject(body)) return facts;
  if (body.method === "subscriptions/listen" && revision === MODERN_REVISION) {
    facts.listen = listenFilter(body.params);
  } else if (
    body.method === "tools/call" &&
    revision === TASKS_LEGACY_REVISION &&
    isObject(body.params) &&
    isObject(body.params.task) &&
    typeof body.params.name === "string"
  ) {
    facts.taskCall = { tool: body.params.name };
  }
  return facts;
}

/**
 * Whether a real server takes a tool call as a task on a revision: the
 * 2025-11-25 `tasks.requests.tools.call` capability. 2026-07-28 declares tasks
 * as an extension a caller opts into per request, which a forward never makes,
 * so it is not a task-augmented call.
 */
export function realRunsToolTasks(capabilities: unknown): boolean {
  const tasks = isObject(capabilities) ? capabilities.tasks : undefined;
  const requests = isObject(tasks) ? tasks.requests : undefined;
  const tools = isObject(requests) ? requests.tools : undefined;
  return isObject(tools) && isObject(tools.call);
}
