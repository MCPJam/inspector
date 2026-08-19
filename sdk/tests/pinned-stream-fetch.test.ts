/**
 * The streaming pinned transport, driven against REAL sockets.
 *
 * These are not mock tests on purpose. The property under test is what the
 * socket actually connects to, and the failure this transport exists to
 * prevent — a target answering `302 Location: http://169.254.169.254/` and
 * having that hop dialled — is invisible to a test that stubs the dial. So a
 * real `http.Server` on loopback plays the target, and the assertions are
 * about which requests it did and did not receive.
 *
 * Loopback is reachable here only because `allowLoopback: true` is passed;
 * every test that matters re-proves that the allowance belongs to the CHAIN
 * and does not extend to any other private range.
 */

import { getEventListeners } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createPinnedStreamingFetch } from "../src/oauth/pinned-stream-fetch.js";
import { OAuthProxyError } from "../src/oauth-proxy-error.js";

interface Recorded {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
}

const servers: http.Server[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ origin: string; received: Recorded[] }> {
  const received: Recorded[] = [];
  const server = http.createServer((req, res) => {
    received.push({
      url: req.url ?? "",
      method: req.method ?? "",
      headers: req.headers,
    });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, received };
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

function loopbackFetch(
  options: Parameters<typeof createPinnedStreamingFetch>[0] = {},
) {
  return createPinnedStreamingFetch({ allowLoopback: true, ...options });
}

describe("the happy path still behaves like fetch", () => {
  it("returns status, headers and a readable body", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const response = await loopbackFetch()(`${origin}/mcp`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("sends the method, headers and body it was given", async () => {
    const { origin, received } = await startServer((_req, res) => {
      res.writeHead(202);
      res.end();
    });

    await loopbackFetch()(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    });

    expect(received[0].method).toBe("POST");
    expect(received[0].headers.authorization).toBe("Bearer t");
  });

  it("reports the URL the chain ENDED at, not the one it started from", async () => {
    const target = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("done");
    });
    const { origin } = await startServer((_req, res) => {
      res.writeHead(302, { location: `${target.origin}/final` });
      res.end();
    });

    const response = await loopbackFetch()(`${origin}/start`);

    expect(response.url).toBe(`${target.origin}/final`);
  });
});

describe("streaming — the reason this transport exists", () => {
  it("delivers SSE events as they are written, without waiting for the end", async () => {
    let close: (() => void) | undefined;
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: first\n\n");
      // The second event is written only after the reader has consumed the
      // first — a buffering transport can never satisfy this ordering.
      close = () => {
        res.write("data: second\n\n");
        res.end();
      };
    });

    const response = await loopbackFetch()(`${origin}/sse`, {
      headers: { accept: "text/event-stream" },
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("data: first");

    close!();

    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toContain("data: second");
  });
});

describe("a redirect is re-validated at the hop that names it", () => {
  it("refuses a redirect to a link-local address and never dials it", async () => {
    const { origin, received } = await startServer((_req, res) => {
      res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" });
      res.end();
    });

    await expect(loopbackFetch()(`${origin}/start`)).rejects.toThrow(
      /private\/reserved/i,
    );
    // The target answered once; the metadata hop was refused before a socket
    // to it existed.
    expect(received).toHaveLength(1);
  });

  it("refuses a plaintext hop that is not loopback, even on a loopback chain", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
    });

    await expect(loopbackFetch()(`${origin}/start`)).rejects.toThrow(
      /plaintext connection/i,
    );
  });

  it("refuses a loopback TARGET outright without the opt-in", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    await expect(
      createPinnedStreamingFetch()(`${origin}/mcp`),
    ).rejects.toThrow(/loopback/i);
  });
});

describe("credentials do not cross an origin boundary", () => {
  it("drops Authorization when the redirect changes origin", async () => {
    const target = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const { origin } = await startServer((_req, res) => {
      res.writeHead(302, { location: `${target.origin}/final` });
      res.end();
    });

    await loopbackFetch()(`${origin}/start`, {
      headers: { authorization: "Bearer secret", cookie: "s=1" },
    });

    expect(target.received[0].headers.authorization).toBeUndefined();
    expect(target.received[0].headers.cookie).toBeUndefined();
  });

  it("keeps Authorization on a same-origin redirect", async () => {
    const { origin, received } = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });

    await loopbackFetch()(`${origin}/start`, {
      headers: { authorization: "Bearer secret" },
    });

    expect(received[1].headers.authorization).toBe("Bearer secret");
  });
});

