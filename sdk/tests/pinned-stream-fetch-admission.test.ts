/**
 * `admitPrivateDestination`: a caller that refuses private destinations
 * admitting them one by one, against real sockets.
 *
 * The caller is a hosted deployment on its operator's network: no loopback
 * opt-in and no private-network allowance, only the destinations it admits.
 * What has to hold is that the admission opens exactly those, is asked again
 * on every hop and about every pinned address, and never reaches the floor.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `*.internal.test` names resolve to loopback, so the per-address half of the
 * admission can be driven through the real pinned lookup and a real socket.
 * Every other name goes to the real resolver.
 */
vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  const lookup = ((
    hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    if (!hostname.endsWith(".internal.test")) {
      return actual.lookup(hostname, options as never, callback as never);
    }
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  }) as typeof actual.lookup;
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const { createPinnedStreamingFetch } = await import(
  "../src/oauth/pinned-stream-fetch.js"
);
const { OAuthProxyError } = await import("../src/oauth-proxy-error.js");

type Destination = { hostname: string; address?: string };

const servers: http.Server[] = [];

async function serve(
  handler: http.RequestListener,
): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, hits };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

const ok: http.RequestListener = (_req, res) => {
  res.writeHead(200);
  res.end("ok");
};

describe("admitting private destinations one by one", () => {
  it("dials an admitted private literal in plaintext, with no loopback opt-in", async () => {
    const { port, hits } = await serve(ok);
    const admit = vi.fn(({ hostname }: Destination) => hostname === "127.0.0.1");

    const response = await createPinnedStreamingFetch({
      admitPrivateDestination: admit,
    })(`http://127.0.0.1:${port}/mcp`);

    await expect(response.text()).resolves.toBe("ok");
    expect(hits).toEqual(["/mcp"]);
    expect(admit).toHaveBeenCalledWith({ hostname: "127.0.0.1" });
  });

  it("refuses a private literal it does not admit", async () => {
    const { port, hits } = await serve(ok);

    await expect(
      createPinnedStreamingFetch({ admitPrivateDestination: () => false })(
        `http://127.0.0.1:${port}/mcp`,
      ),
    ).rejects.toThrow(/private\/reserved host/);
    expect(hits).toEqual([]);
  });

  it("asks about each address a name resolved to, and pins the admitted one", async () => {
    const { port, hits } = await serve(ok);
    const admit = vi.fn(
      ({ address }: Destination) => address === "127.0.0.1",
    );

    const response = await createPinnedStreamingFetch({
      admitPrivateDestination: admit,
    })(`http://mcp.internal.test:${port}/mcp`);

    await expect(response.text()).resolves.toBe("ok");
    expect(hits).toEqual(["/mcp"]);
    expect(admit).toHaveBeenCalledWith({
      hostname: "mcp.internal.test",
      address: "127.0.0.1",
    });
  });

  it("refuses a name whose private answer it does not admit", async () => {
    const { port, hits } = await serve(ok);

    await expect(
      createPinnedStreamingFetch({ admitPrivateDestination: () => false })(
        `https://mcp.internal.test:${port}/mcp`,
      ),
    ).rejects.toThrow(/resolves to a private\/reserved IP address/);
    expect(hits).toEqual([]);
  });

  it("asks again on every hop, so a redirect onto an unadmitted destination is refused", async () => {
    const second = await serve(ok);
    const first = await serve((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${second.port}/next` });
      res.end();
    });

    await expect(
      createPinnedStreamingFetch({
        admitPrivateDestination: ({ hostname }) => hostname === "127.0.0.1",
      })(`http://127.0.0.1:${first.port}/mcp`),
    ).rejects.toThrow(/private\/reserved host \(localhost\)/);
    expect(first.hits).toEqual(["/mcp"]);
    expect(second.hits).toEqual([]);
  });

  it("follows a redirect onto a destination it admits", async () => {
    const second = await serve(ok);
    const first = await serve((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${second.port}/next` });
      res.end();
    });

    const response = await createPinnedStreamingFetch({
      admitPrivateDestination: ({ hostname }) => hostname === "127.0.0.1",
    })(`http://127.0.0.1:${first.port}/mcp`);

    await expect(response.text()).resolves.toBe("ok");
    expect(second.hits).toEqual(["/next"]);
  });

  it("is never asked about metadata or link-local, which stay refused", async () => {
    const admit = vi.fn(() => true);
    const guarded = createPinnedStreamingFetch({
      admitPrivateDestination: admit,
    });

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/mcp",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await expect(guarded(url)).rejects.toBeInstanceOf(OAuthProxyError);
    }
    expect(admit).not.toHaveBeenCalled();
  });

  it("still requires https for a public destination", async () => {
    await expect(
      createPinnedStreamingFetch({ admitPrivateDestination: () => true })(
        "http://93.184.216.34/mcp",
      ),
    ).rejects.toThrow(/Refusing a plaintext connection/);
  });
});
