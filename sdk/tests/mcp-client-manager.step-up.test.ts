import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the options every StreamableHTTPClientTransport is constructed with,
// while delegating to the real upstream class so connect still behaves.
const capturedStreamableOpts: Array<Record<string, unknown>> = [];

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@modelcontextprotocol/client")>();
  class SpyStreamableHTTPClientTransport extends actual.StreamableHTTPClientTransport {
    constructor(url: URL, opts?: Record<string, unknown>) {
      super(url, opts as never);
      capturedStreamableOpts.push({ ...(opts ?? {}) });
    }
  }
  return {
    ...actual,
    StreamableHTTPClientTransport: SpyStreamableHTTPClientTransport,
  };
});

// Import AFTER the mock is registered so the manager binds the spy subclass.
const { MCPClientManager } = await import("../src/mcp-client-manager");

describe("MCPClientManager step-up transport wiring (SEP-2350)", () => {
  beforeEach(() => {
    capturedStreamableOpts.length = 0;
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
});