describe("Fetch's method rewrite is reproduced exactly", () => {
  it("turns a POST into a GET on 303 and drops the body", async () => {
    const { origin, received } = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(303, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });

    await loopbackFetch()(`${origin}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(received[1].method).toBe("GET");
    expect(received[1].headers["content-type"]).toBeUndefined();
  });

  it("preserves the method on 307", async () => {
    const { origin, received } = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(307, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });

    await loopbackFetch()(`${origin}/start`, { method: "POST", body: "{}" });

    expect(received[1].method).toBe("POST");
  });
});

describe("the caller's redirect mode is honored", () => {
  it("hands back the 3xx itself under redirect: manual", async () => {
    const { origin, received } = await startServer((_req, res) => {
      res.writeHead(302, { location: "/final" });
      res.end();
    });

    const response = await loopbackFetch()(`${origin}/start`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/final");
    expect(received).toHaveLength(1);
  });

  it("fails the request under redirect: error", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(302, { location: "/final" });
      res.end();
    });

    await expect(
      loopbackFetch()(`${origin}/start`, { redirect: "error" }),
    ).rejects.toThrow(/redirect/i);
  });
});

describe("a method rewrite drops every body header", () => {
  it("strips content-language and content-location too", async () => {
    // Fetch's request-body-header list is all five, and `oauth-proxy.ts`'s
    // `updateRequestForRedirect` strips all five. Leaving two behind sends a
    // rewritten GET still claiming to describe a body it no longer carries.
    const { origin, received } = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(303, { location: "/done" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    await loopbackFetch()(`${origin}/start`, {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "content-language": "en",
        "content-location": "/local",
      },
    });

    const rewritten = received.at(-1)!;
    expect(rewritten.method).toBe("GET");
    expect(rewritten.headers["content-language"]).toBeUndefined();
    expect(rewritten.headers["content-location"]).toBeUndefined();
    expect(rewritten.headers["content-type"]).toBeUndefined();
  });
});

describe("resources it must not leak", () => {
  it("releases the caller's abort listener when the body is finished", async () => {
    // An MCP transport hands ONE connection-lifetime signal to every request
    // it makes. A listener left behind per request is a leak that warns at
    // eleven and grows for as long as the connection lives.
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const controller = new AbortController();
    const fetchFn = loopbackFetch();
    for (let i = 0; i < 12; i += 1) {
      const response = await fetchFn(`${origin}/rpc`, {
        signal: controller.signal,
      });
      await response.text();
    }

    // One listener would be ordinary; twelve is the leak.
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("releases it for a null-body status too", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    const controller = new AbortController();
    await loopbackFetch()(`${origin}/nothing`, { signal: controller.signal });

    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("releases it when the reader cancels a stream it never finished", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      // Left open: the caller walks away instead.
    });

    const controller = new AbortController();
    const response = await loopbackFetch()(`${origin}/sse`, {
      signal: controller.signal,
    });
    await response.body!.cancel();

    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("does not buffer a body the consumer has not read", async () => {
    // Without backpressure the data handler enqueues as fast as the socket
    // delivers, so the QUEUE decides how much is held rather than the reader.
    // A consumer that reads one chunk and pauses should leave the rest on the
    // socket.
    const chunk = Buffer.alloc(64 * 1024, 7);
    let written = 0;
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const pump = () => {
        // Write far more than any sane queue would hold.
        while (written < 200) {
          written += 1;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });

    const response = await loopbackFetch()(`${origin}/firehose`);
    const reader = response.body!.getReader();
    await reader.read();
    // Give the socket room to run away if nothing is holding it back.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const seen = written;
    await reader.cancel();

    // The exact number depends on socket buffers; the point is that it is
    // bounded rather than "all 200 chunks".
    expect(seen).toBeLessThan(200);
  });
});

describe("the bounds", () => {
  it("allows a chain as long as fetch itself does by default", async () => {
    // The ceiling exists to stop a loop, not to fail real infrastructure:
    // apex → www → CDN → tenant routing genuinely reaches six and seven hops,
    // and every hop is validated either way.
    let hop = 0;
    const { origin } = await startServer((_req, res) => {
      hop += 1;
      if (hop <= 7) {
        res.writeHead(302, { location: `/hop-${hop}` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ arrived: true }));
    });

    const response = await loopbackFetch()(`${origin}/start`);
    expect(response.status).toBe(200);
  });

  it("refuses a chain longer than the redirect ceiling", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });

    await expect(
      loopbackFetch({ maxRedirects: 2 })(`${origin}/start`),
    ).rejects.toThrow(/Too many redirects/i);
  });

  it("errors the body stream once the byte cap is passed", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(64 * 1024, 1));
      res.write(Buffer.alloc(64 * 1024, 1));
      res.end();
    });

    const response = await loopbackFetch({ maxResponseBytes: 1024 })(
      `${origin}/big`,
    );
    await expect(response.text()).rejects.toThrow(/byte cap/i);
  });

  it("counts the cap AFTER decompression, so a compressed bomb is measured honestly", async () => {
    const { gzipSync } = await import("node:zlib");
    // ~1 MiB of zeroes compresses to a couple of KiB; a cap applied to the
    // wire bytes would let it straight through.
    const payload = gzipSync(Buffer.alloc(1024 * 1024, 0));
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(payload);
    });

    const response = await loopbackFetch({ maxResponseBytes: 64 * 1024 })(
      `${origin}/bomb`,
      { headers: { "accept-encoding": "gzip" } },
    );
    await expect(response.text()).rejects.toThrow(/byte cap/i);
  });

  it("gives up on a target that never sends headers", async () => {
    const { origin } = await startServer(() => {
      // Accept the connection and answer nothing, ever.
    });

    await expect(
      loopbackFetch({ chainTimeoutMs: 150 })(`${origin}/hang`),
    ).rejects.toBeInstanceOf(OAuthProxyError);
  });

  it("does NOT put an established stream on the chain deadline", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      setTimeout(() => {
        res.write("data: still here\n\n");
        res.end();
      }, 250);
    });

    // The chain deadline is shorter than the stream's lifetime. A transport
    // that bounded the body with it would drop a conforming SSE server.
    const response = await loopbackFetch({ chainTimeoutMs: 100 })(`${origin}/sse`);
    await expect(response.text()).resolves.toContain("still here");
  });

  it("kills a stream that has stalled past the idle bound", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      // …and then nothing, forever.
    });

    const response = await loopbackFetch({ bodyIdleTimeoutMs: 150 })(
      `${origin}/sse`,
    );
    await expect(response.text()).rejects.toThrow(/no data/i);
  });
});

describe("request shapes it refuses rather than misrepresents", () => {
  it("refuses a Request carrying a body it could not replay across a redirect", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    const request = new Request(`${origin}/mcp`, {
      method: "POST",
      body: "payload",
    });
    await expect(loopbackFetch()(request)).rejects.toThrow(/cannot be dialled/i);
  });
});
