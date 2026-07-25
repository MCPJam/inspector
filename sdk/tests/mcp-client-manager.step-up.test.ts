import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsufficientScopeError } from "@modelcontextprotocol/client";

// Capture the options every StreamableHTTPClientTransport is constructed with,
// while delegating to the real upstream class so connect still behaves.
const capturedStreamableOpts: Array<Record<string, unknown>> = [];
// When set, the spy Streamable transport's `start()` throws this instead of
// delegating to the real (network) implementation — lets a test simulate a
// connect-time `403 insufficient_scope` deterministically.
let streamableStartError: unknown = undefined;
// Count SSE transport constructions so a test can assert the manager did NOT
// fall back to SSE.
let sseConstructedCount = 0;

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@modelcontextprotocol/client")>();
  class SpyStreamableHTTPClientTransport extends actual.StreamableHTTPClientTransport {
    constructor(url: URL, opts?: Record<string, unknown>) {
      super(url, opts as never);
      capturedStreamableOpts.push({ ...(opts ?? {}) });
    }
    async start(): Promise<void> {
      if (streamableStartError !== undefined) {
        throw streamableStartError;
      }
      return super.start();
    }
  }
  class SpySSEClientTransport extends actual.SSEClientTransport {
    constructor(url: URL, opts?: Record<string, unknown>) {
      super(url, opts as never);
      sseConstructedCount += 1;
    }
  }
  return {
    ...actual,
    StreamableHTTPClientTransport: SpyStreamableHTTPClientTransport,
    SSEClientTransport: SpySSEClientTransport,
  };
});

// Import AFTER the mock is registered so the manager binds the spy subclass.
const { MCPClientManager } = await import("../src/mcp-client-manager");

describe("MCPClientManager step-up transport wiring (SEP-2350)", () => {
  beforeEach(() => {
    capturedStreamableOpts.length = 0;
    streamableStartError = undefined;
    sseConstructedCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs the Streamable HTTP transport with onInsufficientScope: "throw"', async () => {
    const manager = new MCPClientManager();
    // Unreachable URL — connect fails, but the transport is CONSTRUCTED first,
    // so its options are captured regardless of the connect outcome.
    await manager
      .connectToServer("step-up-server", {
        url: "http://127.0.0.1:1/mcp",
      })
      .catch(() => {});

    expect(capturedStreamableOpts.length).toBeGreaterThan(0);
    // Every Streamable HTTP transport this manager builds must gate step-up to
    // "throw" — MCPJam drives interactive re-authorization on the client, so
    // the server-side transport must surface a clean InsufficientScopeError
    // (never attempt a doomed interactive reauthorize).
    for (const opts of capturedStreamableOpts) {
      expect(opts.onInsufficientScope).toBe("throw");
    }
  });

  it("rethrows a connect-time InsufficientScopeError without falling back to SSE", async () => {
    // Simulate the transport throwing a clean `403 insufficient_scope`
    // challenge during connect (what `onInsufficientScope: "throw"` produces).
    const challenge = new InsufficientScopeError({
      requiredScope: "read write admin",
      resourceMetadataUrl:
        "https://rs.example/.well-known/oauth-protected-resource",
    });
    streamableStartError = challenge;

    const manager = new MCPClientManager();
    const rejection = await manager
      .connectToServer("step-up-server", { url: "https://rs.example/mcp" })
      .then(
        () => {
          throw new Error("expected connectToServer to reject");
        },
        (error) => error,
      );

    // The SAME instance is rethrown — brand + challenge fields intact, never
    // downgraded to MCPAuthError (which would strip requiredScope /
    // resourceMetadataUrl and mislead the client into a plain token refresh).
    expect(rejection).toBe(challenge);
    expect(rejection).toBeInstanceOf(InsufficientScopeError);
    expect(rejection.name).not.toBe("MCPAuthError");
    expect((rejection as InsufficientScopeError).requiredScope).toBe(
      "read write admin",
    );
    // SSE cannot repair scope, so the fallback must be skipped entirely.
    expect(sseConstructedCount).toBe(0);
  });
});
