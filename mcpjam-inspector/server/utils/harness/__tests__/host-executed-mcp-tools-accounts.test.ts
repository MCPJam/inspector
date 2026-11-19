/**
 * In-process tool policy for host-executed MCP tools on two of one person's
 * accounts.
 *
 * The run's policy snapshot is keyed by the server's tool names. The SDK
 * keeps a tool's name when the accounts' schemas match and gives each
 * account a variant when they differ, so each rule runs on both shapes.
 */
import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  buildToolPolicySnapshot,
  type EvalSuiteFileToolPolicy,
} from "@mcpjam/sdk/contract";
import { projectSelectedMcpServersAsHostTools } from "../host-executed-mcp-tools";
import { readHarnessPolicyBlockMarker } from "../harness-proxy-policy-enforcement";
import {
  ACCOUNTS,
  PERSONAL,
  SERVER_ID,
  toolsByAccountKey,
  type AccountSchemas,
} from "../../../services/evals/__tests__/helpers/account-tools";

const SHAPES: Array<{
  schemas: AccountSchemas;
  deleteTools: string[];
  listTools: string[];
}> = [
  {
    schemas: "differing",
    deleteTools: ["delete_task__work", "delete_task__personal"],
    listTools: ["list_tasks__work", "list_tasks__personal"],
  },
  { schemas: "matching", deleteTools: ["delete_task"], listTools: ["list_tasks"] },
];

function managerFor(byKey: Record<string, ToolSet>) {
  const manager = new MCPClientManager({}, { lazyConnect: true });
  vi.spyOn(manager, "getServerConfig").mockReturnValue({
    url: "https://tasks.example/mcp",
  });
  vi.spyOn(manager, "getToolsForAiSdkByServer").mockResolvedValue(byKey);
  return manager;
}

async function project(
  schemas: AccountSchemas,
  policy: EvalSuiteFileToolPolicy,
  decided: Array<{ name: string; annotations?: Record<string, unknown> }>,
) {
  const { byKey, execute } = toolsByAccountKey(schemas);
  const projected = await projectSelectedMcpServersAsHostTools({
    manager: managerFor(byKey),
    selectedServerIds: [SERVER_ID],
    connectionsByServerId: { [SERVER_ID]: ACCOUNTS },
    toolPolicy: {
      [SERVER_ID]: buildToolPolicySnapshot({ policy, tools: decided }),
    },
  });
  return { tools: projected.tools, execute };
}

/** A merged tool needs `link_id`; a variant passes it to a stub that ignores it. */
async function call(
  tools: Record<string, unknown>,
  name: string,
): Promise<unknown> {
  const projected = tools[`mcp__${SERVER_ID}__${name}`];
  if (
    typeof projected !== "object" ||
    projected === null ||
    !("execute" in projected) ||
    typeof projected.execute !== "function"
  ) {
    throw new Error(`${name} was not projected`);
  }
  return projected.execute(
    { id: "task-1", link_id: PERSONAL.connectionId },
    { toolCallId: `call-${name}`, messages: [] },
  );
}

describe.each(SHAPES)(
  "host-executed tool policy across accounts with $schemas schemas",
  ({ schemas, deleteTools, listTools }) => {
    it("blocks every account's copy of a denied tool and runs the rest", async () => {
      const { tools, execute } = await project(
        schemas,
        { mode: "default", deny: ["delete_task"] },
        [{ name: "delete_task" }, { name: "list_tasks" }],
      );

      for (const name of deleteTools) {
        expect(readHarnessPolicyBlockMarker(await call(tools, name))).toEqual({
          toolName: name,
          reason: "denyList",
          classification: "unknown",
        });
      }
      expect(execute).not.toHaveBeenCalled();
      for (const name of listTools) {
        expect(readHarnessPolicyBlockMarker(await call(tools, name))).toBeNull();
      }
      expect(execute).toHaveBeenCalledTimes(listTools.length);
    });

    it("denies every account's copy of a destructive tool by default", async () => {
      const { tools, execute } = await project(schemas, { mode: "default" }, [
        { name: "delete_task", annotations: { destructiveHint: true } },
      ]);

      for (const name of deleteTools) {
        expect(readHarnessPolicyBlockMarker(await call(tools, name))).toEqual({
          toolName: name,
          reason: "destructiveDefaultDeny",
          classification: "destructive",
        });
      }
      expect(execute).not.toHaveBeenCalled();
    });
  },
);
