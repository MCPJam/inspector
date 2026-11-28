/**
 * Capabilities Consistent (check 5), graded from scripted list answers.
 *
 * Catalog rows: 5.P1 / 5.P2 pass, 5.F1 a listing served without its
 * declaration, 5.F2 (2026-07-28 only) a declared listing that errors, 5.W1 a
 * listing MCPJam could not get an answer to.
 */

import { describe, expect, it } from "vitest";
import { CORE_CHECKS } from "../../src/mcp-conformance/checks/core.js";
import type { MCPClientCheckContext } from "../../src/mcp-conformance/types.js";

const CHECK = CORE_CHECKS.find((entry) => entry.id === "capabilities-consistent")!;

type Answer =
  | { items: number }
  | { code: number }
  | { httpStatus: number }
  | "timeout"
  | "network"
  | "invalid";

function rpcError(code: number) {
  return Object.assign(new Error(`MCP error ${code}`), { code });
}

function context(options: {
  era: "legacy" | "modern";
  capabilities: Record<string, unknown>;
  answers?: Record<string, Answer>;
  listed?: Partial<Record<"tools" | "prompts" | "resources", number>>;
  unlisted?: Array<"tools" | "prompts" | "resources" | "resourceTemplates">;
}) {
  const sent: string[] = [];
  const keyOf: Record<string, string> = {
    "tools/list": "tools",
    "prompts/list": "prompts",
    "resources/list": "resources",
    "resources/templates/list": "resourceTemplates",
  };
  const client = {
    requestWithSchema: async (request: { method: string }) => {
      sent.push(request.method);
      const answer = options.answers?.[request.method] ?? { code: -32601 };
      if (answer === "timeout") {
        // The client's own timeout (SdkErrorCode.RequestTimeout).
        throw Object.assign(new Error("Request timed out"), {
          code: "REQUEST_TIMEOUT",
        });
      }
      if (answer === "network") throw new TypeError("fetch failed");
      if (answer === "invalid") {
        // The client read an answer it could not accept (SdkErrorCode.InvalidResult).
        throw Object.assign(new Error(`Invalid result for ${request.method}`), {
          code: "INVALID_RESULT",
        });
      }
      if ("code" in answer) throw rpcError(answer.code);
      if ("httpStatus" in answer) {
        throw Object.assign(
          new Error(`Error POSTing to endpoint (HTTP ${answer.httpStatus})`),
          { code: "CLIENT_HTTP_NOT_IMPLEMENTED", data: { status: answer.httpStatus } }
        );
      }
      return {
        [keyOf[request.method]]: Array.from({ length: answer.items }, (_, i) => ({
          name: `item-${i}`,
        })),
      };
    },
  };
  const names = (n = 0) => Array.from({ length: n }, (_, i) => `item-${i}`);
  const ctx = {
    manager: {},
    client,
    serverId: "server",
    config: { era: options.era, checkTimeout: 1_000 },
    initializationInfo: { serverCapabilities: options.capabilities },
    availableTools: names(options.listed?.tools),
    availablePrompts: names(options.listed?.prompts),
    availableResources: names(options.listed?.resources),
    availableResourceTemplates: [],
    unlisted: options.unlisted ?? [],
  } as unknown as MCPClientCheckContext;
  return { ctx, sent };
}

async function grade(options: Parameters<typeof context>[0]) {
  const { ctx, sent } = context(options);
  return { result: await CHECK.run(ctx), sent };
}

const ALL = { tools: {}, prompts: {}, resources: {} };

