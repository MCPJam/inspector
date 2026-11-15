import { afterEach, expect, it, vi } from "vitest";
import { nativeApprovalResponse } from "../native-approval-response.js";
import { forwardNativeMcp } from "../native-transport.js";

afterEach(() => vi.useRealTimers());

it("leaves responses without an approval wait unchanged", async () => {
  const response = new Response("original", { status: 401 });
  expect(
    await nativeApprovalResponse({
      run: async () => response,
      onError: vi.fn(),
    }),
  ).toBe(response);
});

it("sends SSE comments during approval, then the original multiline result", async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const done = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const response = await nativeApprovalResponse({
    run: (waiting) => {
      waiting();
      return done;
    },
    onError: vi.fn(),
  });
  const reader = response.body!.getReader();
  const decode = (chunk: ReadableStreamReadResult<Uint8Array>) =>
    new TextDecoder().decode(chunk.value);
  expect(decode(await reader.read())).toBe(": awaiting approval\n\n");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(decode(await reader.read())).toBe(": awaiting approval\n\n");
  finish(new Response('{\n"jsonrpc":"2.0","id":1,"result":{"content":[]}\n}'));
  expect(decode(await reader.read())).toBe(
    'data: {\ndata: "jsonrpc":"2.0","id":1,"result":{"content":[]}\ndata: }\n\n',
  );
  expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves an upstream SSE frame after the approval comments", async () => {
  const frame = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
  const response = await nativeApprovalResponse({
    run: async (waiting) => {
      waiting();
      return new Response(frame, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    onError: vi.fn(),
  });
  const text = await response.text();
  expect(text).toBe(": awaiting approval\n\n" + frame);
});

it("aborts the waiting operation when the native client disconnects", async () => {
  let signal!: AbortSignal;
  const onError = vi.fn();
  const response = await nativeApprovalResponse({
    run: (waiting, active) => {
      signal = active;
      waiting();
      return new Promise<Response>((_, reject) =>
        active.addEventListener("abort", () => reject(active.reason), {
          once: true,
        }),
      );
    },
    onError,
  });
  await response.body!.cancel();
  expect(signal.aborted).toBe(true);
});

it("turns a failed approval into a bounded MCP error without exposing its cause", async () => {
  const onError = vi.fn();
  const response = await nativeApprovalResponse({
    rpcId: "call",
    run: async (waiting) => {
      waiting();
      throw new Error("private cause");
    },
    onError,
  });
  const text = await response.text();
  expect(text).toContain('"id":"call"');
  expect(text).toContain('"code":-32000');
  expect(text).not.toContain("private cause");
  expect(onError).toHaveBeenCalledOnce();
});

it("aborts an already dispatched fetch and cancels its upstream stream", async () => {
  const cancel = vi.fn();
  const settle = vi.fn();
  let fetchSignal: AbortSignal | undefined;
  const response = await nativeApprovalResponse({
    rpcId: 1,
    onError: vi.fn(),
    run: async (waiting, signal) => {
      waiting();
      return forwardNativeMcp({
        url: "https://upstream.example",
        serverId: "server",
        signal,
        request: new Request("https://proxy.example"),
        message: { jsonrpc: "2.0", id: 1, method: "tools/call" },
        settle,
        fetch: async (_url, init) => {
          fetchSignal = init?.signal ?? undefined;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(": upstream ready\n\n"),
                );
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
    },
  });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  expect(fetchSignal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(settle).toHaveBeenCalledWith({ outcome: "incomplete" });
});
