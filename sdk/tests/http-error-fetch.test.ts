import { describe, expect, it, vi } from "vitest";
import {
  SdkHttpError,
  SdkErrorCode,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { wrapFetchForHttpErrors } from "../src/mcp-client-manager/http-error-fetch.js";

const url = new URL("https://example.test/mcp");
const challenge =
  'Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource/mcp", scope_mode="disabled"';

function transportFor(fetchFn: typeof fetch) {
  return new StreamableHTTPClientTransport(url, {
    fetch: wrapFetchForHttpErrors(fetchFn, false),
  });
}

const request = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name: "ProtectedTool", arguments: {} },
};

describe("Streamable HTTP error diagnostics", () => {
  it("surfaces the status and challenge for an empty 401 through the transport", async () => {
    const transport = transportFor(
      vi.fn(
        async () =>
          new Response(null, {
            status: 401,
            statusText: "Unauthorized",
            headers: { "WWW-Authenticate": challenge },
          })
      ) as typeof fetch
    );

    const error = await transport.send(request).catch((error) => error);
    expect(error).toBeInstanceOf(SdkHttpError);
    expect(error.status).toBe(401);
    expect(error.statusText).toBe("Unauthorized");
    expect(error.code).toBe(SdkErrorCode.ClientHttpNotImplemented);
    expect(error.data).toMatchObject({ status: 401, text: "" });
    expect(error.message).toContain("HTTP 401 Unauthorized");
    expect(error.message).toContain("(empty body)");
    expect(error.message).toContain(`WWW-Authenticate: ${challenge}`);
  });

  it("preserves a non-empty response body even without a reason phrase", async () => {
    const transport = transportFor(
      vi.fn(
        async () => new Response('{"error":"invalid_token"}', { status: 401 })
      ) as typeof fetch
    );
    await expect(transport.send(request)).rejects.toThrow(
      'Error POSTing to endpoint (HTTP 401): {"error":"invalid_token"}'
    );
  });

  it("preserves network errors without adding an HTTP status", async () => {
    const error = new TypeError("fetch failed", {
      cause: new Error("ECONNREFUSED"),
    });
    const transport = transportFor(
      vi.fn(async () => {
        throw error;
      }) as typeof fetch
    );
    await expect(transport.send(request)).rejects.toBe(error);
  });

  it("delivers successful tool results unchanged", async () => {
    const result = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "hello" }] },
    };
    const transport = transportFor(
      vi.fn(async () => Response.json(result)) as typeof fetch
    );
    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    await transport.send(request);
    expect(onmessage.mock.calls[0][0]).toEqual(result);
  });

  it.each([401, 403])(
    "leaves %s responses intact for the auth provider",
    async (status) => {
      const response = new Response("auth response", {
        status,
        headers: { "WWW-Authenticate": challenge },
      });
      const wrapped = wrapFetchForHttpErrors(
        vi.fn(async () => response) as typeof fetch,
        true
      );
      expect(
        await wrapped(url, { method: "POST", body: JSON.stringify(request) })
      ).toBe(response);
      expect(response.bodyUsed).toBe(false);
      expect(response.headers.get("www-authenticate")).toBe(challenge);
    }
  );

  it("leaves the optional GET listen stream response intact", async () => {
    const response = new Response(null, { status: 405 });
    const wrapped = wrapFetchForHttpErrors(
      vi.fn(async () => response) as typeof fetch,
      false
    );
    expect(await wrapped(url, { method: "GET" })).toBe(response);
  });

  it("still reports non-auth HTTP failures when an auth provider exists", async () => {
    const wrapped = wrapFetchForHttpErrors(
      vi.fn(
        async () =>
          new Response("unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          })
      ) as typeof fetch,
      true
    );
    await expect(
      wrapped(url, { method: "POST", body: JSON.stringify(request) })
    ).rejects.toThrow("HTTP 503 Service Unavailable");
  });

  it("leaves version negotiation responses intact", async () => {
    const response = new Response(null, { status: 401 });
    const wrapped = wrapFetchForHttpErrors(
      vi.fn(async () => response) as typeof fetch,
      false
    );
    expect(
      await wrapped(url, {
        method: "POST",
        body: JSON.stringify({ ...request, method: "initialize" }),
      })
    ).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it("dispatches modern JSON-RPC errors carried by HTTP 400", async () => {
    const error = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Invalid arguments" },
    };
    const transport = transportFor(
      vi.fn(async () => Response.json(error, { status: 400 })) as typeof fetch
    );
    transport.setProtocolVersion("2026-07-28");
    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    await transport.send({
      ...request,
      params: {
        ...request.params,
        _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" },
      },
    });
    expect(onmessage.mock.calls[0][0]).toEqual(error);
  });
});
