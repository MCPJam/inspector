import { afterEach, describe, expect, it, vi } from "vitest";
import { openWebMcpFrameStream } from "../frame-stream-connection";
import { encodeWebMcpBinaryFrame } from "@/shared/webmcp-inspector-protocol";

function harness(coalesceFrames = false) {
  const ticks = new Map<number, FrameRequestCallback>();
  let id = 0;
  const ws = {
    readyState: WebSocket.OPEN,
    binaryType: "",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  const onFrame = vi.fn();
  const onInputSent = vi.fn();
  const onInputAck = vi.fn();
  const connection = openWebMcpFrameStream({
    sessionId: "s",
    token: "test",
    baseUrl: "ws://localhost",
    wsFactory: () => ws,
    onFrame,
    onInputSent,
    onInputAck,
    onClose: vi.fn(),
    coalesceFrames,
    inputAckTimeoutMs: 100,
    requestFrame: (callback) => {
      ticks.set(++id, callback);
      return id;
    },
    cancelFrame: (handle) => {
      ticks.delete(handle);
    },
  });
  const message = (data: unknown) =>
    ws.onmessage?.call(ws, { data } as MessageEvent);
  const control = (data: unknown) => message(JSON.stringify(data));
  return {
    connection,
    ws,
    onFrame,
    onInputSent,
    onInputAck,
    control,
    enable: () => control({ type: "capabilities", features: ["input"] }),
    frame(seq: number) {
      const bytes = encodeWebMcpBinaryFrame({
        deviceWidth: 100,
        deviceHeight: 100,
        ts: 1,
        seq,
        jpeg: new Uint8Array([1, 2]),
      });
      message(bytes.buffer);
    },
    tick() {
      const callbacks = [...ticks.values()];
      ticks.clear();
      callbacks.forEach((f) => f(1));
    },
    disconnect() {
      ws.onclose?.call(ws, { code: 1006, reason: "" } as CloseEvent);
    },
  };
}
const wheel = [{ kind: "wheel" as const, x: 10, y: 10, deltaX: 0, deltaY: 12 }];
afterEach(() => vi.useRealTimers());

describe("Node WebMCP frame connection", () => {
  it("publishes only the newest JPEG on a display tick, including the final frame", () => {
    const h = harness(true);
    for (let i = 1; i <= 30; i++) h.frame(i);
    h.frame(2);
    expect(h.onFrame).not.toHaveBeenCalled();
    h.tick();
    expect(h.onFrame).toHaveBeenCalledTimes(1);
    expect(h.onFrame.mock.calls[0][0].seq).toBe(30);
    h.frame(31);
    h.tick();
    expect(h.onFrame.mock.calls[1][0].seq).toBe(31);
    h.connection.close();
  });

  it.each(["close", "disconnect"] as const)(
    "cancels a pending presentation on %s",
    (action) => {
      const h = harness(true);
      h.frame(1);
      if (action === "close") h.connection.close();
      else h.disconnect();
      h.tick();
      h.frame(2);
      h.tick();
      expect(h.onFrame).not.toHaveBeenCalled();
    },
  );

  it("preserves immediate delivery for consumers that did not opt in", () => {
    const h = harness();
    h.frame(1);
    h.frame(2);
    expect(h.onFrame).toHaveBeenCalledTimes(2);
    h.connection.close();
  });

  it("falls back until the server advertises input, then awaits the matching ack", async () => {
    const h = harness();
    expect(h.connection.sendInput(wheel)).toBeUndefined();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    const done = vi.fn();
    void pending.then(done);
    expect(h.ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "input", seq: 1, events: wheel }),
    );
    h.control({ type: "input_ack", seq: 2, dispatched: 1 });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    h.control({ type: "input_ack", seq: 1, dispatched: 1 });
    await pending;
    expect(h.onInputSent).toHaveBeenCalledWith(1);
    expect(h.onInputAck).toHaveBeenCalledWith(1);
    h.connection.close();
  });

  it("surfaces a refusal and does not replay input", async () => {
    const h = harness();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    h.control({
      type: "input_ack",
      seq: 1,
      dispatched: 0,
      refused: "overloaded",
    });
    await expect(pending).rejects.toThrow("refused");
    expect(h.ws.send).toHaveBeenCalledTimes(1);
    h.connection.close();
  });

  it("rejects interrupted input as uncertain and allows no replay on that socket", async () => {
    const h = harness();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    h.disconnect();
    await expect(pending).rejects.toThrow("may already have executed");
    expect(h.connection.sendInput(wheel)).toBeUndefined();
    expect(h.ws.send).toHaveBeenCalledTimes(1);
  });

  it("times out a missing acknowledgement without replaying the gesture", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    const rejection = expect(pending).rejects.toThrow("not replayed");
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(h.ws.close).not.toHaveBeenCalled();
    h.frame(2);
    expect(h.onFrame).toHaveBeenCalledOnce();
    // A repeated capability announcement must not re-enable timed-out input.
    h.enable();
    expect(h.ws.send).toHaveBeenCalledOnce();
    expect(h.connection.sendInput(wheel)).toBeUndefined();
  });
});