describe("capabilities-consistent: listings served without a declaration (5.F1)", () => {
  it("asks for every undeclared listing, and none of the declared ones", async () => {
    const { result, sent } = await grade({
      era: "legacy",
      capabilities: { tools: {} },
      listed: { tools: 1 },
    });

    expect(sent).toEqual([
      "prompts/list",
      "resources/list",
      "resources/templates/list",
    ]);
    expect(result.status).toBe("passed");
  });

  it("asks nothing of a server that declares all three", async () => {
    const { result, sent } = await grade({
      era: "legacy",
      capabilities: ALL,
      listed: { tools: 1, prompts: 1, resources: 1 },
    });

    expect(sent).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("passes an undeclared listing that comes back empty: nothing is served", async () => {
    const { result } = await grade({
      era: "legacy",
      capabilities: { tools: {} },
      answers: {
        "prompts/list": { items: 0 },
        "resources/list": { items: 0 },
        "resources/templates/list": { items: 0 },
      },
    });

    expect(result.status).toBe("passed");
  });

  it.each(["legacy", "modern"] as const)(
    "fails tools served without the tools capability on the %s era",
    async (era) => {
      const { result } = await grade({
        era,
        capabilities: { prompts: {} },
        listed: { prompts: 1 },
        answers: { "tools/list": { items: 2 } },
      });

      expect(result.status).toBe("failed");
      expect(result.error?.message).toBe(
        "Capability mismatches: tools/list returned 2 item(s) but the server does not advertise capabilities.tools"
      );
    }
  );

  it("treats any refusal of an undeclared listing as not served", async () => {
    const { result } = await grade({
      era: "legacy",
      capabilities: { tools: {} },
      answers: {
        "prompts/list": { code: -32603 },
        "resources/list": { httpStatus: 404 },
        "resources/templates/list": { httpStatus: 405 },
      },
    });

    expect(result.status).toBe("passed");
  });
});

describe("capabilities-consistent: a listing MCPJam got no answer to (5.W1)", () => {
  it.each([
    ["a timeout", "timeout"],
    ["a dropped connection", "network"],
    ["a rate limiter's 429", { httpStatus: 429 }],
    ["a gateway's 502", { httpStatus: 502 }],
    ["a login wall's 401", { httpStatus: 401 }],
  ] as const)("could not run on %s", async (_label, answer) => {
    const { result } = await grade({
      era: "legacy",
      capabilities: ALL,
      answers: {},
    });
    // Sanity: nothing undeclared, nothing asked.
    expect(result.status).toBe("passed");

    const noAnswer = await grade({
      era: "legacy",
      capabilities: { tools: {}, resources: {} },
      answers: { "prompts/list": answer as Answer },
    });
    expect([noAnswer.result.status, noAnswer.result.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(noAnswer.result.error?.message).toMatch(
      /^prompts\/list got no answer to compare with the declaration/
    );
  });

  it("still fails when another listing showed a mismatch", async () => {
    const { result } = await grade({
      era: "legacy",
      capabilities: { resources: {} },
      answers: { "tools/list": { items: 1 }, "prompts/list": "timeout" },
    });

    expect(result.status).toBe("failed");
  });
});

describe("capabilities-consistent: a declared listing that errors (5.F2, 2026-07-28)", () => {
  it.each([
    ["tools", "tools/list", { prompts: 1, resources: 1 }, ["tools"]],
    ["prompts", "prompts/list", { tools: 1, resources: 1 }, ["prompts"]],
    ["resources", "resources/list", { tools: 1, prompts: 1 }, ["resources"]],
  ] as const)(
    "fails declared %s whose listing answers -32603",
    async (capability, method, listed, unlisted) => {
      const { result } = await grade({
        era: "modern",
        capabilities: ALL,
        listed,
        unlisted: [...unlisted],
        answers: { [method]: { code: -32603 } },
      });

      expect(result.status).toBe("failed");
      expect(result.error?.message).toBe(
        `Capability mismatches: the server advertises capabilities.${capability} but ${method} answered with error -32603`
      );
    }
  );

  it("fails a declared listing that answers Method not found", async () => {
    // The client turns -32601 into an empty list, so the listing is asked
    // again whenever a declared one came back empty.
    const { result } = await grade({
      era: "modern",
      capabilities: ALL,
      listed: { prompts: 1, resources: 1 },
      answers: { "tools/list": { code: -32601 } },
    });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain(
      "the server advertises capabilities.tools but tools/list answered with error -32601"
    );
  });

  it("passes a declared listing the server answered with a malformed result", async () => {
    // It answered, which is all 5.F2 asks. The shape is the list checks'.
    const { result } = await grade({
      era: "modern",
      capabilities: ALL,
      listed: { prompts: 1, resources: 1 },
      unlisted: ["tools"],
      answers: { "tools/list": "invalid" },
    });

    expect(result.status).toBe("passed");
    expect(result.details).toMatchObject({
      declaredListings: { "tools/list": { outcome: "unreadable" } },
    });
  });

  it("passes a declared listing that is really empty", async () => {
    const { result } = await grade({
      era: "modern",
      capabilities: ALL,
      listed: { prompts: 1, resources: 1 },
      answers: { "tools/list": { items: 0 } },
    });

    expect(result.status).toBe("passed");
  });

  it("does not ask again for a declared listing that had items", async () => {
    const { sent } = await grade({
      era: "modern",
      capabilities: ALL,
      listed: { tools: 1, prompts: 1, resources: 1 },
    });

    expect(sent).toEqual([]);
  });

  it("does not fail an erroring declared listing on 2025: the rule is 2026-07-28's", async () => {
    const { result, sent } = await grade({
      era: "legacy",
      capabilities: ALL,
      listed: { prompts: 1, resources: 1 },
      unlisted: ["tools"],
      answers: { "tools/list": { code: -32603 } },
    });

    expect(sent).toEqual([]);
    expect(result.status).toBe("passed");
  });
});
