/**
 * A multi-account turn's tools, read back as the server's own tools.
 *
 * With several of one person's accounts on a server, the SDK's
 * `mergeConnectionToolsets` gives the model either one merged tool that keeps
 * the server's tool name and takes a required `link_id` naming the account,
 * or, when the accounts' schemas differ, one variant per account named
 * `<tool>__<account>`. Tool policy and a case's expected calls are written
 * against the server's tool names, so both have to see through this: policy
 * decides a variant as the server's tool, and a recorded call names the
 * server's tool without the `link_id` the SDK added.
 *
 * Everything here reads the metadata the SDK stamps on each tool, never the
 * name. A server may use `__` in its own tool names, and a server's own tool
 * may take a `link_id`; the SDK never merges such a tool, so a merged tool's
 * `link_id` is always the SDK's and a variant's arguments are the server's.
 */

/** The argument the SDK adds to a merged tool to pick the account. */
const ACCOUNT_SELECTOR = "link_id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The server's own name for the tool a turn's tool set holds under `key`:
 * `_mcpToolName` when the SDK set one, otherwise the key itself.
 */
export function serverToolName(tool: unknown, key: string): string {
  const name = isRecord(tool) ? tool._mcpToolName : undefined;
  return typeof name === "string" && name.length > 0 ? name : key;
}

type ToolRoute = {
  /** The server's own name for the tool. */
  serverToolName: string;
  /** A merged tool: its `link_id` was added by the SDK, not the server. */
  selectsAccount: boolean;
};

/** The tools of one turn whose recorded calls differ from the server's own. */
export type AccountRouting = ReadonlyMap<string, ToolRoute>;

/**
 * Read the routing off the tool set a turn ran with.
 *
 * Undefined when no tool needs it, which is every turn without account
 * groups, so their projections pass through untouched.
 */
export function accountRoutingFromTools(
  tools: Readonly<Record<string, unknown>> | undefined,
): AccountRouting | undefined {
  const routes = new Map<string, ToolRoute>();
  for (const [key, tool] of Object.entries(tools ?? {})) {
    if (!isRecord(tool)) continue;
    const name = serverToolName(tool, key);
    // A merged tool lists the accounts its `link_id` chooses between, even
    // when only one account has the tool. A variant, or the tool of a
    // server's only account, names its one account instead.
    const selectsAccount = Array.isArray(tool._connectionIds);
    if (name !== key || selectsAccount) {
      routes.set(key, { serverToolName: name, selectsAccount });
    }
  }
  return routes.size > 0 ? routes : undefined;
}

function withoutAccountSelector(args: unknown): unknown {
  if (!isRecord(args) || !Object.hasOwn(args, ACCOUNT_SELECTOR)) return args;
  const { [ACCOUNT_SELECTOR]: _account, ...serverArgs } = args;
  return serverArgs;
}

/**
 * Each call as the server's tool, without the account selector the SDK added.
 *
 * Apply it to a projection that is already deduplicated. Two id-less calls
 * to different accounts with the same arguments differ only in what this
 * removes, so deduplicating afterwards would count them as one call.
 */
export function routeToolCalls<
  T extends { toolName: string; arguments: unknown },
>(calls: T[], routing: AccountRouting | undefined): T[] {
  if (!routing) return calls;
  return calls.map((call) => {
    const route = routing.get(call.toolName);
    if (!route) return call;
    return {
      ...call,
      toolName: route.serverToolName,
      arguments: route.selectsAccount
        ? withoutAccountSelector(call.arguments)
        : call.arguments,
    };
  });
}
