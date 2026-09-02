/**
 * The Codex TRANSPORT switch: what changes when
 * `MCPJAM_CODEX_APPSERVER_TRANSPORT` is on, and — more importantly — what does
 * not.
 *
 * Codex is one host with two protocols. The exec transport has been in
 * production; the app-server one is MCPJam's own adapter. Everything a user can
 * see about their host has to survive the swap (id, display name, model rules,
 * skills root, MCP delivery), while the capabilities that depend on the
 * protocol move. These tests pin both halves, because getting either wrong is
 * silent: a changed id forks every Codex session lane, and an unmoved
 * capability flag leaves approvals refused on a transport that supports them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getHarnessAdapter,
  harnessSupportsSkills,
  isHarnessId,
  registeredHarnessIds,
} from "../registry.js";
import { harnessToolApprovalRefusalReason } from "../harness-availability.js";
import { harnessRuntimeFingerprint } from "../run-harness-turn.js";

const FLAG = "MCPJAM_CODEX_APPSERVER_TRANSPORT";
const original = process.env[FLAG];

function setTransport(value: "exec" | "app-server") {
  if (value === "app-server") process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe("the flag selects the transport, and nothing else about the host", () => {
  it("is OFF by default, so a deploy changes no behaviour", () => {
    delete process.env[FLAG];
    expect(getHarnessAdapter("codex").transport).toBe("exec");
  });

  it.each([
    ["", "exec"],
    ["false", "exec"],
    ["1", "exec"],
    ["yes", "exec"],
    ["true", "app-server"],
  ] as const)("%s selects %s", (value, expected) => {
    // Exact-match on "true" only: a truthy-ish value must not silently enable a
    // transport nobody meant to turn on.
    process.env[FLAG] = value;
    expect(getHarnessAdapter("codex").transport).toBe(expected);
  });

  it("reads the flag per lookup, not once at import", () => {
    setTransport("exec");
    expect(getHarnessAdapter("codex").transport).toBe("exec");
    setTransport("app-server");
    expect(getHarnessAdapter("codex").transport).toBe("app-server");
    setTransport("exec");
    expect(getHarnessAdapter("codex").transport).toBe("exec");
  });

  it("leaves the other harnesses untouched", () => {
    setTransport("app-server");
    expect(getHarnessAdapter("claude-code").transport).toBeUndefined();
    expect(getHarnessAdapter("cursor").transport).toBeUndefined();
    expect(registeredHarnessIds().sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
    expect(isHarnessId("codex")).toBe(true);
  });
});

describe("what must NOT change with the transport", () => {
  const invariant = <T>(
    read: (adapter: ReturnType<typeof getHarnessAdapter>) => T,
  ) => {
    setTransport("exec");
    const exec = read(getHarnessAdapter("codex"));
    setTransport("app-server");
    const appServer = read(getHarnessAdapter("codex"));
    return { exec, appServer };
  };

  it.each([
    ["id", (a: any) => a.id],
    ["displayName", (a: any) => a.displayName],
    ["modelAccess", (a: any) => a.modelAccess],
    // Host-executed on BOTH. Native delivery is not blocked by this transport
    // — it is blocked by codex having no approval request for an MCP tool call,
    // which would make a Strict-mode host unable to gate one.
    ["mcpDelivery", (a: any) => a.mcpDelivery],
    ["requiresComputer", (a: any) => a.requiresComputer],
    ["supportsSkills", (a: any) => a.supportsSkills],
    ["skillsBaseDir", (a: any) => a.skillsBaseDir],
    ["skillsWriteOptions", (a: any) => a.skillsWriteOptions],
    ["supportsPluginBundles", (a: any) => a.supportsPluginBundles],
    ["defaultPermissionMode", (a: any) => a.defaultPermissionMode],
  ])("%s is identical across transports", (_name, read) => {
    const { exec, appServer } = invariant(read);
    expect(appServer).toEqual(exec);
  });

  it("admits and refuses exactly the same models", () => {
    for (const modelId of [
      "openai/gpt-5-nano",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.6-terra",
      "openai/o1",
      "anthropic/claude-haiku-4.5",
    ]) {
      const { exec, appServer } = invariant((a) => a.supportsModel(modelId));
      expect(appServer, modelId).toBe(exec);
    }
  });

  it("attributes MCP tool names the same way", () => {
    const keyToServerId = { weather: "srv-weather" };
    const { exec, appServer } = invariant((a) =>
      a.parseToolName("mcp__weather__get_forecast", keyToServerId),
    );
    expect(appServer).toEqual(exec);
    expect(appServer).toEqual({
      serverId: "srv-weather",
      toolName: "get_forecast",
    });
  });

  it("still reports skills support through the non-throwing helper", () => {
    setTransport("app-server");
    expect(harnessSupportsSkills("codex")).toBe(true);
  });
});

describe("what the transport buys", () => {
  it("can pause for approval, on both surfaces", () => {
    setTransport("exec");
    const exec = getHarnessAdapter("codex");
    expect(exec.supportsNativeToolApproval).toBe(false);
    expect(exec.supportsHostExecutedToolApproval).toBe(false);

    setTransport("app-server");
    const appServer = getHarnessAdapter("codex");
    expect(appServer.supportsNativeToolApproval).toBe(true);
    // Both move together because the pause is ONE mechanism serving both
    // surfaces. Leaving the host-executed flag false would refuse every
    // approval host with a server attached — and Codex's MCP tools are
    // host-executed, so that is every approval host with MCP at all.
    expect(appServer.supportsHostExecutedToolApproval).toBe(true);
    expect(appServer.approvalPermissionMode).toBe("allow-reads");
  });

  it("stops refusing an approval-gated host", () => {
    // The refusal that exists today, and the whole reason for the transport.
    setTransport("exec");
    expect(
      harnessToolApprovalRefusalReason({
        adapter: getHarnessAdapter("codex"),
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    ).toMatch(/doesn't support interactive tool approval/);

    setTransport("app-server");
    expect(
      harnessToolApprovalRefusalReason({
        adapter: getHarnessAdapter("codex"),
        requireToolApproval: true,
        hasSelectedMcpServers: true,
      }),
    ).toBeUndefined();
  });

  it("claims no MCP-tool approval it cannot honour", () => {
    // codex 0.149.1 raises NO approval request for an MCP `tools/call`. The
    // flag stays false so a future switch to native delivery cannot silently
    // inherit a promise the protocol does not keep.
    setTransport("app-server");
    expect(getHarnessAdapter("codex").supportsMcpToolApproval).toBe(false);
  });

  it("names more than the two actions exec could attribute", () => {
    setTransport("exec");
    const execTools = getHarnessAdapter("codex")
      .listBuiltinTools()
      .map((tool) => tool.name);
    setTransport("app-server");
    const appServerTools = getHarnessAdapter("codex")
      .listBuiltinTools()
      .map((tool) => tool.name);

    expect(appServerTools.length).toBeGreaterThan(execTools.length);
    // Native names, as MEASURED against the pinned binary: app-server declares
    // `exec_command`, where the exec transport reports `shell`.
    expect(appServerTools).toEqual(
      expect.arrayContaining(["exec_command", "apply_patch", "web_search"]),
    );
    expect(execTools).toEqual(expect.arrayContaining(["shell"]));
  });

  it("stops synthesising file changes as a pseudo-tool", () => {
    // The bridge emits a patch as a real tool-call/tool-result pair, because an
    // approval must attach to a tool call and a `file-change` part carries no
    // toolCallId.
    setTransport("exec");
    expect(getHarnessAdapter("codex").fileChangeToolName).toBe("fileChange");
    setTransport("app-server");
    expect(getHarnessAdapter("codex").fileChangeToolName).toBeUndefined();
  });
});

describe("session continuity across a transport flip", () => {
  const base = {
    harnessId: "codex",
    modelId: "openai/gpt-5-nano",
    selectedServers: ["srv-a"],
    permissionMode: "allow-all",
  };

  it("does not fork ANY existing session when the dimension is absent", () => {
    // The load-bearing property of the whole change: adding a fingerprint
    // dimension must hash byte-identically for every session that predates it,
    // or a deploy cold-starts the entire fleet — Claude Code and Cursor
    // included.
    expect(harnessRuntimeFingerprint({ ...base, transport: "exec" })).toBe(
      harnessRuntimeFingerprint(base),
    );
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

  it("forks the lane when the transport actually changes", () => {
    // A session created over exec has no app-server thread to resume, and a
    // live bridge speaks one protocol. Resuming across the flip would reattach
    // a conversation to a bridge that cannot read its next frame.
    expect(
      harnessRuntimeFingerprint({ ...base, transport: "app-server" }),
    ).not.toBe(harnessRuntimeFingerprint(base));
  });

  it("is reversible: flipping back lands on the original lane", () => {
    // Flip-flop safety. A rollback has to return users to the sessions they
    // had, not to a third lane.
    const before = harnessRuntimeFingerprint(base);
    const flipped = harnessRuntimeFingerprint({
      ...base,
      transport: "app-server",
    });
    const back = harnessRuntimeFingerprint({ ...base, transport: "exec" });
    expect(flipped).not.toBe(before);
    expect(back).toBe(before);
  });

  it("keeps the harness id and model readable in the fingerprint", () => {
    // They are a literal PREFIX, not hashed — other code reads them.
    expect(
      harnessRuntimeFingerprint({ ...base, transport: "app-server" }),
    ).toMatch(/^codex\|openai\/gpt-5-nano\|/);
  });
});
