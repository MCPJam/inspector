import { describe, expect, it, vi } from "vitest";
import {
  buildComputerUploadUrl,
  buildTerminalWsUrl,
  openTerminalConnection,
  toTerminalWsBase,
  uploadFilesToComputer,
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

  it("appends an encoded cwd when provided", () => {
    const url = buildTerminalWsUrl({
      token: "abc",
      cols: 80,
      rows: 24,
      baseUrl: "wss://host.test",
      cwd: "/home/user/claude-code-XyZ",
    });
    expect(url).toContain("&cwd=%2Fhome%2Fuser%2Fclaude-code-XyZ");
  });

  it("omits cwd when absent", () => {
    const url = buildTerminalWsUrl({
      token: "abc",
      cols: 80,
      rows: 24,
      baseUrl: "wss://host.test",
    });
    expect(url).not.toContain("cwd=");
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

describe("buildComputerUploadUrl", () => {
  it("converts a wss base to https and appends the upload path", () => {
    expect(buildComputerUploadUrl({ baseUrl: "wss://host.test" })).toBe(
      "https://host.test/api/web/computers/upload"
    );
    expect(buildComputerUploadUrl({ baseUrl: "ws://localhost:3500" })).toBe(
      "http://localhost:3500/api/web/computers/upload"
    );
  });

  it("returns a relative path when no base is given (page origin)", () => {
    expect(buildComputerUploadUrl()).toBe("/api/web/computers/upload");
    expect(buildComputerUploadUrl({})).toBe("/api/web/computers/upload");
  });
});

describe("uploadFilesToComputer", () => {
  function fakeFile(name: string): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "text/plain" });
  }

  it("POSTs a FormData with the token in the query and returns written files", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calledUrl = String(url);
      calledInit = init;
      return new Response(
        JSON.stringify({
          ok: true,
          files: [{ name: "x", path: "/home/user/uploads/x", bytes: 3 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const files = await uploadFilesToComputer({
      token: "tok-9",
      files: [fakeFile("a.txt")],
      baseUrl: "wss://host.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(calledUrl).toBe(
      "https://host.test/api/web/computers/upload?token=tok-9"
    );
    expect(calledInit?.method).toBe("POST");
    expect(calledInit?.body).toBeInstanceOf(FormData);
    expect((calledInit?.body as FormData).getAll("files")).toHaveLength(1);
    expect(files).toEqual([
      { name: "x", path: "/home/user/uploads/x", bytes: 3 },
    ]);
  });

  it("throws with the server-supplied message on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "computer asleep" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
    );
    await expect(
      uploadFilesToComputer({
        token: "t",
        files: [fakeFile("a.txt")],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow("computer asleep");
  });

  it("throws a status fallback when the body isn't JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>502</html>", { status: 502 })
    );
    await expect(
      uploadFilesToComputer({
        token: "t",
        files: [fakeFile("a.txt")],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow("502");
  });
});

describe("toTerminalWsBase", () => {
  it("maps https to wss and http to ws, keeping host and port", () => {
    expect(toTerminalWsBase("https://dp.example.test")).toBe(
      "wss://dp.example.test"
    );
    expect(toTerminalWsBase("http://localhost:3500")).toBe(
      "ws://localhost:3500"
    );
  });

  it("drops any path — the WS route is fixed", () => {
    expect(toTerminalWsBase("https://dp.example.test/some/path")).toBe(
      "wss://dp.example.test"
    );
  });

  it("returns undefined for invalid or non-http(s) inputs", () => {
    expect(toTerminalWsBase("not a url")).toBeUndefined();
    expect(toTerminalWsBase("ftp://dp.example.test")).toBeUndefined();
  });
});
