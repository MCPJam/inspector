/**
 * One server's tools on two of one person's accounts, merged by the SDK the
 * way a turn merges them.
 *
 * With `matching` schemas the SDK keeps each tool's name and adds `link_id`;
 * with `differing` schemas it makes one variant per account. `link_task`
 * takes a `link_id` of its own, so the SDK never merges it.
 */
import { jsonSchema, type JSONSchema7, type Tool, type ToolSet } from "ai";
import { vi } from "vitest";
import { mergeConnectionToolsets, type McpToolConnection } from "@mcpjam/sdk";

export const SERVER_ID = "tasks";

export const WORK: McpToolConnection = {
  serverId: SERVER_ID,
  connectionId: "a".repeat(32),
  key: SERVER_ID,
  label: "Work",
  isDefault: true,
};

export const PERSONAL: McpToolConnection = {
  serverId: SERVER_ID,
  connectionId: "b".repeat(32),
  key: `${SERVER_ID}#${"b".repeat(32)}`,
  label: "Personal",
};

export const ACCOUNTS: McpToolConnection[] = [WORK, PERSONAL];

export type AccountSchemas = "matching" | "differing";

/** Each account's own tools, keyed by its manager key, before the merge. */
export function toolsByAccountKey(schemas: AccountSchemas) {
  const execute = vi.fn(async () => ({ content: [] }));
  const toolWith = (properties: Record<string, JSONSchema7>): Tool => ({
    inputSchema: jsonSchema({ type: "object", properties }),
    execute,
  });
  const accountTools = (extra: Record<string, JSONSchema7>): ToolSet => ({
    delete_task: toolWith({ id: { type: "string" }, ...extra }),
    list_tasks: toolWith({ ...extra }),
    link_task: toolWith({ id: { type: "string" }, link_id: { type: "string" } }),
  });
  const byKey: Record<string, ToolSet> = {
    [WORK.key]: accountTools({}),
    [PERSONAL.key]: accountTools(
      schemas === "differing" ? { archived: { type: "boolean" } } : {},
    ),
  };
  return { byKey, execute };
}

/** The turn's tool set: both accounts' tools, merged by the SDK. */
export function accountToolSet(schemas: AccountSchemas) {
  const { byKey, execute } = toolsByAccountKey(schemas);
  const tools = mergeConnectionToolsets(
    byKey,
    { [SERVER_ID]: ACCOUNTS },
    {
      snapshot: new Map(
        ACCOUNTS.map((account) => [account.connectionId, account.key]),
      ),
    },
  );
  return { tools, execute };
}
