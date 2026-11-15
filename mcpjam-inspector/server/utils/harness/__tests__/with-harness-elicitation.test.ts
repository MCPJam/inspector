import { describe, expect, it, vi } from "vitest";
import type {
  HarnessV1,
  HarnessV1PromptControl,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";
import type { ElicitResult } from "@modelcontextprotocol/client";
import {
  withHarnessElicitation,
  type HarnessElicitationHandler,
} from "../with-harness-elicitation.js";

const unused = async (): Promise<never> => {
  throw new Error("Unused fixture method");
};
const startOptions = {
  sessionId: "session",
  sessionWorkDir: "/fixture",
  sandboxSession: {
    description: "fixture",
    readFile: unused,
    readBinaryFile: unused,
    readTextFile: unused,
    writeFile: unused,
    writeBinaryFile: unused,
    writeTextFile: unused,
    spawn: unused,
    run: unused,
  },
};
const event = (
  serverName = "fixture",
  id = "request",
): HarnessV1StreamPart => ({
  type: "raw",
  rawValue: {
    type: "mcpjam:elicitation",
    phase: "request",
    controlId: `mcpjam:elicitation:${id}`,
    request: {
      serverName,
      mode: "form",
      message: "Choose a color",
      requestedSchema: {
        type: "object",
        properties: { color: { type: "string" } },
      },
    },
  },
});

async function fixture(
  handle: HarnessElicitationHandler,
  beforeControl = false,
) {
  let send!: (part: HarnessV1StreamPart) => void;
  let finish!: () => void;
  const submitToolResult = vi.fn<HarnessV1PromptControl["submitToolResult"]>(
    async () => {},
  );
  const innerControl: HarnessV1PromptControl = {
    submitToolResult,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  const start = async (options: { emit: typeof send }) => {
    send = options.emit;
    if (beforeControl) send(event());
    return innerControl;
  };
  const harness: HarnessV1 = {
    specificationVersion: "harness-v1",
    harnessId: "fixture",
    builtinTools: {},
    doStart: async () => ({
      sessionId: "session",
      isResume: false,
      doPromptTurn: start,
      doContinueTurn: start,
      doCompact: unused,
      doSuspendTurn: unused,
      doDetach: unused,
      doStop: unused,
      doDestroy: unused,
    }),
  };
  const abort = new AbortController();
  const session = await withHarnessElicitation(harness, {
    keyToServerId: { fixture: "server-id", disabled: "disabled-id" },
    allowedServerIds: new Set(["server-id"]),
    handle,
    signal: abort.signal,
  }).doStart(startOptions);
  const emit = vi.fn();
  const control = await session.doPromptTurn({
    prompt: "fixture",
    skills: [],
    tools: [],
    emit,
  });
  return { send, finish, submitToolResult, emit, control, abort };
}

describe("harness elicitation control", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "returns %s to the original control request without exposing a model tool",
    async (action) => {
      const handle = vi.fn<HarnessElicitationHandler>(async () => ({ action }));
      const f = await fixture(handle);
      f.send(event());
      await vi.waitFor(() =>
        expect(f.submitToolResult).toHaveBeenCalledExactlyOnceWith({
          toolCallId: "mcpjam:elicitation:request",
          output: { action },
        }),
      );
      expect(handle.mock.calls[0][0]).toMatchObject({
        serverId: "server-id",
        mode: "form",
      });
      expect(f.emit).not.toHaveBeenCalled();
      f.finish();
      await f.control.done;
    },
  );

  it("deduplicates replay and handles an event arriving before control", async () => {
    const handle = vi.fn<HarnessElicitationHandler>(async () => ({
      action: "accept",
      content: { color: "blue" },
    }));
    const f = await fixture(handle, true);
    f.send(event());
    await vi.waitFor(() => expect(f.submitToolResult).toHaveBeenCalledOnce());
    expect(handle).toHaveBeenCalledOnce();
    expect(f.emit).not.toHaveBeenCalled();
    f.finish();
    await f.control.done;
  });

  it("rejects an unknown server key without displaying its request", async () => {
    const handle = vi.fn<HarnessElicitationHandler>(async () => ({
      action: "accept",
    }));
    const f = await fixture(handle);
    f.send(event("not-selected"));
    await vi.waitFor(() =>
      expect(f.submitToolResult).toHaveBeenCalledWith({
        toolCallId: "mcpjam:elicitation:request",
        output: { action: "cancel" },
      }),
    );
    expect(handle).not.toHaveBeenCalled();
    expect(f.emit).not.toHaveBeenCalled();
    f.finish();
    await f.control.done;
  });

  it("keeps a selected but disabled server unanswered alongside an enabled server", async () => {
    const handle = vi.fn<HarnessElicitationHandler>(async () => ({
      action: "decline",
    }));
    const f = await fixture(handle);
    f.send(event("disabled", "disabled"));
    f.send(event("fixture", "enabled"));
    await vi.waitFor(() => expect(f.submitToolResult).toHaveBeenCalledTimes(2));
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0][0].serverId).toBe("server-id");
    expect(f.submitToolResult).toHaveBeenCalledWith({
      toolCallId: "mcpjam:elicitation:disabled",
      output: { action: "decline" },
    });
    f.finish();
    await f.control.done;
  });

  it("refuses undeclared URL mode even from an eligible form server", async () => {
    const handle = vi.fn<HarnessElicitationHandler>(async () => ({
      action: "accept",
    }));
    const f = await fixture(handle);
    f.send({
      type: "raw",
      rawValue: {
        type: "mcpjam:elicitation",
        phase: "request",
        controlId: "mcpjam:elicitation:url",
        request: {
          serverName: "fixture",
          mode: "url",
          message: "Unqualified URL",
          url: "https://example.com/qa",
        },
      },
    });
    await vi.waitFor(() =>
      expect(f.submitToolResult).toHaveBeenCalledExactlyOnceWith({
        toolCallId: "mcpjam:elicitation:url",
        output: { action: "cancel" },
      }),
    );
    expect(handle).not.toHaveBeenCalled();
    f.finish();
    await f.control.done;
  });

  it.each(["turn", "native"] as const)(
    "cancels a %s abort and refuses a late accept",
    async (source) => {
      let answer!: (result: ElicitResult) => void;
      const handle = vi.fn<HarnessElicitationHandler>(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const f = await fixture(handle);
      f.send(event());
      if (source === "turn") f.abort.abort();
      else
        f.send({
          type: "raw",
          rawValue: {
            type: "mcpjam:elicitation",
            phase: "cancel",
            controlId: "mcpjam:elicitation:request",
          },
        });
      expect(handle.mock.calls[0][1].aborted).toBe(true);
      answer({ action: "accept", content: { color: "late" } });
      await vi.waitFor(() =>
        expect(f.submitToolResult).toHaveBeenCalledWith({
          toolCallId: "mcpjam:elicitation:request",
          output: { action: "cancel" },
        }),
      );
      f.finish();
      await f.control.done;
    },
  );

  it.each(["turn", "native"] as const)(
    "settles %s cancellation even when the input handler never answers",
    async (source) => {
      const handle = vi.fn<HarnessElicitationHandler>(
        () => new Promise(() => {}),
      );
      const f = await fixture(handle);
      f.send(event());
      expect(handle).toHaveBeenCalledTimes(1);
      if (source === "turn") f.abort.abort();
      else
        f.send({
          type: "raw",
          rawValue: {
            type: "mcpjam:elicitation",
            phase: "cancel",
            controlId: "mcpjam:elicitation:request",
          },
        });
      await vi.waitFor(() =>
        expect(f.submitToolResult).toHaveBeenCalledWith({
          toolCallId: "mcpjam:elicitation:request",
          output: { action: "cancel" },
        }),
      );
      f.finish();
      await f.control.done;
    },
  );

  it("consumes malformed private events and fails without logging their payload", async () => {
    const f = await fixture(async () => ({ action: "accept" }));
    f.send({
      type: "raw",
      rawValue: { type: "mcpjam:elicitation", secret: "private-fixture" },
    });
    await expect(f.control.done).rejects.toThrow(
      "Invalid harness elicitation control event",
    );
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("passes unrelated runtime events through unchanged", async () => {
    const f = await fixture(async () => ({ action: "cancel" }));
    const part: HarnessV1StreamPart = {
      type: "text-delta",
      id: "text",
      delta: "hello",
    };
    f.send(part);
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(part);
    f.finish();
    await f.control.done;
  });
});
