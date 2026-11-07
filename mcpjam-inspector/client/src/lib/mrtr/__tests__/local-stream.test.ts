import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalMrtrStream } from "../local-stream";
import {
  LOCAL_MRTR_PROTOCOL,
  LOCAL_MRTR_MAX_FRAME_BYTES,
} from "@/shared/local-mrtr-wire";

class Socket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = LOCAL_MRTR_PROTOCOL;
  readyState: number = 0;
  url = "ws://localhost/forms";
  onopen: WebSocket["onopen"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  onmessage: WebSocket["onmessage"] = null;
  sent: string[] = [];
  closeCode?: number;
  send(data: Parameters<WebSocket["send"]>[0]) {
    this.sent.push(String(data));
  }
  close(code = 1000) {
    if (code !== 1000 && (code < 3000 || code > 4999))
      throw new DOMException("Invalid browser close code", "InvalidAccessError");
    this.disconnect(code);
  }
  disconnect(code = 1006) {
    this.closeCode = code;
    this.readyState = 3;
    this.onclose?.call(this, new CloseEvent("close", { code }));
  }
  open() {
    this.readyState = 1;
    this.onopen?.call(this, new Event("open"));
  }
  message(data: unknown) {
    this.onmessage?.call(
      this,
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

function fixture(ready = true) {
  const sockets: Socket[] = [];
  const factory = vi.fn(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const onEvent = vi.fn();
  const onSnapshot = vi.fn();
  const stream = openLocalMrtrStream({
    token: () => "fixture-session-token-0123456789",
    baseUrl: "http://localhost:6274/",
    socket: factory,
    onEvent,
    onSnapshot,
  });
  sockets[0].open();
  if (ready) {
    sockets[0].message({ type: "snapshot_start" });
    sockets[0].message({ type: "snapshot_end" });
  }
  return { sockets, factory, stream, onEvent, onSnapshot };
}

afterEach(() => vi.useRealTimers());

describe("local form WebSocket", () => {
  it("offers the public protocol before a credential that never enters the URL", () => {
    const f = fixture();
    expect(f.factory).toHaveBeenCalledWith(
      "ws://localhost:6274/api/web/mcp/mrtr/stream",
      [LOCAL_MRTR_PROTOCOL, "mcpjam-session.fixture-session-token-0123456789"],
    );
    f.stream.close();
  });

  it("publishes an authoritative snapshot only after its complete boundary", () => {
    const f = fixture(false);
    f.sockets[0].message({ type: "snapshot_start" });
    f.sockets[0].message({
      type: "mrtr_input_request",
      opId: "op",
      roundKey: "op:1",
      round: 1,
      requests: [],
      timestamp: "now",
    });
    expect(f.onSnapshot).not.toHaveBeenCalled();
    expect(f.onEvent).not.toHaveBeenCalled();
    f.sockets[0].message({ type: "snapshot_end" });
    expect(f.onSnapshot.mock.calls[0][0]).toMatchObject([{ roundKey: "op:1" }]);
    f.stream.close();
  });

  it("refuses answers until the authoritative reconnect snapshot is complete", async () => {
    const f = fixture(false);
    await expect(
      f.stream.respond("op", "op:1", { q: { action: "cancel" } }),
    ).rejects.toThrow("interrupted");
    f.sockets[0].message({ type: "snapshot_start" });
    await expect(
      f.stream.respond("op", "op:1", { q: { action: "cancel" } }),
    ).rejects.toThrow("interrupted");
    expect(f.sockets[0].sent).toEqual([]);
    f.stream.close();
  });

  it("settles only the corresponding answer acknowledgement", async () => {
    const f = fixture();
    const answer = f.stream.respond("op", "op:1", { q: { action: "cancel" } });
    const sent = JSON.parse(f.sockets[0].sent[0]);
    f.sockets[0].message({
      type: "response",
      requestId: "other",
      result: { ok: true },
    });
    f.sockets[0].message({
      type: "response",
      requestId: sent.requestId,
      result: { ok: true },
    });
    await expect(answer).resolves.toBeUndefined();
    f.stream.close();
  });

  it("rejects an unknown disconnect outcome without replaying the answer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const answer = expect(
      f.stream.respond("op", "op:1", {
        q: { action: "accept", content: { value: 1 } },
      }),
    ).rejects.toThrow("interrupted");
    f.sockets[0].disconnect();
    await answer;
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1].open();
    expect(f.sockets[1].sent).toEqual([]);
    f.stream.close();
  });

  it("keeps answers blocked after reconnect until the replacement snapshot ends", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.sockets[0].disconnect();
    await vi.advanceTimersByTimeAsync(1500);
    f.sockets[1].open();
    await expect(
      f.stream.respond("op", "op:1", { q: { action: "cancel" } }),
    ).rejects.toThrow("interrupted");
    expect(f.sockets[1].sent).toEqual([]);
    f.stream.close();
  });

  it("times out an acknowledgement without retrying a potentially committed answer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const answer = expect(
      f.stream.respond("op", "op:1", { q: { action: "decline" } }),
    ).rejects.toThrow("interrupted");
    await vi.advanceTimersByTimeAsync(30_000);
    await answer;
    expect(f.sockets[0].sent).toHaveLength(1);
    f.stream.close();
  });

  it("cancels reconnect when its owner releases the stream", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.sockets[0].disconnect();
    f.stream.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sockets).toHaveLength(1);
  });

  it.each(["protocol", "json", "schema", "oversized"])(
    "reconnects after a %s failure without replaying an uncertain answer",
    async (failure) => {
      vi.useFakeTimers();
      const f = fixture();
      const answer = expect(
        f.stream.respond("op", "op:1", { q: { action: "accept" } }),
      ).rejects.toThrow("interrupted");
      const socket = f.sockets[0];
      if (failure === "protocol") {
        socket.protocol = "unexpected";
        socket.open();
      } else {
        socket.onmessage?.call(socket, new MessageEvent("message", {
          data: failure === "json" ? "{" : failure === "schema"
            ? '{"type":"unknown"}' : "x".repeat(LOCAL_MRTR_MAX_FRAME_BYTES + 1),
        }));
      }
      await answer;
      expect(socket.readyState).toBe(3);
      await vi.advanceTimersByTimeAsync(1500);
      expect(f.sockets).toHaveLength(2);
      f.sockets[1].open();
      expect(f.sockets[1].sent).toEqual([]);
      expect(f.onEvent).not.toHaveBeenCalled();
      f.stream.close();
    },
  );

  it("refuses malformed and oversized messages before using them", () => {
    const f = fixture();
    f.sockets[0].message({ type: "mrtr_input_request", opId: 42 });
    expect(f.sockets[0].closeCode).toBe(4007);
    expect(f.onEvent).not.toHaveBeenCalled();
    f.stream.close();
    const oversized = fixture();
    oversized.sockets[0].message("x".repeat(LOCAL_MRTR_MAX_FRAME_BYTES + 1));
    expect(oversized.sockets[0].closeCode).toBe(4009);
    oversized.stream.close();
  });
});
