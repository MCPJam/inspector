import { describe, expect, it, vi } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  describeStartupFailure,
  NoFreePortError,
  probeFreePort,
  SERVER_PORT_PINNED_ENV,
  shouldRestartForPortConflict,
  waitForListening,
} from "./server-port-fallback";

function listenBlocker(port: number): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
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

describe("probeFreePort", () => {
  it("returns the first port when it's free", async () => {
    // Pick an ephemeral port we know is currently free.
    const probe = await listenBlocker(0);
    const freePort = probe.port;
    await probe.close();

    const picked = await probeFreePort("127.0.0.1", freePort, 3);
    expect(picked).toBe(freePort);
  });

  it("falls back to the next port on EADDRINUSE", async () => {
    // Grab a port and hold it so the first probe attempt collides.
    const blocker = await listenBlocker(0);
    const onAttemptFailed = vi.fn();

    try {
      const picked = await probeFreePort("127.0.0.1", blocker.port, 5, {
        onAttemptFailed,
      });

      expect(picked).toBeGreaterThan(blocker.port);
      expect(onAttemptFailed).toHaveBeenCalled();
      const [failedPort, failedErr] = onAttemptFailed.mock.calls[0];
      expect(failedPort).toBe(blocker.port);
      expect(failedErr.code).toBe("EADDRINUSE");
    } finally {
      await blocker.close();
    }
  });

  it("releases the probe socket before returning (next caller can bind the picked port)", async () => {
    // The probe must close its server before resolving — otherwise the caller
    // can't bind the picked port. Use a real net listen on the picked port
    // to prove it's actually free.
    const probe = await listenBlocker(0);
    const freePort = probe.port;
    await probe.close();

    const picked = await probeFreePort("127.0.0.1", freePort, 3);

    const reuse = await listenBlocker(picked);
    expect(reuse.port).toBe(picked);
    await reuse.close();
  });

  it("throws after maxAttempts when every port fails", async () => {
    // Inject a createServer that always emits EADDRINUSE so we don't need to
    // occupy a whole range of real ports.
    const fakeCreateServer = (() => {
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      const server = {
        once(ev: string, fn: (...args: unknown[]) => void) {
          (handlers[ev] ||= []).push(fn);
        },
        on(ev: string, fn: (...args: unknown[]) => void) {
          (handlers[ev] ||= []).push(fn);
        },
        removeListener() {},
        close(cb?: (err?: Error) => void) {
          cb?.();
        },
        listen() {
          queueMicrotask(() => {
            const err = new Error("address in use") as NodeJS.ErrnoException;
            err.code = "EADDRINUSE";
            handlers["error"]?.forEach((fn) => fn(err));
          });
        },
      };
      return server as unknown as ReturnType<typeof net.createServer>;
    }) as typeof net.createServer;

    const onAttemptFailed = vi.fn();
    await expect(
      probeFreePort("127.0.0.1", 60000, 4, {
        createServerImpl: fakeCreateServer,
        onAttemptFailed,
      }),
    ).rejects.toThrow(/No free port available after 4 attempts/);
    expect(onAttemptFailed).toHaveBeenCalledTimes(4);
  });
});

describe("waitForListening", () => {
  it("resolves once bound and leaves no extra error listener", async () => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");

    await waitForListening(server);

    expect(server.listening).toBe(true);
    expect(server.listenerCount("error")).toBe(0);
    await new Promise<void>((res) => server.close(() => res()));
  });

  it("rejects with EADDRINUSE instead of throwing it as uncaught", async () => {
    // The race the probe can't close: something else owns the port by the
    // time the real server binds.
    const blocker = await listenBlocker(0);
    const server = net.createServer();
    server.listen(blocker.port, "127.0.0.1");

    await expect(waitForListening(server)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(server.listenerCount("listening")).toBe(0);
    await blocker.close();
  });
});

function addressInUse(port?: number): NodeJS.ErrnoException {
  const err = new Error("listen EADDRINUSE") as NodeJS.ErrnoException & {
    port?: number;
  };
  err.code = "EADDRINUSE";
  if (port !== undefined) err.port = port;
  return err;
}

describe("shouldRestartForPortConflict", () => {
  it("restarts once for a lost bind", () => {
    expect(
      shouldRestartForPortConflict(addressInUse(6274), {
        alreadyRetried: false,
        env: {},
      }),
    ).toBe(true);
  });

  it("does not restart for any other failure", () => {
    for (const error of [
      new Error("boom"),
      new NoFreePortError("No free port available"),
      null,
      "EADDRINUSE",
    ])
      expect(
        shouldRestartForPortConflict(error, { alreadyRetried: false, env: {} }),
      ).toBe(false);
  });

  it("does not restart twice", () => {
    expect(
      shouldRestartForPortConflict(addressInUse(6274), {
        alreadyRetried: true,
        env: {},
      }),
    ).toBe(false);
  });

  it("does not restart when the launcher pinned the port", () => {
    expect(
      shouldRestartForPortConflict(addressInUse(6274), {
        alreadyRetried: false,
        env: { [SERVER_PORT_PINNED_ENV]: "1" },
      }),
    ).toBe(false);
  });
});

describe("describeStartupFailure", () => {
  it("names the port a lost bind was on", async () => {
    // A real listen error, so this pins Node putting `port` on it.
    const blocker = await listenBlocker(0);
    const server = net.createServer();
    server.listen(blocker.port, "127.0.0.1");
    const error = await waitForListening(server).catch((err: unknown) => err);
    await blocker.close();

    expect(describeStartupFailure(error)).toEqual({
      code: "port_taken",
      port: blocker.port,
    });
  });

  it("tells a full port range and other failures apart", async () => {
    const fullRange = await probeFreePort("127.0.0.1", 60000, 0).catch(
      (err: unknown) => err,
    );
    expect(describeStartupFailure(fullRange)).toEqual({ code: "no_free_port" });
    expect(describeStartupFailure(new Error("boom"))).toEqual({
      code: "startup_failed",
    });
  });
});
