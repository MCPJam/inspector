import { describe, expect, it, vi } from "vitest";
import {
  buildTerminalWsUrl,
  openTerminalConnection,
  type TerminalEvent,
} from "../computer-terminal-connection";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  binaryType = "blob";
  readyState = WebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<string | ArrayBufferView> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(payload: string | ArrayBufferView) {
    this.sent.push(payload);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "client" } as CloseEvent);
  }
  // helpers
  emitText(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }
  emitBinary(bytes: Uint8Array) {
    this.onmessage?.({
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ),
    } as MessageEvent);
  }
}

function open(
  overrides: Partial<Parameters<typeof openTerminalConnection>[0]> = {}
) {
  const events: TerminalEvent[] = [];
  const output: Uint8Array[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const conn = openTerminalConnection({
    token: "tok-123",
    cols: 80,
    rows: 24,
    baseUrl: "wss://example.test",
    wsFactory: (u) => new FakeWebSocket(u) as unknown as WebSocket,
    onOutput: (b) => output.push(b),
    onEvent: (e) => events.push(e),
    onClose: (code, reason) => closes.push({ code, reason }),
    ...overrides,
  });
  const ws = FakeWebSocket.instances.at(-1)!;
  return { conn, ws, events, output, closes };
}

describe("buildTerminalWsUrl", () => {
  it("builds the route URL with token + dims from the base origin", () => {
    expect(
      buildTerminalWsUrl({
        token: "abc",
        cols: 100,
        rows: 30,
        baseUrl: "wss://host.test",
      })
    ).toBe(
      "wss://host.test/api/web/computers/terminal?token=abc&cols=100&rows=30"
    );
  });
});

describe("openTerminalConnection", () => {
  it("sets binaryType and connects to the token URL", () => {
    const { ws } = open();
    expect(ws.binaryType).toBe("arraybuffer");
    expect(ws.url).toContain("token=tok-123");
    expect(ws.url).toContain("cols=80");
  });

  it("sends stdin as a binary frame and resize/ping as text JSON", () => {
    const { conn, ws } = open();
    conn.sendInput(new Uint8Array([104, 105])); // "hi"
    conn.resize(120, 40);
    conn.ping();
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(ws.sent[1] as string)).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });
    expect(JSON.parse(ws.sent[2] as string)).toEqual({ type: "ping" });
  });

  it("does not send when the socket is not open", () => {
    const { conn, ws } = open();
    ws.readyState = WebSocket.CLOSED;
    conn.sendInput(new Uint8Array([1]));
    conn.resize(10, 10);
    expect(ws.sent).toHaveLength(0);
  });

  it("routes ready/exit/error text frames to onEvent and ignores pong", () => {
    const { ws, events } = open();
    ws.emitText({ type: "ready", sessionId: "s1" });
    ws.emitText({ type: "pong" });
    ws.emitText({ type: "exit" });
    ws.emitText({ type: "error", message: "boom" });
    expect(events).toEqual([
      { type: "ready", sessionId: "s1" },
      { type: "exit" },
      { type: "error", message: "boom" },
    ]);
  });

  it("delivers binary frames as PTY output", () => {
    const { ws, output } = open();
    ws.emitBinary(new Uint8Array([255, 0, 65]));
    expect(output).toHaveLength(1);
    expect(Array.from(output[0])).toEqual([255, 0, 65]);
  });

  it("surfaces close code/reason", () => {
    const { ws, closes } = open();
    ws.onclose?.({ code: 4401, reason: "expired" } as CloseEvent);
    expect(closes).toEqual([{ code: 4401, reason: "expired" }]);
  });

  it("tolerates malformed text frames without throwing", () => {
    const { ws, events } = open();
    expect(() =>
      ws.onmessage?.({ data: "not json {{{" } as MessageEvent)
    ).not.toThrow();
    expect(events).toHaveLength(0);
  });
});
