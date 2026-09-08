/**
 * What a check reads when it asks "what did the server DECLARE?".
 *
 * Both cases here are the AI SDK's `ToolSet` being lossy in a way that is
 * invisible at the call site: the schema arrives wrapped, and the annotations
 * do not arrive at all. A check that reads them straight off `allTools` is not
 * merely less informed — it reports a verdict about a declaration it never
 * saw.
 */

import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import { evaluatePredicate } from "@mcpjam/sdk/predicates";
import { buildIterationTranscript } from "@mcpjam/sdk/predicates";
import {
  collectToolAnnotations,
  toTranscriptToolInventory,
} from "../transcript-evidence.js";

const SCHEMA = {
  type: "object",
  properties: { limit: { type: "number" } },
  required: ["limit"],
  additionalProperties: false,
} as const;

describe("the input schema is unwrapped from the AI SDK's Schema", () => {
  it("stores the JSON Schema, not the { jsonSchema, validate } wrapper", () => {
    // This is what `convertMCPToolsToVercelTools` stores on the automatic
    // path — the one every live eval takes.
    const inventory = toTranscriptToolInventory({
      list_orders: { inputSchema: jsonSchema(SCHEMA as never) },
    });
    expect(inventory?.[0]?.inputSchema).toMatchObject({ type: "object" });
    expect(inventory?.[0]?.inputSchema).not.toHaveProperty("validate");
  });

  it("lets argumentsMatchToolSchema see the violation", () => {
    // Against the WRAPPER this passes: an object with no constraints matches
    // everything, so a call missing a required argument is reported as
    // meeting the server's declared contract.
    const transcript = buildIterationTranscript({
      toolCalls: [{ toolName: "list_orders", arguments: { limit: "ten" } }],
      toolInventory: toTranscriptToolInventory({
        list_orders: { inputSchema: jsonSchema(SCHEMA as never) },
      }),
    });
    const result = evaluatePredicate(transcript, {
      type: "argumentsMatchToolSchema",
    });
    expect(result.passed).toBe(false);
  });

  it("passes a bare schema through untouched", () => {
    // Override-mode tools carry the schema itself.
    const inventory = toTranscriptToolInventory({
      list_orders: { inputSchema: SCHEMA },
    });
    expect(inventory?.[0]?.inputSchema).toEqual(SCHEMA);
  });
});

describe("annotations come from the manager, because the ToolSet drops them", () => {
  const manager = (
    cached: Record<string, Record<string, Record<string, unknown>>>,
  ) => ({
    listServers: () => Object.keys(cached),
    hasCachedToolAnnotations: (id: string) => id in cached,
    getAllToolAnnotations: (id: string) => cached[id] ?? {},
  });

  it("carries destructiveHint onto the inventory", () => {
    const annotations = collectToolAnnotations(
      manager({ srv: { delete_all: { destructiveHint: true } } }),
    );
    const transcript = buildIterationTranscript({
      toolCalls: [{ toolName: "delete_all", arguments: {} }],
      toolInventory: toTranscriptToolInventory(
        // No `annotations` on the tool: `dynamicTool` never sets one.
        { delete_all: { description: "Delete everything." } },
        annotations,
      ),
    });
    const result = evaluatePredicate(transcript, {
      type: "noDestructiveToolCalled",
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("destructiveHint");
  });

  it("distinguishes a cold cache from a server that declared none", () => {
    // Nobody asked ⇒ nothing to read ⇒ the check must not answer.
    expect(collectToolAnnotations(manager({}))).toBeUndefined();
    // Asked, and the server declared none ⇒ an answer, and an empty one.
    expect(
      collectToolAnnotations({
        listServers: () => ["srv"],
        hasCachedToolAnnotations: () => true,
        getAllToolAnnotations: () => ({}),
      }),
    ).toEqual({});
  });

  it("never throws a run down over evidence it cannot read", () => {
    // A manager that predates this surface, or a test double.
    expect(collectToolAnnotations(undefined)).toBeUndefined();
    expect(collectToolAnnotations({} as never)).toBeUndefined();
    expect(
      collectToolAnnotations({
        listServers: () => {
          throw new Error("not connected");
        },
        hasCachedToolAnnotations: () => true,
        getAllToolAnnotations: () => ({}),
      }),
    ).toBeUndefined();
  });
});
