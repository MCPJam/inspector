import { describe, expect, it } from "vitest";
import { PROBE_VALUE_KEYS } from "../../server-features/probe-value-keys.js";
import { MAX_SERVER_CARD_DOCUMENT_BYTES, probeServerCard } from "../probe.js";
import {
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_SCHEMA_URL,
  serverCardMatchesRuntime,
  validateServerCard,
} from "../validate.js";

const VALID_CARD = {
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  version: "1.2.0",
  description: "Weather forecasts.",
  title: "Weather",
  websiteUrl: "https://example.com",
  remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
  _meta: { "com.example/tier": "free" },
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
}

type Route = (url: string) => Response | Error | undefined;

function recordingFetch(route: Route) {
  const calls: Recorded[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, method: init?.method ?? "GET", headers });
    const answer = route(url);
    if (answer instanceof Error) throw answer;
    return answer ?? new Response("not found", { status: 404 });
  };
  return { fetchFn, calls };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("validateServerCard", () => {
  it("accepts a complete card and lists its optional fields", () => {
    expect(validateServerCard(VALID_CARD)).toEqual({
      isObject: true,
      requiredFieldsOk: true,
      missingFields: [],
      optionalFields: ["title", "websiteUrl"],
      remotesListed: true,
      hasMeta: true,
    });
  });

  it("names missing required fields and rejects invalid ones", () => {
    const { $schema: _schema, ...withoutSchema } = VALID_CARD;
    const missing = validateServerCard({ ...withoutSchema, version: undefined });
    expect(missing.requiredFieldsOk).toBe(false);
    expect(missing.missingFields).toEqual(["$schema", "version"]);
    for (const invalid of [
      { name: "weather" },
      { version: "^1.2.0" },
      { version: "1.x" },
      { description: "x".repeat(101) },
      { $schema: "https://example.com/schema.json" },
    ]) {
      const result = validateServerCard({ ...VALID_CARD, ...invalid });
      expect(result.requiredFieldsOk).toBe(false);
      expect(result.missingFields).toEqual([]);
    }
  });

  it("compares the card with what the server reported", () => {
    const runtime = {
      serverInfo: { name: "weather", version: "1.2.0" },
      transport: "streamable-http" as const,
      serverUrl: "https://example.com/mcp/",
    };
    expect(serverCardMatchesRuntime(VALID_CARD, runtime)).toBe(true);
    expect(
      serverCardMatchesRuntime(VALID_CARD, {
        ...runtime,
        serverInfo: { version: "2.0.0" },
      }),
    ).toBe(false);
    expect(
      serverCardMatchesRuntime(VALID_CARD, { ...runtime, transport: "sse" }),
    ).toBe(false);
    expect(serverCardMatchesRuntime(VALID_CARD, undefined)).toBeNull();
    expect(
      serverCardMatchesRuntime({ ...VALID_CARD, version: 3, remotes: [] }, {
        serverInfo: { version: "1" },
      }),
    ).toBeNull();
  });
});

