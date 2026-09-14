import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { probeMcpServer } from "../src/server-probe.js";

/**
 * Issue #5000, the half a mocked `fetchFn` cannot show.
 *
 * The sibling file drives discovery through a stub fetch, so it proves the
 * probe asks the right question per destination — but a stub never actually
 * follows a redirect, which means it cannot show what the RUNTIME does when
 * the probe does not follow them itself.
 *
 * This runs the real `fetch` against two real origins. `fetch` with
 * `redirect: "follow"` strips `Authorization`, `Cookie` and
 * `Proxy-Authorization` across origins per the Fetch standard, and nothing
 * else — so a stored `X-Api-Key` arrives at the redirect target intact. That
 * is the fact the manual following exists for, and asserting it here means a
 * future "simplify back to redirect: follow" fails in CI rather than in
 * someone's account.
 */

type Hop = { path: string; headers: Record<string, string | undefined> };

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("metadata redirects against a real fetch (#5000)", () => {
  it("the runtime forwards a custom credential header across an origin — which is why the probe follows redirects itself", async () => {
    const hops: Hop[] = [];
    const target = await listen((req, res) => {
      hops.push({ path: "target", headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const origin = await listen((req, res) => {
      hops.push({ path: "origin", headers: { ...req.headers } });
      res.writeHead(302, { location: `${target}/prm` });
      res.end();
    });

    await fetch(`${origin}/prm`, {
      headers: {
        "x-api-key": "vendor-key-value",
        authorization: "Bearer tok",
      },
      redirect: "follow",
    });

    const landed = hops.find((hop) => hop.path === "target");
    expect(landed).toBeDefined();
    // The spec-stripped one.
    expect(landed!.headers.authorization).toBeUndefined();
    // The one nothing strips — the whole reason this PR exists.
    expect(landed!.headers["x-api-key"]).toBe("vendor-key-value");
  });

  it("the probe itself does not let it happen", async () => {
    const hops: Hop[] = [];
    const target = await listen((req, res) => {
      hops.push({ path: "target", headers: { ...req.headers } });
      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ resource: "x", authorization_servers: [] }));
    });

    let serverBase = "";
    serverBase = await listen((req, res) => {
      if (req.url === "/mcp") {
        hops.push({ path: "mcp", headers: { ...req.headers } });
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${serverBase}/prm"`,
        });
        res.end();
        return;
      }
      if (req.url === "/prm") {
        // The server's own metadata URL — it legitimately receives the stored
        // headers, and then points somewhere else entirely.
        hops.push({ path: "prm", headers: { ...req.headers } });
        res.writeHead(302, { location: `${target}/prm` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await probeMcpServer({
      url: `${serverBase}/mcp`,
      headers: { "X-Api-Key": "vendor-key-value" },
      // Both origins are loopback, which the destination guard refuses unless
      // the caller is the local inspector or CLI.
      allowPrivateNetwork: true,
    });

    const own = hops.find((hop) => hop.path === "prm");
    expect(own).toBeDefined();
    expect(own!.headers["x-api-key"]).toBe("vendor-key-value");

    const landed = hops.find((hop) => hop.path === "target");
    expect(landed).toBeDefined();
    expect(landed!.headers["x-api-key"]).toBeUndefined();
  });

  it("a 304 carrying a Location is not a redirect and is not followed", async () => {
    // 3xx is wider than the redirect statuses. `fetch` follows 301, 302, 303,
    // 307 and 308 and nothing else, so a `304 Not Modified` that happens to
    // carry a stale `Location` must not put a request on the wire that the
    // automatic path would never make (CodeRabbit).
    const hops: Hop[] = [];
    const target = await listen((req, res) => {
      hops.push({ path: "target", headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: "x", authorization_servers: [] }));
    });

    let serverBase = "";
    serverBase = await listen((req, res) => {
      if (req.url === "/mcp") {
        hops.push({ path: "mcp", headers: { ...req.headers } });
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${serverBase}/prm"`,
        });
        res.end();
        return;
      }
      if (req.url === "/prm") {
        hops.push({ path: "prm", headers: { ...req.headers } });
        res.writeHead(304, { location: `${target}/prm` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await probeMcpServer({
      url: `${serverBase}/mcp`,
      headers: { "X-Api-Key": "vendor-key-value" },
      allowPrivateNetwork: true,
    });

    expect(hops.find((hop) => hop.path === "prm")).toBeDefined();
    expect(hops.find((hop) => hop.path === "target")).toBeUndefined();
  });
});
