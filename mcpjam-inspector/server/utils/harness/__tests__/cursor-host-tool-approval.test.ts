import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createCursor } from "@ai-sdk/harness-cursor";
import { patchCursorHostToolApproval } from "../cursor-host-tool-approval";

async function bridgeSource() {
  const bootstrap = await createCursor().getBootstrap?.();
  const source = bootstrap?.files.find((file) => file.path.endsWith("/bridge.mjs"))?.content;
  if (typeof source !== "string") throw new Error("Missing Cursor bridge source");
  return source;
}
function region(source: string, name: string) {
  const start = source.indexOf(`//#region src/v1/bridge/${name}.ts`);
  return source.slice(start, source.indexOf("//#endregion", start));
}
type Controller = {
  requestPermission(request: unknown): Promise<{ outcome: { outcome: string; optionId?: string } }>;
  cancelAll(): void;
};

describe("Cursor host tool permission", () => {
  it("patches the real pinned bridge idempotently and refuses changed anchors", async () => {
    const source = await bridgeSource();
    const patched = patchCursorHostToolApproval(source);
    expect(patchCursorHostToolApproval(patched)).toBe(patched);
    expect(() => patchCursorHostToolApproval(source.replace("pending.resolve(true);", "pending.resolve(false);"))).toThrow(/anchor changed/);
  });
  it.each([true, false, "cancel"] as const)("grants a native call only after its decision: %s", async (decision) => {
    const source = patchCursorHostToolApproval(await bridgeSource());
    let answer: ((value: { approved: boolean }) => void) | undefined;
    const grants: unknown[] = [];
    const events: unknown[] = [];
    const factory = runInNewContext(`${region(source, "permission-controller")}; createACPPermissionController;`, { randomUUID }) as (args: unknown) => Controller;
    const controller = factory({
      turn: {
        emitWarning: (value: unknown) => events.push(value),
        emit: (value: unknown) => events.push(value),
        requestToolApproval: () => new Promise<{ approved: boolean }>((resolve) => { answer = resolve; }),
      },
      sessionId: "session", permissionMode: "allow-reads", hasPermissionModeMapping: false,
      emitToolCall: (value: unknown) => events.push(value),
      claimHostToolPermission: () => ({ toolName: "echo", input: { text: "one" } }),
      onHostToolPermissionAllowed: (value: unknown) => grants.push(value),
    });
    const pending = controller.requestPermission({
      sessionId: "session", toolCall: { toolCallId: "native-1", kind: "read" },
      options: [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "deny" }],
    });
    expect(grants).toEqual([]);
    expect(answer).toBeTypeOf("function");
    if (decision === "cancel") controller.cancelAll();
    else answer?.({ approved: decision });
    const result = await pending;
    expect(grants).toHaveLength(decision === true ? 1 : 0);
    if (decision === true) expect(grants[0]).toEqual({ toolCallId: "native-1", call: { toolName: "echo", input: { text: "one" } } });
    expect(result.outcome).toMatchObject(decision === "cancel" ? { outcome: "cancelled" } : { outcome: "selected", optionId: decision ? "allow" : "deny" });
  });
});

type RelayAuthorization = {
  observeUpdate(args: unknown): void;
  authorizePermission(args: unknown): void;
  waitForToolCallAuthorization(args: unknown): Promise<string | false>;
  close(): void;
};
it("consumes one native permission per relay call, even with identical arguments", async () => {
  const source = patchCursorHostToolApproval(await bridgeSource());
  const factory = runInNewContext(`${region(source, "host-tool-relay-authorization")}; createHostToolRelayAuthorization;`, {
    canonicalFingerprint: ({ value }: { value: unknown }) => JSON.stringify(value),
    mergeObservedToolCall: ({ update }: { update: unknown }) => update,
    resolveHostToolCall: ({ toolCall }: { toolCall: { name: string; rawInput: unknown } }) => ({ toolName: toolCall.name, input: toolCall.rawInput }),
    setTimeout, clearTimeout,
  }) as (args: unknown) => RelayAuthorization;
  const gate = factory({ serverName: "host", toolNames: ["echo"] });
  const call = { toolName: "echo", input: { text: "same" } };
  gate.observeUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "native-1", name: "echo", rawInput: call.input } });
  let settled = false;
  const first = gate.waitForToolCallAuthorization(call).then((value) => { settled = true; return value; });
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.authorizePermission({ toolCallId: "native-1", call });
  expect(await first).toBe("native-1");
  gate.authorizePermission({ toolCallId: "native-1", call });
  gate.authorizePermission({ toolCallId: "native-2", call });
  gate.observeUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "native-2", name: "echo", rawInput: call.input } });
  expect(await gate.waitForToolCallAuthorization(call)).toBe("native-2");
  gate.authorizePermission({ toolCallId: "native-changed", call });
  gate.observeUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "native-changed", name: "echo", rawInput: { text: "changed" } } });
  const duplicate = gate.waitForToolCallAuthorization(call);
  const changed = gate.waitForToolCallAuthorization({ ...call, input: { text: "different" } });
  gate.close();
  expect(await duplicate).toBe(false);
  expect(await changed).toBe(false);
});

it("does not reuse approval IDs when the bridge restarts", async () => {
  const source = patchCursorHostToolApproval(await bridgeSource());
  const ids: string[] = [];
  for (let restarted = 0; restarted < 2; restarted++) {
    const factory = runInNewContext(`${region(source, "permission-controller")}; createACPPermissionController;`, { randomUUID }) as (args: unknown) => Controller;
    const controller = factory({
      turn: { emitWarning: () => {}, emit: () => {}, requestToolApproval: (id: string) => { ids.push(id); return Promise.resolve({ approved: false }); } },
      sessionId: "same-session", permissionMode: "allow-reads", hasPermissionModeMapping: false,
      emitToolCall: () => {}, claimHostToolPermission: () => ({ toolName: "echo", input: {} }),
    });
    await controller.requestPermission({ sessionId: "same-session", toolCall: { toolCallId: "new-call", kind: "read" }, options: [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "deny" }] });
  }
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

it("starts the first restored prompt before waiting for Cursor's lazy MCP connection", async () => {
  const source = patchCursorHostToolApproval(await bridgeSource());
  const index = region(source, "index");
  const start = index.indexOf("async function ensureSession(");
  const end = index.indexOf("\nfunction getNativeQuestionToolCallId", start);
  const refreshes: unknown[] = [];
  const ensureSession = runInNewContext(`${index.slice(start, end)}; ensureSession;`, {
    sessionConfigurationFailure: undefined,
    session: {}, catalogRefreshError: undefined,
    bridgeConfiguration: {}, sessionConfigurationFingerprint: "{}",
    restoredCatalogPending: true, hostToolRelay: {}, bridgeType: "cursor",
    CATALOG_REFRESH_TIMEOUT_MS: 10000,
    refreshHostToolCatalog: async (input: unknown) => { refreshes.push(input); },
  }) as (input: { start: { tools: unknown[] }; turn: object }) => Promise<{ initialHostToolCatalogRefreshRequired: boolean }>;
  const input = { start: { tools: [{ name: "echo" }] }, turn: {} };
  // The caller's existing initial-refresh path starts the prompt, then requires
  // a successful catalog read; later turns keep the normal pre-prompt check.
  expect(await ensureSession(input)).toEqual({ initialHostToolCatalogRefreshRequired: true });
  expect(refreshes).toHaveLength(0);
  expect(await ensureSession(input)).toEqual({ initialHostToolCatalogRefreshRequired: false });
  expect(refreshes).toHaveLength(1);
});