describe("probeServerCard", () => {
  it("finds the card through the AI Catalog and grades the catalog response", async () => {
    const { fetchFn, calls } = recordingFetch((url) =>
      url === "https://example.com/.well-known/ai-catalog.json"
        ? json(
            {
              specVersion: "1.0",
              entries: [
                {
                  identifier: "urn:air:example.com:mcp:weather",
                  type: SERVER_CARD_MEDIA_TYPE,
                  url: "https://example.com/mcp/server-card",
                },
              ],
            },
            { "access-control-allow-origin": "*" },
          )
        : url === "https://example.com/mcp/server-card"
          ? json(VALID_CARD, {
              "content-type": SERVER_CARD_MEDIA_TYPE,
              "access-control-allow-origin": "*",
              "cache-control": "public, max-age=3600",
            })
          : undefined,
    );
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      runtime: { serverInfo: { version: "1.2.0" }, transport: "streamable-http" },
      fetchFn,
      now: () => 42,
    });
    expect(summary).toEqual({
      probeId: "server-card",
      status: "ok",
      coverage: "complete",
      at: 42,
      values: {
        aiCatalogFound: true,
        catalogEntryFound: true,
        serverCardFound: true,
        serverCardUrl: "https://example.com/mcp/server-card",
        mediaTypeOk: true,
        requiredFieldsOk: true,
        missingFields: [],
        optionalFields: ["title", "websiteUrl"],
        remotesListed: true,
        hasMeta: true,
        consistentWithRuntime: true,
        corsAllowed: true,
        cacheControl: true,
        https: true,
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/.well-known/ai-catalog.json",
      "https://example.com/mcp/server-card",
    ]);
  });

  it("falls back to the hosted card and never sends the configured URL's secrets", async () => {
    const { fetchFn, calls } = recordingFetch((url) =>
      url === "http://example.com/mcp/server-card"
        ? json({ ...VALID_CARD, _meta: undefined })
        : undefined,
    );
    const summary = await probeServerCard({
      serverUrl: "http://user:pass@example.com/mcp/?api_key=secret-value#frag",
      fetchFn,
    });
    expect(summary.values).toMatchObject({
      aiCatalogFound: false,
      serverCardFound: true,
      serverCardUrl: "http://example.com/mcp/server-card",
      mediaTypeOk: false,
      hasMeta: false,
      corsAllowed: false,
      cacheControl: false,
      https: false,
    });
    expect(summary.values.catalogEntryFound).toBeUndefined();
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.url).not.toContain("secret-value");
      expect(call.url).not.toContain("pass");
      expect(Object.keys(call.headers)).toEqual(["accept"]);
    }
    expect(JSON.stringify(summary)).not.toContain("secret-value");
  });

  it("never dials a card URL the catalog points at a private address", async () => {
    const { fetchFn, calls } = recordingFetch((url) =>
      url === "https://example.com/.well-known/ai-catalog.json"
        ? json({
            entries: [
              {
                type: SERVER_CARD_MEDIA_TYPE,
                url: "http://169.254.169.254/latest/meta-data",
              },
              { type: SERVER_CARD_MEDIA_TYPE, url: "https://10.0.0.5/card" },
            ],
          })
        : undefined,
    );
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/.well-known/ai-catalog.json",
      "https://example.com/mcp/server-card",
    ]);
    expect(summary.values).toMatchObject({
      aiCatalogFound: true,
      catalogEntryFound: false,
      serverCardFound: false,
      serverCardUrl: null,
    });
    expect(summary.coverage).toBe("partial");
  });

  it("discards the response from a redirect that landed on a private address", async () => {
    const route = (url: string) => {
      if (url !== "https://example.com/mcp/server-card") return undefined;
      const response = json(VALID_CARD, {
        "content-type": SERVER_CARD_MEDIA_TYPE,
      });
      Object.defineProperty(response, "url", { value: "https://10.0.0.7/card" });
      return response;
    };

    const refused = recordingFetch(route);
    const withoutOptIn = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn: refused.fetchFn,
    });
    expect(refused.calls.map((call) => call.url)).toEqual([
      "https://example.com/.well-known/ai-catalog.json",
      "https://example.com/mcp/server-card",
    ]);
    expect(withoutOptIn).toMatchObject({
      status: "ok",
      coverage: "partial",
      values: { serverCardFound: false, serverCardUrl: null },
    });

    const kept = recordingFetch(route);
    const withOptIn = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn: kept.fetchFn,
      allowPrivateNetwork: true,
    });
    expect(withOptIn).toMatchObject({
      status: "ok",
      coverage: "complete",
      values: {
        serverCardFound: true,
        serverCardUrl: "https://10.0.0.7/card",
        requiredFieldsOk: true,
      },
    });
  });

  it("reads an inline card from the catalog when it names this endpoint", async () => {
    const { fetchFn } = recordingFetch((url) =>
      url === "https://example.com/.well-known/ai-catalog.json"
        ? json({ entries: [{ type: SERVER_CARD_MEDIA_TYPE, data: VALID_CARD }] })
        : undefined,
    );
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn,
    });
    expect(summary.values).toMatchObject({
      catalogEntryFound: true,
      serverCardFound: true,
      serverCardUrl: "https://example.com/.well-known/ai-catalog.json",
      mediaTypeOk: true,
    });
  });

  it("dials a catalog-named card only on the server's own origin", async () => {
    const { fetchFn, calls } = recordingFetch((url) =>
      url === "https://example.com/.well-known/ai-catalog.json"
        ? json({
            entries: [
              { type: SERVER_CARD_MEDIA_TYPE, url: "http://127.0.0.1:8080/card" },
              { type: SERVER_CARD_MEDIA_TYPE, url: "https://cards.example.net/w" },
              { type: SERVER_CARD_MEDIA_TYPE, url: "http://example.com/card" },
            ],
          })
        : undefined,
    );
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn,
      allowPrivateNetwork: true,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/.well-known/ai-catalog.json",
      "https://example.com/mcp/server-card",
    ]);
    expect(summary.coverage).toBe("partial");
  });

  it("counts only 2xx as found and 404, 405 or 410 as settled", async () => {
    for (const [catalogStatus, cardStatus] of [
      [410, 404],
      [405, 405],
    ]) {
      const settled = recordingFetch((url) =>
        url.endsWith("/ai-catalog.json")
          ? new Response("gone", { status: catalogStatus })
          : new Response("not here", { status: cardStatus }),
      );
      const none = await probeServerCard({
        serverUrl: "https://example.com/mcp",
        fetchFn: settled.fetchFn,
      });
      expect(none).toMatchObject({
        status: "ok",
        coverage: "complete",
        values: { aiCatalogFound: false, serverCardFound: false },
      });
    }

    for (const status of [500, 503, 429, 403]) {
      const { fetchFn } = recordingFetch((url) =>
        url.endsWith("/ai-catalog.json")
          ? new Response("busy", { status })
          : new Response("not found", { status: 404 }),
      );
      const summary = await probeServerCard({
        serverUrl: "https://example.com/mcp",
        fetchFn,
      });
      expect(summary.status).toBe("ok");
      expect(summary.coverage).toBe("partial");
      expect(summary.values.aiCatalogFound).toBeUndefined();
    }

    const failing = recordingFetch(() => new Response("down", { status: 502 }));
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn: failing.fetchFn,
    });
    expect(summary).toMatchObject({ status: "failed", coverage: "not-captured" });
    expect(summary.values.serverCardFound).toBeUndefined();
  });

  it("stops reading a document at the size cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const { fetchFn } = recordingFetch((url) =>
      url.endsWith("/ai-catalog.json") ? endless() : undefined,
    );
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn,
    });
    expect(pulled).toBeLessThanOrEqual(6);
    expect(summary.coverage).toBe("partial");
    expect(summary.values.aiCatalogFound).toBeUndefined();
  });

  it("cancels every body it does not read", async () => {
    const cancelled: string[] = [];
    const tracked = (name: string, init: ResponseInit, landedAt?: string) => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          },
          cancel() {
            cancelled.push(name);
          },
        }),
        init,
      );
      if (landedAt) Object.defineProperty(response, "url", { value: landedAt });
      return response;
    };

    const oversize = recordingFetch((url) =>
      url.endsWith("/ai-catalog.json")
        ? tracked("catalog over the cap", {
            status: 200,
            headers: {
              "content-length": String(MAX_SERVER_CARD_DOCUMENT_BYTES + 1),
            },
          })
        : tracked("hosted card 404", { status: 404 }),
    );
    await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn: oversize.fetchFn,
    });
    expect(cancelled).toEqual(["catalog over the cap", "hosted card 404"]);

    cancelled.length = 0;
    const refused = recordingFetch((url) =>
      url.endsWith("/ai-catalog.json")
        ? tracked("catalog 503", { status: 503 })
        : tracked("private landing", { status: 200 }, "https://10.0.0.7/card"),
    );
    await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn: refused.fetchFn,
    });
    expect(cancelled).toEqual(["catalog 503", "private landing"]);
  });

  it("sends nothing when the signal has already fired", async () => {
    const { fetchFn, calls } = recordingFetch(() => json(VALID_CARD));
    const controller = new AbortController();
    controller.abort();
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn,
      signal: controller.signal,
    });
    expect(calls).toEqual([]);
    expect(summary).toMatchObject({
      status: "abandoned",
      coverage: "not-captured",
      values: {},
    });
  });

  it("returns at the request in flight when the signal fires mid-probe", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/ai-catalog.json")) {
        return json({
          entries: [
            { type: SERVER_CARD_MEDIA_TYPE, url: "https://example.com/cards/a" },
            { type: SERVER_CARD_MEDIA_TYPE, url: "https://example.com/cards/b" },
          ],
        });
      }
      // The first card request hangs until the caller cancels it.
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        queueMicrotask(() => controller.abort());
      });
    };
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn,
      signal: controller.signal,
    });
    expect(calls).toEqual([
      "https://example.com/.well-known/ai-catalog.json",
      "https://example.com/cards/a",
    ]);
    expect(summary).toMatchObject({
      status: "abandoned",
      coverage: "not-captured",
      values: {},
    });
  });

  it("fails when nothing answers and keeps only contract keys", async () => {
    const { fetchFn } = recordingFetch(() => new Error("ECONNREFUSED"));
    const summary = await probeServerCard({
      serverUrl: "https://example.com/mcp",
      fetchFn,
    });
    expect(summary.status).toBe("failed");
    expect(summary.coverage).toBe("not-captured");
    const allowed: readonly string[] = PROBE_VALUE_KEYS["server-card"];
    for (const key of Object.keys(summary.values)) {
      expect(allowed).toContain(key);
    }
    expect(
      (await probeServerCard({ serverUrl: "stdio://server", fetchFn })).status,
    ).toBe("failed");
  });
});
