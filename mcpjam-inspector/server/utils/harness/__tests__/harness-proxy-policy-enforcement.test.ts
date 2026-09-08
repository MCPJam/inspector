/**
 * The pure pieces of D4b: the bridge-mirroring name resolver, the block-marker
 * reader the harness turn accounts blocks with, the launch refusal, and the
 * seam where a harness-origin block reaches the stage chain.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ModelMessage } from "ai";
import type {
  StageAuthoredCase,
  StageResultRow,
  ToolPolicySnapshot,
} from "@mcpjam/sdk/contract";
import {
  HARNESS_POLICY_BLOCK_META_KEY,
  HARNESS_POLICY_BLOCK_TEXT_PREFIX as prefix,
  HARNESS_TOOL_POLICY_SEAL_UNAVAILABLE_REASON,
  harnessToolPolicyLaunchRefusal,
  readHarnessPolicyBlockFromResult,
  readHarnessPolicyBlockMarker,
  resolveBridgeToolCallTarget,
} from "../harness-proxy-policy-enforcement.js";
import { buildIterationFinishParams } from "../../../services/evals/finalize-iteration.js";
import { buildHarnessToolPolicySnapshots } from "../../../services/evals/tool-policy-gate.js";
import { buildHarnessProxyMcpJson } from "../mcp-config.js";
import { getHarnessAdapter } from "../registry.js";

describe("resolveBridgeToolCallTarget", () => {
  const hasServer = (id: string) => id === "srv-b";

  it("keeps an unprefixed name on the requested server", () => {
    expect(
      resolveBridgeToolCallTarget({
        serverId: "srv-a",
        toolName: "read_file",
        hasServer,
      })
    ).toEqual({ targetServerId: "srv-a", toolName: "read_file" });
  });

  it("reroutes a prefixed name to the prefix server when it exists", () => {
    expect(
      resolveBridgeToolCallTarget({
        serverId: "srv-a",
        toolName: "srv-b:read_file",
        hasServer,
      })
    ).toEqual({ targetServerId: "srv-b", toolName: "read_file" });
  });

  it("strips an unknown prefix without rerouting (the bridge's behaviour)", () => {
    expect(
      resolveBridgeToolCallTarget({
        serverId: "srv-a",
        toolName: "nope:read_file",
        hasServer,
      })
    ).toEqual({ targetServerId: "srv-a", toolName: "read_file" });
  });

  it("leaves a nameless call nameless for the bridge to reject", () => {
    expect(
      resolveBridgeToolCallTarget({
        serverId: "srv-a",
        toolName: undefined,
        hasServer,
      })
    ).toEqual({ targetServerId: "srv-a" });
  });
});

describe("readHarnessPolicyBlockMarker", () => {
  const marker = {
    toolName: "delete_repo",
    reason: "denyList",
    classification: "destructive",
  };

  it("reads the marker off the raw result and off a wrapper", () => {
    expect(
      readHarnessPolicyBlockMarker({
        content: [],
        _meta: { [HARNESS_POLICY_BLOCK_META_KEY]: marker },
      })
    ).toEqual(marker);
    expect(
      readHarnessPolicyBlockMarker({
        result: { _meta: { [HARNESS_POLICY_BLOCK_META_KEY]: marker } },
      })
    ).toEqual(marker);
  });

  it("ignores anything that is not a well-formed marker", () => {
    expect(readHarnessPolicyBlockMarker(undefined)).toBeNull();
    expect(readHarnessPolicyBlockMarker({ content: [] })).toBeNull();
    expect(
      readHarnessPolicyBlockMarker({ _meta: { other: { toolName: "x" } } })
    ).toBeNull();
    expect(
      readHarnessPolicyBlockMarker({
        _meta: { [HARNESS_POLICY_BLOCK_META_KEY]: { toolName: "x" } },
      })
    ).toBeNull();
  });
});

describe("readHarnessPolicyBlockFromResult", () => {
  const snapshot: ToolPolicySnapshot = {
    mode: "default",
    denied: { delete_repo: { reason: "denyList", classification: "unknown" } },
    known: ["delete_repo", "read_file"],
    unknownTool: "deny",
  };

  it("recognises the block in the REAL adapter's result shape: a bare string", () => {
    // `@ai-sdk/harness-claude-code` flattens an MCP result's content blocks with
    // `stringifyContent`, so `_meta` is gone by the time the turn sees the part.
    // This is the shape that made the marker-only reader miscount a refusal as a
    // successful call.
    expect(
      readHarnessPolicyBlockFromResult({
        output: "Call blocked by tool policy: denyList",
        snapshot,
        toolName: "delete_repo",
      })
    ).toEqual({
      toolName: "delete_repo",
      reason: "denyList",
      classification: "unknown",
    });
  });

  it("still reads the structured marker when a harness preserves it", () => {
    expect(
      readHarnessPolicyBlockFromResult({
        output: {
          content: [],
          _meta: {
            [HARNESS_POLICY_BLOCK_META_KEY]: {
              toolName: "delete_repo",
              reason: "denyList",
              classification: "unknown",
            },
          },
        },
        snapshot,
        toolName: "delete_repo",
      })
    ).toMatchObject({ reason: "denyList" });
  });

  it("takes the verdict from the snapshot, so a server cannot fake a block", () => {
    // `read_file` is allowed here; echoing our wording must not remove the call
    // from the matcher.
    expect(
      readHarnessPolicyBlockFromResult({
        output: { content: [{ type: "text", text: `${prefix}denyList` }] },
        snapshot,
        toolName: "read_file",
      })
    ).toBeNull();
  });

  it("ignores ordinary text and text with a bogus reason", () => {
    expect(
      readHarnessPolicyBlockFromResult({
        output: "deleted the repo",
        snapshot,
        toolName: "delete_repo",
      })
    ).toBeNull();
    expect(
      readHarnessPolicyBlockFromResult({
        output: `${prefix}because I said so`,
        snapshot,
        toolName: "delete_repo",
      })
    ).toBeNull();
  });
});

describe("harnessToolPolicyLaunchRefusal", () => {
  beforeEach(() => {
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
      "test-harness-proxy-secret-32-chars";
  });

  it("permits a policied harness run on a deployment that can seal", () => {
    expect(
      harnessToolPolicyLaunchRefusal({
        hasToolPolicy: true,
        harness: "claude-code",
      })
    ).toBeNull();
  });

  it("refuses rather than running unpoliced when the seal secret is unusable", () => {
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    expect(
      harnessToolPolicyLaunchRefusal({
        hasToolPolicy: true,
        harness: "claude-code",
      })
    ).toBe(HARNESS_TOOL_POLICY_SEAL_UNAVAILABLE_REASON);
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "short";
    expect(
      harnessToolPolicyLaunchRefusal({
        hasToolPolicy: true,
        harness: "claude-code",
      })
    ).toBe(HARNESS_TOOL_POLICY_SEAL_UNAVAILABLE_REASON);
  });

  it("says nothing about non-harness runs or unpolicied harness runs", () => {
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    expect(
      harnessToolPolicyLaunchRefusal({
        hasToolPolicy: true,
        harness: undefined,
      })
    ).toBeNull();
    expect(
      harnessToolPolicyLaunchRefusal({
        hasToolPolicy: false,
        harness: "claude-code",
      })
    ).toBeNull();
  });

  // COMP-39. The seal exists to carry a policy OUT of this process. A
  // host-executed adapter's MCP calls never leave it — they are gated in-process
  // by `projectSelectedMcpServersAsHostTools` — so admission must not demand a
  // token that will never be minted. Before this, a deployment whose terminal
  // secret was merely too SHORT (nonempty, under the 16-char minimum) refused
  // every policied Codex eval outright.
  it("exempts host-executed delivery from the proxy-seal requirement", () => {
    expect(getHarnessAdapter("codex").mcpDelivery).toBe("host-executed");
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "short";
    expect(
      harnessToolPolicyLaunchRefusal({ hasToolPolicy: true, harness: "codex" })
    ).toBeNull();
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    expect(
      harnessToolPolicyLaunchRefusal({ hasToolPolicy: true, harness: "codex" })
    ).toBeNull();
  });

  // …and the exemption is delivery-scoped, never a general softening: the
  // native path still fails CLOSED on the same deployment.
  it("keeps NATIVE delivery failing closed on the same weak-secret deployment", () => {
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "short";
    expect(getHarnessAdapter("claude-code").mcpDelivery).toBe("native");
    expect(
      harnessToolPolicyLaunchRefusal({
        hasToolPolicy: true,
        harness: "claude-code",
      })
    ).toBe(HARNESS_TOOL_POLICY_SEAL_UNAVAILABLE_REASON);
  });
});

describe("buildHarnessToolPolicySnapshots", () => {
  it("resolves each selected server against its own annotations", () => {
    const snapshots = buildHarnessToolPolicySnapshots({
      policy: { mode: "readOnly", deny: ["srv_a_writer"] },
      serverIds: ["srv-a", "srv-b"],
      annotations: new Map([
        ["srv-a:srv_a_writer", { destructiveHint: true }],
        ["srv-a:srv_a_reader", { readOnlyHint: true }],
        ["srv-b:srv_b_reader", { readOnlyHint: true }],
      ]),
    });
    expect(snapshots["srv-a"]?.known.sort()).toEqual([
      "srv_a_reader",
      "srv_a_writer",
    ]);
    expect(snapshots["srv-a"]?.denied.srv_a_writer).toMatchObject({
      reason: "denyList",
    });
    expect(snapshots["srv-a"]?.denied.srv_a_reader).toBeUndefined();
    // A server's snapshot must not carry another server's tools, or a prefixed
    // call would be decided against the wrong table.
    expect(snapshots["srv-b"]?.known).toEqual(["srv_b_reader"]);
  });

  it("gives a server with no annotations an empty table, denying everything unknown", () => {
    const snapshots = buildHarnessToolPolicySnapshots({
      policy: { mode: "default" },
      serverIds: ["srv-a"],
      annotations: new Map(),
    });
    expect(snapshots["srv-a"]).toEqual({
      mode: "default",
      denied: {},
      known: [],
      unknownTool: "deny",
    });
  });
});

describe(".mcp.json token selection", () => {
  it("sends the sealed token INSTEAD of the bare one", () => {
    const config = buildHarnessProxyMcpJson([
      {
        name: "srv-a",
        proxyUrl: "https://mcpjam.example/api/web/harness-mcp/srv-a",
        proxyToken: "bare-token",
        sealedProxyToken: "mcpjps1.aaa.bbb",
      },
    ]);
    const headers = Object.values(config.mcpServers)[0]?.headers;
    expect(headers?.["X-MCPJam-Proxy-Token"]).toBe("mcpjps1.aaa.bbb");
    expect(JSON.stringify(config)).not.toContain("bare-token");
  });

  it("keeps the bare token when no policy is in force", () => {
    const config = buildHarnessProxyMcpJson([
      {
        name: "srv-a",
        proxyUrl: "https://mcpjam.example/api/web/harness-mcp/srv-a",
        proxyToken: "bare-token",
      },
    ]);
    const headers = Object.values(config.mcpServers)[0]?.headers;
    expect(headers?.["X-MCPJam-Proxy-Token"]).toBe("bare-token");
  });
});

describe("a harness-origin block at the finalize seam", () => {
  const authoredCase: StageAuthoredCase = {
    mode: "model_driven",
    expectsToolCall: true,
    assertionCount: 1,
  };
  const messages: ModelMessage[] = [{ role: "user", content: "hi" }];

  it("derives notMeasured + blockedByPolicy, never failed", () => {
    const params = buildIterationFinishParams({
      iterationId: "iter1",
      passed: false,
      evaluation: {
        toolsCalled: [],
        turnCount: 1,
        failedTurnCount: 0,
        missing: ["delete_repo"],
        unexpected: [],
        argumentMismatches: [],
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      messages,
      status: "completed",
      startedAt: 0,
      iterationMetadataBase: {},
      stageCase: authoredCase,
      // The record the proxy produced, as `run-harness-turn` accounts it: same
      // shape as the in-process gate's, plus the originating server.
      policyBlocks: [
        {
          toolName: "delete_repo",
          reason: "unknownAtLaunch",
          classification: "unknown",
          at: 123,
          toolCallId: "call_1",
          serverId: "srv-a",
        },
      ],
      toolPolicy: { mode: "readOnly" },
    } as unknown as Parameters<typeof buildIterationFinishParams>[0]);
    const metadata = params.metadata as Record<string, any>;
    expect(metadata.policyBlockCount).toBe(1);
    expect(metadata.policyBlocks[0]).toMatchObject({
      reason: "unknownAtLaunch",
      serverId: "srv-a",
    });
    // Stamped so a replay can recover the policy instead of executing for real
    // the calls this run blocked.
    expect(metadata.toolPolicy).toEqual({ mode: "readOnly" });
    expect(metadata.failureCategory).toBeUndefined();
    expect(metadata.firstFailedStage).toBeUndefined();
    const rows = metadata.stageResults as StageResultRow[];
    const applicable = rows.filter((row) => row.state !== "notApplicable");
    expect(applicable.length).toBeGreaterThan(0);
    expect(applicable.every((row) => row.state === "notMeasured")).toBe(true);
    expect(applicable.every((row) => row.reason === "blockedByPolicy")).toBe(
      true
    );
    expect(rows.some((row) => row.state === "failed")).toBe(false);
  });
});

describe("the matcher must not see a blocked call", () => {
  it("excludes the blocked toolCallId from the extracted calls", async () => {
    // The runner's exclusion helper is private; this pins the property it
    // enforces through the gate the harness path records into.
    const { createToolPolicyGate } = await import(
      "../../../services/evals/tool-policy-gate.js"
    );
    const gate = createToolPolicyGate({
      policy: { mode: "default", deny: ["delete_repo"] },
      annotations: new Map(),
    });
    gate.recordBlock({
      toolName: "delete_repo",
      reason: "denyList",
      classification: "destructive",
      toolCallId: "call_1",
    });
    expect(gate.blockedToolCallIds().has("call_1")).toBe(true);
    expect(gate.blocks).toHaveLength(1);
  });
});

// Guard against the mock-name drift the working rules call out: production's
// `tools/call` resolution now goes through `resolveBridgeToolCallTarget`, which
// still asks the manager for `hasServer`.
describe("bridge resolver contract", () => {
  it("asks the manager by the same method name the suites mock", () => {
    const hasServer = vi.fn().mockReturnValue(false);
    resolveBridgeToolCallTarget({
      serverId: "srv-a",
      toolName: "other:read_file",
      hasServer,
    });
    expect(hasServer).toHaveBeenCalledWith("other");
  });
});
