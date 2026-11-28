import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import {
  createPersonaClientDriver,
  withPersonaToolApprovals,
} from "../persona-client-driver.js";

const question = {
  requestId: "rpc-1",
  serverId: "fixture",
  message: "Choose a size",
  schema: {
    type: "object",
    required: ["size"],
    properties: { size: { type: "string", enum: ["small"] } },
  },
} as const;

describe("goal-run client actions", () => {
  it("validates form answers and records ordered receipts without the values", async () => {
    const signal = new AbortController().signal;
    const choose = vi
      .fn()
      .mockResolvedValueOnce('{"action":"accept","content":{"size":"large"}}')
      .mockResolvedValueOnce('```json\n{"action":"accept","content":{"size":"small"}}\n```');
    const driver = createPersonaClientDriver({
      choose,
      turnSignal: () => signal,
    });
    expect(await driver.elicitationCallback(question)).toEqual({
      action: "decline",
    });
    expect(await driver.elicitationCallback(question)).toEqual({
      action: "accept",
      content: { size: "small" },
    });
    const receipts = driver.takeReceipts();
    expect(receipts).toEqual([
      expect.objectContaining({
        actor: "persona",
        kind: "question",
        order: 0,
        outcome: "invalid",
      }),
      expect.objectContaining({
        actor: "persona",
        kind: "question",
        order: 1,
        outcome: "accepted",
      }),
    ]);
    expect(receipts[0].id).not.toBe(receipts[1].id);
    expect(JSON.stringify(receipts)).not.toContain("small");
    expect(driver.takeReceipts()).toEqual([]);
  });

  it("shows the persona the arguments and denies calls with redacted inputs", async () => {
    const choose = vi.fn().mockResolvedValue('{"action":"approve"}');
    const driver = createPersonaClientDriver({
      choose,
      turnSignal: () => new AbortController().signal,
    });
    expect(await driver.approve("delete", "files", "call-1", undefined, { path: "/tmp/one" }))
      .toBe(true);
    expect(choose).toHaveBeenCalledWith(
      { kind: "approval", tool: "delete", arguments: { path: "/tmp/one" } },
      expect.any(AbortSignal),
    );
    expect(await driver.approve("delete", "files", "call-2", undefined, {
      access_token: "a-sensitive-value",
    })).toBe(false);
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("declines URL mode and expires a slow answer without accepting late data", async () => {
    const controller = new AbortController();
    let finish!: (reply: string) => void;
    const choose = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const driver = createPersonaClientDriver({
      choose,
      turnSignal: () => controller.signal,
    });
    expect(
      await driver.elicitationCallback({ ...question, mode: "url" }),
    ).toEqual({
      action: "decline",
    });
    expect(choose).not.toHaveBeenCalled();
    const pending = driver.elicitationCallback(question);
    controller.abort();
    await expect(pending).resolves.toEqual({ action: "decline" });
    finish('{"action":"accept","content":{"size":"small"}}');
    expect(driver.takeReceipts().map(({ outcome }) => outcome)).toEqual([
      "unsupported",
      "expired",
    ]);
  });

  it("executes an approved scoped MCP call once, blocks denial, and preserves other gates", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "done" }],
    }));
    const choose = vi
      .fn()
      .mockResolvedValueOnce('{"action":"deny"}')
      .mockResolvedValueOnce('{"action":"approve"}');
    const signal = new AbortController().signal;
    const driver = createPersonaClientDriver({
      choose,
      turnSignal: () => signal,
    });
    const scoped = { _serverId: "fixture", needsApproval: true, execute };
    const native = { needsApproval: true, execute };
    const policyGated = { ...scoped, needsApproval: () => true };
    const tools = withPersonaToolApprovals(
      {
        work: scoped,
        native,
        policyGated,
        elsewhere: { ...scoped, _serverId: "other" },
      } as unknown as ToolSet,
      ["fixture"],
      driver,
    );
    const options = { toolCallId: "tool-1", messages: [], abortSignal: signal };
    expect(await tools.work.execute?.({}, options)).toMatchObject({
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
    await tools.work.execute?.({}, { ...options, toolCallId: "tool-2" });
    await tools.work.execute?.({}, { ...options, toolCallId: "tool-2" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(tools.native).toBe(native);
    expect(tools.elsewhere.needsApproval).toBe(true);
    expect(tools.policyGated).toBe(policyGated);
    expect(driver.takeReceipts().map(({ outcome }) => outcome)).toEqual([
      "denied",
      "approved",
    ]);
  });
});
