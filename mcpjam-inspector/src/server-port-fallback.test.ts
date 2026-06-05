import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tryListenWithFallback } from "./server-port-fallback";

const honoStub = {
  fetch: () =>
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
};

function listenBlocker(port: number): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  return new Promise((resolve, reject) => {
    const srv = createServer(() => {});
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      const actualPort = (srv.address() as AddressInfo).port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            srv.close(() => res());
          }),
      });
    });
  });
}

describe("tryListenWithFallback", () => {
  it("returns first port when free", async () => {
    // Pick an ephemeral port we know is currently free.
    const probe = await listenBlocker(0);
    const freePort = probe.port;
    await probe.close();

    const { server, port } = await tryListenWithFallback(
      honoStub,
      "127.0.0.1",
      freePort,
      3,
    );
    expect(port).toBe(freePort);
    server.close?.();
  });

  it("falls back to the next port on EADDRINUSE", async () => {
    // Grab a port and hold it so the first attempt collides.
    const blocker = await listenBlocker(0);
    const onAttemptFailed = vi.fn();

    try {
      const { server, port } = await tryListenWithFallback(
        honoStub,
        "127.0.0.1",
        blocker.port,
        5,
        { onAttemptFailed },
      );

      expect(port).toBeGreaterThan(blocker.port);
      expect(onAttemptFailed).toHaveBeenCalled();
      const [failedPort, failedErr] = onAttemptFailed.mock.calls[0];
      expect(failedPort).toBe(blocker.port);
      expect(failedErr.code).toBe("EADDRINUSE");

      server.close?.();
    } finally {
      await blocker.close();
    }
  });

  it("throws after maxAttempts when every port fails", async () => {
    // Inject a serve that always emits EADDRINUSE so we don't need to occupy
    // a whole range of real ports.
    const fakeServe = ((_options: unknown, _listening?: () => void) => {
      const emitter: Record<string, Array<(...args: unknown[]) => void>> = {};
      const server = {
        on(ev: string, fn: (...args: unknown[]) => void) {
          (emitter[ev] ||= []).push(fn);
          // Defer firing so the helper has a chance to attach its listener.
          if (ev === "error") {
            queueMicrotask(() => {
              const err = new Error("address in use") as NodeJS.ErrnoException;
              err.code = "EADDRINUSE";
              fn(err);
            });
          }
        },
        removeListener() {},
        close() {},
      };
      return server as unknown as ReturnType<typeof import("@hono/node-server").serve>;
    }) as typeof import("@hono/node-server").serve;

    const onAttemptFailed = vi.fn();
    await expect(
      tryListenWithFallback(honoStub, "127.0.0.1", 60000, 4, {
        serveImpl: fakeServe,
        onAttemptFailed,
      }),
    ).rejects.toThrow(/Failed to bind server after 4 attempts/);
    expect(onAttemptFailed).toHaveBeenCalledTimes(4);
  });

  it("propagates synchronous throws from serve", async () => {
    const fakeServe = (() => {
      throw new Error("synthetic synchronous boom");
    }) as unknown as typeof import("@hono/node-server").serve;

    await expect(
      tryListenWithFallback(honoStub, "127.0.0.1", 60000, 1, {
        serveImpl: fakeServe,
      }),
    ).rejects.toThrow(/Failed to bind server after 1 attempts/);
  });
});
