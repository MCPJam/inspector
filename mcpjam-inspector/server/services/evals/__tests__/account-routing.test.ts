/**
 * Recorded calls from a multi-account turn, read back as the server's tools.
 *
 * A case's expected calls name the server's tools with the server's
 * arguments. The SDK's merged tool adds `link_id` and its variants rename the
 * tool per account, so a turn's calls are graded only after routing undoes
 * both, and only for the tools the turn's own tool set says were changed.
 */
import { describe, expect, it } from "vitest";
import { mergeConnectionToolsets } from "@mcpjam/sdk";
import { evaluateToolCalls, type ToolCall } from "@/shared/eval-matching";
import {
  extractToolCallsFromConversation,
  type ProjectedToolCall,
} from "@/shared/eval-tool-call-projection";
import { extractToolCallsFromEnvelopeMessages } from "../../checks/chat-session-envelope";
import {
  accountRoutingFromTools,
  routeToolCalls,
  serverToolName,
} from "../account-routing";
import {
  PERSONAL,
  SERVER_ID,
  WORK,
  accountToolSet,
  toolsByAccountKey,
} from "./helpers/account-tools";

function assistant(...calls: Array<Record<string, unknown>>) {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "tool-call", ...call })),
  };
}

function routedCalls(
  schemas: "matching" | "differing",
  messages: unknown[],
  steps?: unknown[],
) {
  const routing = accountRoutingFromTools(accountToolSet(schemas).tools);
  return routeToolCalls(
    extractToolCallsFromConversation({ messages, ...(steps ? { steps } : {}) }),
    routing,
  );
}

/** The matcher's call shape, which takes arguments as an object. */
function asMatcherCalls(calls: ProjectedToolCall[]): ToolCall[] {
  return calls.map(({ toolName, arguments: args }) => ({
    toolName,
    arguments: typeof args === "object" && args !== null ? { ...args } : {},
  }));
}

describe("a turn without account groups", () => {
  it("has no routing, so its projection passes through as the same array", () => {
    const { byKey } = toolsByAccountKey("matching");
    const calls = extractToolCallsFromConversation({
      messages: [assistant({ toolName: "delete_task", input: { id: "task-1" } })],
    });

    expect(accountRoutingFromTools(byKey[WORK.key])).toBeUndefined();
    expect(routeToolCalls(calls, undefined)).toBe(calls);
  });

  it("has no routing when a server's group holds one account", () => {
    const { byKey } = toolsByAccountKey("matching");
    const tools = mergeConnectionToolsets(
      { [WORK.key]: byKey[WORK.key] },
      { [SERVER_ID]: [WORK] },
      { snapshot: new Map([[WORK.connectionId, WORK.key]]) },
    );

    expect(Object.keys(tools)).toEqual(["delete_task", "list_tasks", "link_task"]);
    expect(accountRoutingFromTools(tools)).toBeUndefined();
  });
});

describe("a merged tool", () => {
  it("passes exact argument matching once the account selector is removed", () => {
    const messages = [
      assistant({
        toolName: "delete_task",
        toolCallId: "call-1",
        input: { id: "task-1", link_id: PERSONAL.connectionId },
      }),
    ];
    const expected = [{ toolName: "delete_task", arguments: { id: "task-1" } }];
    const exact = { argumentMatching: "exact" } as const;

    expect(
      evaluateToolCalls(
        expected,
        asMatcherCalls(extractToolCallsFromConversation({ messages })),
        exact,
      ).passed,
    ).toBe(false);
    const routed = routedCalls("matching", messages);
    expect(routed).toEqual([
      { toolName: "delete_task", arguments: { id: "task-1" }, toolCallId: "call-1" },
    ]);
    expect(evaluateToolCalls(expected, asMatcherCalls(routed), exact).passed).toBe(
      true,
    );
  });
});

describe("a per-account variant", () => {
  it("grades as the server's tool, with the arguments it was called with", () => {
    const routed = routedCalls("differing", [
      assistant({
        toolName: "delete_task__personal",
        toolCallId: "call-1",
        input: { id: "task-1", archived: true },
      }),
    ]);

    expect(routed).toEqual([
      {
        toolName: "delete_task",
        arguments: { id: "task-1", archived: true },
        toolCallId: "call-1",
      },
    ]);
    expect(
      evaluateToolCalls(
        [{ toolName: "delete_task", arguments: { id: "task-1" } }],
        asMatcherCalls(routed),
      ).passed,
    ).toBe(true);
  });

  it("keeps a link_id the server's own schema declares", () => {
    const { tools } = accountToolSet("matching");
    expect(serverToolName(tools.link_task__work, "link_task__work")).toBe(
      "link_task",
    );

    expect(
      routedCalls("matching", [
        assistant({
          toolName: "link_task__work",
          toolCallId: "call-1",
          input: { id: "task-1", link_id: "parent-7" },
        }),
      ]),
    ).toEqual([
      {
        toolName: "link_task",
        arguments: { id: "task-1", link_id: "parent-7" },
        toolCallId: "call-1",
      },
    ]);
  });
});

describe("calls without an id", () => {
  it("to two accounts with the same arguments stay two calls", () => {
    const sameTask = { id: "task-1" };
    const throughSelector = routedCalls("matching", [
      assistant(
        { toolName: "delete_task", input: { ...sameTask, link_id: WORK.connectionId } },
        { toolName: "delete_task", input: { ...sameTask, link_id: PERSONAL.connectionId } },
      ),
    ]);
    const throughVariants = routedCalls("differing", [
      assistant(
        { toolName: "delete_task__work", input: sameTask },
        { toolName: "delete_task__personal", input: sameTask },
      ),
    ]);

    for (const calls of [throughSelector, throughVariants]) {
      expect(calls).toEqual([
        { toolName: "delete_task", arguments: sameTask },
        { toolName: "delete_task", arguments: sameTask },
      ]);
    }
  });

  it("seen in a step and in its message still count once", () => {
    const input = { id: "task-1", link_id: WORK.connectionId };
    const calls = routedCalls(
      "matching",
      [assistant({ toolName: "delete_task", input })],
      [{ toolCalls: [{ toolName: "delete_task", args: input }] }],
    );

    expect(calls).toEqual([
      { toolName: "delete_task", arguments: { id: "task-1" } },
    ]);
  });
});

describe("chat checks", () => {
  it("keep each call exactly as the model made it", () => {
    expect(
      extractToolCallsFromEnvelopeMessages([
        assistant(
          { toolName: "delete_task", input: { id: "task-1", link_id: WORK.connectionId } },
          { toolName: "delete_task__personal", input: { id: "task-1" } },
        ),
      ]),
    ).toEqual([
      {
        toolName: "delete_task",
        arguments: { id: "task-1", link_id: WORK.connectionId },
      },
      { toolName: "delete_task__personal", arguments: { id: "task-1" } },
    ]);
  });
});
