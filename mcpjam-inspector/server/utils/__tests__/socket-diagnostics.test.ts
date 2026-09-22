import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "node:http";
import net from "node:net";

const events: Array<{ name: string; payload: Record<string, number> }> = [];

vi.mock("../request-logger.js", () => ({
  getSystemLogger: () => ({
    event: (name: string, payload: Record<string, number>) => {
      events.push({ name, payload });
    },
  }),
}));

const { attachSocketDiagnostics, flushSocketStats } = await import(
  "../socket-diagnostics.js"
);

/** Drive a real socket-level failure and return the server's raw reply. */
function rawExchange(
  port: number,
  write: (socket: net.Socket) => void,
): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const socket = net.connect(port, "127.0.0.1", () => write(socket));
    socket.on("data", (d) => {
      buf += d.toString();
    });
    socket.on("close", () => resolve(buf));
    socket.on("error", () => resolve(buf));
  });
}

async function withServer(
  fn: (port: number) => Promise<void>,
  options?: http.ServerOptions,
): Promise<void> {
  const server = http.createServer(options ?? {}, (_req, res) => res.end("ok"));
  attachSocketDiagnostics(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  events.length = 0;
  flushSocketStats();
  events.length = 0;
});

describe("socket diagnostics", () => {
  it("still answers 400 on a malformed request line", async () => {
    // Attaching a clientError listener REPLACES Node's default handling, so
    // the response contract has to be preserved explicitly. If this breaks,
    // a counter has silently become a behaviour change.
    await withServer(async (port) => {
      const reply = await rawExchange(port, (s) =>
        s.write("NOT-HTTP \r\n\r\n"),
      );
      expect(reply).toContain("400 Bad Request");
    });
  });

  it("answers 431 when headers overflow", async () => {
    await withServer(
      async (port) => {
        const huge = "x".repeat(2000);
        const reply = await rawExchange(port, (s) =>
          s.write(`GET / HTTP/1.1\r\nHost: a\r\nX-Big: ${huge}\r\n\r\n`),
        );
        expect(reply).toContain("431");
      },
      { maxHeaderSize: 1024 },
    );
  });

  it("counts a parse failure and reports it in one aggregated row", async () => {
    await withServer(async (port) => {
      await rawExchange(port, (s) => s.write("BAD REQUEST LINE\r\n\r\n"));
    });

    flushSocketStats();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("http.socket.client_error");
    expect(events[0].payload.total).toBeGreaterThan(0);
    // Bucketed, never the raw code — cardinality must not track peer behaviour.
    expect(Object.keys(events[0].payload).sort()).toEqual([
      "econnaborted",
      "econnreset",
      "epipe",
      "etimedout",
      "headerOverflow",
      "other",
      "parseError",
      "total",
    ]);
  });

  it("aggregates a storm into a single row rather than one row per socket", async () => {
    await withServer(async (port) => {
      for (let i = 0; i < 12; i++) {
        await rawExchange(port, (s) => s.write("GARBAGE\r\n\r\n"));
      }
    });

    flushSocketStats();
    expect(events).toHaveLength(1);
    expect(events[0].payload.total).toBe(12);
  });

  it("emits nothing when there were no failures", () => {
    flushSocketStats();
    expect(events).toHaveLength(0);
  });

  it("resets counters after a flush so the next interval starts clean", async () => {
    await withServer(async (port) => {
      await rawExchange(port, (s) => s.write("GARBAGE\r\n\r\n"));
    });
    flushSocketStats();
    events.length = 0;

    flushSocketStats();
    expect(events).toHaveLength(0);
  });

  it("does not throw when the peer is already gone", async () => {
    // The socket can die between the writable check and the write. Throwing
    // here would reach uncaughtException and take the process down over a
    // dead connection.
    await withServer(async (port) => {
      await new Promise<void>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write("GARBAGE\r\n\r\n");
          socket.destroy();
          setTimeout(resolve, 50);
        });
        socket.on("error", () => resolve());
      });
    });
    // Reaching here without an unhandled exception is the assertion.
    expect(true).toBe(true);
  });
});
