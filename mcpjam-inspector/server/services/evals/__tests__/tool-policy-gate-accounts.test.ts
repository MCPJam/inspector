/**
 * Tool policy on one server reached through two of one person's accounts.
 *
 * Deny lists and annotations name the server's tools. The SDK keeps a tool's
 * name when the accounts' schemas match and gives each account its own
 * variant when they differ, so every rule here runs on both shapes.
 */
import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
  createToolPolicyGate,
  isToolPolicyBlockResult,
  toolAnnotationsKey,
} from "../tool-policy-gate";
import {
  PERSONAL,
  SERVER_ID,
  accountToolSet,
  type AccountSchemas,
} from "./helpers/account-tools";

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

/** A merged tool needs `link_id`; a variant passes it to a stub that ignores it. */
async function call(tools: ToolSet, name: string): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`${name} has no execute`);
  return execute(
    { id: "task-1", link_id: PERSONAL.connectionId },
    { toolCallId: `call-${name}`, messages: [], context: undefined },
  );
}

describe.each(SHAPES)(
  "tool policy across accounts with $schemas schemas",
  ({ schemas, deleteTools, listTools }) => {
    it("builds the shape under test", () => {
      const { tools } = accountToolSet(schemas);
      expect(Object.keys(tools)).toEqual(
        expect.arrayContaining([...deleteTools, ...listTools]),
      );
    });

    it("blocks every account's copy of a denied tool", async () => {
      const { tools, execute } = accountToolSet(schemas);
      const gate = createToolPolicyGate({
        policy: { mode: "default", deny: ["delete_task"] },
        annotations: new Map(),
      });
      const wrapped = gate.wrap(tools);

      for (const name of deleteTools) {
        expect(isToolPolicyBlockResult(await call(wrapped, name))).toBe(true);
      }
      expect(execute).not.toHaveBeenCalled();
      expect(gate.blocks.map((block) => [block.toolName, block.reason])).toEqual(
        deleteTools.map((name) => [name, "denyList"]),
      );
    });

    it("denies every account's copy of a destructive tool by default", async () => {
      const { tools, execute } = accountToolSet(schemas);
      const gate = createToolPolicyGate({
        policy: { mode: "default" },
        annotations: new Map([
          [toolAnnotationsKey(SERVER_ID, "delete_task"), { destructiveHint: true }],
        ]),
      });
      const wrapped = gate.wrap(tools);

      for (const name of deleteTools) {
        expect(isToolPolicyBlockResult(await call(wrapped, name))).toBe(true);
      }
      expect(execute).not.toHaveBeenCalled();
      expect(gate.blocks).toEqual(
        deleteTools.map((name) =>
          expect.objectContaining({
            toolName: name,
            reason: "destructiveDefaultDeny",
            classification: "destructive",
          }),
        ),
      );
    });

    it("lets every account's copy of a read-only tool run in readOnly mode", async () => {
      const { tools, execute } = accountToolSet(schemas);
      const gate = createToolPolicyGate({
        policy: { mode: "readOnly" },
        annotations: new Map([
          [toolAnnotationsKey(SERVER_ID, "list_tasks"), { readOnlyHint: true }],
        ]),
      });
      const wrapped = gate.wrap(tools);

      for (const name of listTools) {
        expect(isToolPolicyBlockResult(await call(wrapped, name))).toBe(false);
      }
      expect(execute).toHaveBeenCalledTimes(listTools.length);
      expect(gate.blocks).toEqual([]);
    });
  },
);
