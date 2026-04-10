import {
  mergeHeaders,
  mergeHeadersForAuthServer,
  mergeHeadersForResourceMetadataRequest,
} from "../../src/oauth/state-machines/shared/headers.js";

describe("mergeHeaders", () => {
  it("returns request headers overriding custom headers", () => {
    const result = mergeHeaders(
      { "X-Custom": "custom-value", Accept: "text/html" },
      { Accept: "application/json" },
    );

    expect(result).toEqual({
      "X-Custom": "custom-value",
      Accept: "application/json",
    });
  });

  it("treats header names case-insensitively when request headers override custom headers", () => {
    const result = mergeHeaders(
      { authorization: "Bearer old-token" },
      { Authorization: "Bearer new-token" },
    );

    expect(
      Object.keys(result).filter(
        (key) => key.toLowerCase() === "authorization",
      ),
    ).toHaveLength(1);
    expect(result.Authorization).toBe("Bearer new-token");
  });
});

describe("mergeHeadersForAuthServer", () => {
  it("strips Authorization headers with any casing", () => {
    expect(
      mergeHeadersForAuthServer({
        Authorization: "Bearer secret",
        authORIZATION: "Bearer duplicate",
        "X-Custom": "keep",
      }),
    ).toEqual({
      "X-Custom": "keep",
    });
  });
});

describe("mergeHeadersForResourceMetadataRequest", () => {
  it("keeps Authorization for same-origin resource metadata requests", () => {
    expect(
      mergeHeadersForResourceMetadataRequest(
        "https://mcp-server.example.com/mcp",
        "/.well-known/oauth-protected-resource/mcp",
        { Authorization: "Bearer keep-me" },
        { "MCP-Protocol-Version": "2025-11-25" },
      ),
    ).toEqual({
      Authorization: "Bearer keep-me",
      "MCP-Protocol-Version": "2025-11-25",
    });
  });

  it("strips Authorization for cross-origin resource metadata requests", () => {
    expect(
      mergeHeadersForResourceMetadataRequest(
        "https://mcp-server.example.com/mcp",
        "https://metadata.example.com/.well-known/oauth-protected-resource/mcp",
        {
          Authorization: "Bearer strip-me",
          "X-Custom": "keep-me",
        },
        { "MCP-Protocol-Version": "2025-11-25" },
      ),
    ).toEqual({
      "X-Custom": "keep-me",
      "MCP-Protocol-Version": "2025-11-25",
    });
  });
});
