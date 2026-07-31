import {
  collectRedirectUris,
  parseTraceBody,
} from "../../src/oauth-golden-trace/index.js";

describe("parseTraceBody — form bodies", () => {
  it("reads a URLSearchParams token body instead of seeing an empty form", () => {
    // `URLSearchParams` exposes no enumerable own properties, so an object walk
    // reports `{}` and the token leg loses exactly the fields HP-44 exists to
    // compare: grant, resource, PKCE.
    const raw = new URLSearchParams({
      grant_type: "authorization_code",
      code_verifier: "v".repeat(43),
      resource: "https://a.test/mcp",
    });
    expect(
      parseTraceBody(raw, {
        "content-type": "application/x-www-form-urlencoded",
      }),
    ).toEqual({
      encoding: "form",
      fields: {
        grant_type: ["authorization_code"],
        code_verifier: ["v".repeat(43)],
        resource: ["https://a.test/mcp"],
      },
    });
  });

  it("treats URLSearchParams as a form body even with no content-type", () => {
    // The type is itself proof of form encoding; a missing header cannot make it
    // anything else.
    expect(parseTraceBody(new URLSearchParams("grant_type=refresh_token"))).toEqual({
      encoding: "form",
      fields: { grant_type: ["refresh_token"] },
    });
  });

  it("keeps repeated keys in a URLSearchParams body", () => {
    const raw = new URLSearchParams();
    raw.append("resource", "https://a.test/mcp");
    raw.append("resource", "https://b.test/mcp");
    expect(parseTraceBody(raw)).toEqual({
      encoding: "form",
      fields: { resource: ["https://a.test/mcp", "https://b.test/mcp"] },
    });
  });
});

describe("parseTraceBody — opaque byteLength", () => {
  it("counts wire bytes, not UTF-16 code units", () => {
    // "é" is one code unit but two UTF-8 bytes; the HAR path fills this field
    // from `content.size`, so the two capture paths must agree.
    const body = parseTraceBody("<p>café</p>", { "content-type": "text/html" });
    expect(body).toEqual({
      encoding: "opaque",
      contentType: "text/html",
      byteLength: 12,
    });
  });

  it("uses the same byte count for a truncated JSON body", () => {
    // Same rule on the JSON.parse failure path, which has its own return.
    const body = parseTraceBody('{"client_name":"café"', {
      "content-type": "application/json",
    });
    expect(body).toEqual({
      encoding: "opaque",
      contentType: "application/json",
      byteLength: 22,
    });
  });

  it("counts astral-plane characters as their UTF-8 byte length", () => {
    const body = parseTraceBody("\u{1F510} consent", { "content-type": "text/html" });
    // 4 bytes for the surrogate pair + 8 for " consent".
    expect(body).toEqual({
      encoding: "opaque",
      contentType: "text/html",
      byteLength: 12,
    });
  });
});

describe("parseTraceBody — JSON-RPC batches", () => {
  it("classifies a batch of envelopes as jsonrpc with no hoisted method", () => {
    // A batch (legal through 2025-03-26) has no single `method`, so leaving it
    // absent is honest; `observe` falls back to other leg signals.
    const body = parseTraceBody(
      '[{"jsonrpc":"2.0","id":1,"method":"tools/list"},' +
        '{"jsonrpc":"2.0","id":2,"method":"resources/list"}]',
    );
    expect(body).toEqual({
      encoding: "jsonrpc",
      json: [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "resources/list" },
      ],
    });
    expect(body && "method" in body).toBe(false);
  });

  it("keeps an empty array as plain json, since it is not a legal batch", () => {
    expect(parseTraceBody("[]")).toEqual({ encoding: "json", json: [] });
  });

  it("keeps a mixed array as plain json rather than claiming the protocol", () => {
    expect(
      parseTraceBody('[{"jsonrpc":"2.0","method":"tools/list"},{"hello":"world"}]'),
    ).toEqual({
      encoding: "json",
      json: [{ jsonrpc: "2.0", method: "tools/list" }, { hello: "world" }],
    });
  });

  it("still hoists the method of a single envelope", () => {
    expect(parseTraceBody('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toEqual({
      encoding: "jsonrpc",
      method: "initialize",
      json: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
  });
});

describe("collectRedirectUris", () => {
  it("reads the plural redirect_uris from a form-encoded DCR body", () => {
    // A DCR payload sent form-encoded otherwise contributes no ports, and the
    // `{port}` placeholder then destroys the evidence.
    expect(
      collectRedirectUris({
        url: "{as}/register",
        body: {
          encoding: "form",
          fields: {
            redirect_uris: [
              "http://127.0.0.1:54321/callback",
              "http://localhost:54321/callback",
            ],
          },
        },
      }),
    ).toEqual([
      "http://127.0.0.1:54321/callback",
      "http://localhost:54321/callback",
    ]);
  });

  it("collects both the singular and plural form fields", () => {
    expect(
      collectRedirectUris({
        url: "{as}/register",
        body: {
          encoding: "form",
          fields: {
            redirect_uri: ["http://127.0.0.1:1111/callback"],
            redirect_uris: ["http://127.0.0.1:2222/callback"],
          },
        },
      }),
    ).toEqual([
      "http://127.0.0.1:1111/callback",
      "http://127.0.0.1:2222/callback",
    ]);
  });

  it("still reads redirect_uris from a JSON body and redirect_uri from the query", () => {
    expect(
      collectRedirectUris({
        url: "https://as.example.test/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A3333%2Fcallback",
        body: {
          encoding: "json",
          json: { redirect_uris: ["http://127.0.0.1:4444/callback"] },
        },
      }),
    ).toEqual([
      "http://127.0.0.1:4444/callback",
      "http://127.0.0.1:3333/callback",
    ]);
  });
});
