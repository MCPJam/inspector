import { describe, expect, it } from "vitest";
import {
  inspectorRedactionMiddleware,
  maskSecrets,
  redactCookie,
  redactRequest,
  redactResponse,
  redactStorageEntry,
  redactWebSocket,
} from "../meticulous-middleware";

const json = (body: unknown) => ({
  mimeType: "application/json",
  text: JSON.stringify(body),
});

describe("inspectorRedactionMiddleware", () => {
  it("installs itself on the recorder's middleware global", () => {
    expect(window.METICULOUS_RECORDER_MIDDLEWARE_V1).toContain(
      inspectorRedactionMiddleware,
    );
  });

  it("passes streamed responses through unchanged", () => {
    const entry = { url: "/api/mcp/chat-v2", chunks: [{ data: "aGk=" }] };
    expect(
      inspectorRedactionMiddleware.transformStreamingFetchResponseData(entry),
    ).toBe(entry);
    expect(
      inspectorRedactionMiddleware.transformStreamingXhrResponseData(entry),
    ).toBe(entry);
  });
});

describe("redactRequest", () => {
  it("masks the session bearer and keeps other headers", () => {
    const bearer = "Bearer eyJhbGci.payload.sig";
    const request = {
      url: "https://staging.mcpjam.com/api/mcp/servers",
      method: "GET",
      headers: [
        { name: "Authorization", value: bearer },
        { name: "Accept", value: "application/json" },
      ],
    };
    const redacted = redactRequest(request);
    expect(redacted.headers).toEqual([
      { name: "Authorization", value: "*".repeat(bearer.length) },
      { name: "Accept", value: "application/json" },
    ]);
  });

  it("masks MCP server credentials in a connect body but keeps its shape", () => {
    const request = {
      url: "https://staging.mcpjam.com/api/mcp/connect",
      method: "POST",
      headers: [],
      postData: json({
        name: "github",
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer ghp_abc" },
        env: { OPENAI_API_KEY: "sk-live" },
        secretPatch: { headers: { "X-Custom": "v" } },
      }),
    };
    expect(JSON.parse(redactRequest(request).postData.text)).toEqual({
      name: "github",
      url: "https://mcp.example.com",
      headers: { Authorization: "**************" },
      env: { OPENAI_API_KEY: "*******" },
      secretPatch: { headers: { "X-Custom": "*" } },
    });
  });

  it("masks imported OAuth tokens", () => {
    const request = {
      url: "https://staging.mcpjam.com/api/web/oauth/import-tokens",
      method: "POST",
      headers: [],
      postData: json({
        serverName: "linear",
        tokens: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      }),
    };
    expect(JSON.parse(redactRequest(request).postData.text)).toEqual({
      serverName: "linear",
      tokens: { access_token: "**", refresh_token: "**", expires_in: 3600 },
    });
  });

  it("masks a form-encoded token exchange, including the one-time code", () => {
    const request = {
      url: "https://auth.example.com/token",
      method: "POST",
      headers: [],
      postData: {
        mimeType: "application/x-www-form-urlencoded",
        text: "grant_type=authorization_code&code=abc&code_verifier=v1&client_id=pub",
      },
    };
    expect(redactRequest(request).postData.text).toBe(
      "grant_type=authorization_code&code=***&code_verifier=**&client_id=pub",
    );
  });

  it("masks secret query parameters", () => {
    const request = {
      url: "https://example.com/cb?state=s&token=t0k",
      method: "GET",
      headers: [],
    };
    expect(redactRequest(request).url).toBe(
      "https://example.com/cb?state=s&token=***",
    );
  });

  it("treats a text/plain JSON body as JSON", () => {
    const request = {
      url: "https://example.com",
      method: "POST",
      headers: [],
      postData: { mimeType: "text/plain", text: '{"apiKey":"k"}' },
    };
    expect(redactRequest(request).postData.text).toBe('{"apiKey":"*"}');
  });

  it("returns the same object when nothing is secret", () => {
    const request = {
      url: "https://example.com/api",
      method: "POST",
      headers: [{ name: "Accept", value: "*/*" }],
      postData: json({ name: "x", code: "NOT_FOUND" }),
    };
    expect(redactRequest(request)).toBe(request);
  });

  it("leaves a non-JSON body that claims to be JSON alone", () => {
    const request = {
      url: "https://example.com/api",
      method: "POST",
      headers: [],
      postData: { mimeType: "application/json", text: "not json" },
    };
    expect(redactRequest(request).postData.text).toBe("not json");
  });
});

describe("redactResponse", () => {
  it("masks tokens in JSON bodies and set-cookie headers, and skips binary", () => {
    const response = {
      status: 200,
      headers: [{ name: "set-cookie", value: "sid=1; HttpOnly" }],
      content: json({ access_token: "at", scope: "read" }),
    };
    const redacted = redactResponse(response);
    expect(redacted.headers[0].value).toBe("*".repeat(15));
    expect(JSON.parse(redacted.content.text)).toEqual({
      access_token: "**",
      scope: "read",
    });
    const binary = {
      status: 200,
      headers: [],
      content: { mimeType: "image/png", text: "e30=", encoding: "base64" },
    };
    expect(redactResponse(binary)).toBe(binary);
  });
});

describe("redactWebSocket", () => {
  it("masks the Convex authenticate token and leaves binary frames", () => {
    const connection = {
      url: "wss://x.convex.cloud/api/sync",
      events: [
        { type: "opened" },
        {
          type: "message-sent",
          data: '{"type":"Authenticate","token":"jwt","tokenType":"User"}',
        },
        {
          type: "message-received",
          data: { binaryType: "blob", encodedData: "AA" },
        },
      ],
    };
    const redacted = redactWebSocket(connection);
    expect(redacted.events[1].data).toBe(
      '{"type":"Authenticate","token":"***","tokenType":"User"}',
    );
    expect(redacted.events[2]).toBe(connection.events[2]);
  });
});

describe("redactStorageEntry", () => {
  it("masks PKCE verifiers whole and secrets inside JSON values", () => {
    expect(redactStorageEntry({ key: "mcp-verifier-s", value: "v" })).toEqual({
      key: "mcp-verifier-s",
      value: "*",
    });
    expect(
      redactStorageEntry({
        key: "mcp-client-s",
        value: '{"client_id":"id","client_secret":"sec"}',
      }).value,
    ).toBe('{"client_id":"id","client_secret":"***"}');
    const plain = { key: "mcp-serverUrl-s", value: "https://x" };
    expect(redactStorageEntry(plain)).toBe(plain);
  });
});

describe("redactCookie and maskSecrets", () => {
  it("masks cookies by name and nested secrets by key", () => {
    expect(redactCookie({ name: "ph_session", value: "abc" }).value).toBe(
      "***",
    );
    expect(redactCookie({ name: "theme", value: "dark" }).value).toBe("dark");
    expect(maskSecrets({ a: [{ accessToken: "x", n: 1 }] })).toEqual({
      a: [{ accessToken: "*", n: 1 }],
    });
  });
});
