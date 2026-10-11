/**
 * Codex has ONE adapter: MCPJam's `codex app-server` adapter, in every venue.
 *
 * The published `codex exec` adapter it replaced could not pause for approval
 * on any surface, so these tests pin what the app-server adapter is for (the
 * pause, typed tool attribution) and what the swap must never break silently:
 * the id other harnesses and session lanes key on, and the session lanes a
 * saved exec conversation sits in.
 */
import { describe, expect, it } from "vitest";
import {
  getHarnessAdapter,
  harnessSupportsSkills,
  isHarnessId,
  registeredHarnessIds,
} from "../registry.js";
import { harnessToolApprovalRefusalReason } from "../harness-availability.js";
import { harnessRuntimeFingerprint } from "../run-harness-turn.js";

describe("the Codex adapter", () => {
  it("is the app-server adapter, with no transport to select", () => {
    const codex = getHarnessAdapter("codex");
    expect(codex.id).toBe("codex");
    expect(codex.transport).toBe("app-server");
    expect(codex.liveApprovalRuntime).toBe(true);
    expect(codex.acceptsSandboxPolicy).toBe(true);
  });

  it("leaves the other harnesses untouched", () => {
    expect(getHarnessAdapter("claude-code").transport).toBeUndefined();
    expect(getHarnessAdapter("cursor").transport).toBeUndefined();
    expect(registeredHarnessIds().sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
    expect(isHarnessId("codex")).toBe(true);
    expect(harnessSupportsSkills("codex")).toBe(true);
  });

  it("can pause for approval, on both surfaces", () => {
    const codex = getHarnessAdapter("codex");
    expect(codex.supportsNativeToolApproval).toBe(true);
    // Both move together because the pause is ONE mechanism serving both
    // surfaces, and Codex's MCP tools are host-executed.
    expect(codex.supportsHostExecutedToolApproval).toBe(true);
    expect(codex.approvalPermissionMode).toBe("allow-reads");
  });

  it("admits an approval-gated host someone can answer", () => {
    expect(
      harnessToolApprovalRefusalReason({
        adapter: getHarnessAdapter("codex"),
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    ).toBeUndefined();
  });

  it("claims no MCP-tool approval it cannot honour", () => {
    // MCP delivery is host-executed, so MCPJam's gate applies to relayed calls;
    // a future switch to native delivery must not inherit a promise for free.
    expect(getHarnessAdapter("codex").supportsMcpToolApproval).toBe(false);
    expect(getHarnessAdapter("codex").mcpDelivery).toBe("host-executed");
  });

  it("names Codex's native tools as measured against the pinned binary", () => {
    const tools = getHarnessAdapter("codex")
      .listBuiltinTools()
      .map((tool) => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining(["exec_command", "apply_patch", "web_search"]),
    );
  });

  it("emits patches as real tool calls, not a synthetic file-change tool", () => {
    // An approval must attach to a tool call, and a `file-change` part carries
    // no toolCallId.
    expect(getHarnessAdapter("codex").fileChangeToolName).toBeUndefined();
  });

  it("attributes relayed MCP tool names the way Claude Code does", () => {
    expect(
      getHarnessAdapter("codex").parseToolName("mcp__weather__get_forecast", {
        weather: "srv-weather",
      }),
    ).toEqual({ serverId: "srv-weather", toolName: "get_forecast" });
  });
});

describe("session lanes saved under the retired exec transport", () => {
  const base = {
    harnessId: "codex",
    modelId: "openai/gpt-5-nano",
    selectedServers: ["srv-a"],
    permissionMode: "allow-all",
  };

  it("fork instead of resuming onto a different protocol", () => {
    // An exec lane hashed with no transport dimension. A live bridge speaks one
    // protocol, so the app-server adapter must never reattach to it; the turn
    // shows a "runtime-changed" reset instead.
    expect(
      harnessRuntimeFingerprint({ ...base, transport: "app-server" }),
    ).not.toBe(harnessRuntimeFingerprint(base));
    expect(harnessRuntimeFingerprint({ ...base, transport: "exec" })).toBe(
      harnessRuntimeFingerprint(base),
    );
  });

  it("leave every other harness's lanes byte-identical", () => {
    expect(
      harnessRuntimeFingerprint({
        harnessId: "claude-code",
        modelId: "anthropic/claude-haiku-4.5",
        permissionMode: "allow-all",
      }),
    ).toBe(
      harnessRuntimeFingerprint({
        harnessId: "claude-code",
        modelId: "anthropic/claude-haiku-4.5",
        permissionMode: "allow-all",
        transport: "exec",
      }),
    );
  });

  it("keep the harness id and model readable in the fingerprint", () => {
    expect(
      harnessRuntimeFingerprint({ ...base, transport: "app-server" }),
    ).toMatch(/^codex\|openai\/gpt-5-nano\|/);
  });
});
