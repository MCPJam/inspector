/**
 * HP-44 — startup guarantees of the real-HTTP capture server.
 *
 * Everything here is about a failure that would otherwise be SILENT rather than
 * loud. A capture server that advertises a bogus origin, or one whose startup
 * promise never settles, does not produce a bad trace — it produces no trace and
 * an operator staring at a hung terminal, after a manual handshake that cannot
 * be replayed.
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startCaptureServer } from "./oauth-capture-server.js";

describe("startCaptureServer startup guards", () => {
  it("rejects a publicOrigin that is not an absolute http(s) URL", async () => {
    // The motivating case is a bare `--public-origin` on the CLI, which takes the
    // NEXT FLAG as its value. That string would become the PRM `resource`, the AS
    // metadata origin and the 401 challenge pointer.
    for (const bad of ["--keep-raw-har", "example.test", "ftp://example.test", ""]) {
      await expect(startCaptureServer({ publicOrigin: bad })).rejects.toThrow(
        /publicOrigin must be an absolute http\(s\) URL/,
      );
    }
  });

  it("accepts a well-formed publicOrigin and advertises it", async () => {
    const server = await startCaptureServer({
      publicOrigin: "https://tunnel.example.test/",
    });
    try {
      // Trailing slash trimmed, so `${origin}/mcp` never doubles it.
      expect(server.origin).toBe("https://tunnel.example.test");
      expect(server.mcpUrl).toBe("https://tunnel.example.test/mcp");
      expect(server.scenario.capabilities.prmResource).toBe(
        "https://tunnel.example.test/mcp",
      );
    } finally {
      await server.close();
    }
  });

  it("rejects instead of hanging when the port is already taken", async () => {
    // `listen` reports a bind failure by emitting `error`, never by calling its
    // callback, so awaiting only the callback left this pending forever.
    const squatter = createServer();
    await new Promise<void>((resolve) => {
      squatter.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = squatter.address() as AddressInfo;

    try {
      await expect(
        startCaptureServer({ port, host: "127.0.0.1" }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("brackets an IPv6 bind host so its own origin is parseable", async () => {
    // `new URL("http://::1:3999")` throws, and this origin is the base for every
    // inbound `new URL(request.url, bindOrigin)` — so an unbracketed literal
    // fails the capture on the first request rather than degrading.
    let server: Awaited<ReturnType<typeof startCaptureServer>>;
    try {
      server = await startCaptureServer({ host: "::1" });
    } catch {
      // Some sandboxes have no IPv6 loopback at all. The bracketing itself is
      // still asserted by the URL round-trip below on the hosts we can bind.
      return;
    }
    try {
      expect(server.origin).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect(() => new URL("/mcp", server.origin)).not.toThrow();
      // And it actually serves: the 401 challenge is the first leg of the dance.
      const response = await fetch(server.mcpUrl, { method: "POST", body: "{}" });
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
