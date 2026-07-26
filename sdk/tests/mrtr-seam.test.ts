import { describe, expect, it, vi } from "vitest";
import { LOG_LEVEL_META_KEY, type Request } from "@modelcontextprotocol/client";
import { OfficialSdkClientAdapter } from "../src/mcp-client-manager/official-sdk-client-adapter.js";
import { LogLevelMetaClient } from "../src/mcp-client-manager/log-level-meta-client.js";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client.js";

/**
 * The explicit-schema `requestWithSchema` seam (new for the 2026-07-28 MRTR
 * loop) must be present and honest on BOTH `ManagedMcpClient` implementations:
 *  - `OfficialSdkClientAdapter` forwards verbatim to upstream
 *    `Protocol.request`'s explicit-result-schema overload; and
 *  - the `LogLevelMetaClient` decorator injects the modern per-request logging
 *    `_meta` here exactly as it does for the other request-bearing methods —
 *    otherwise every MRTR retry leg would silently drop the log level.
 */

const SCHEMA = { "~standard": { version: 1, vendor: "t", validate: (v: unknown) => ({ value: v }) } };
const REQ = { method: "tools/call", params: { name: "t" } } as unknown as Request;

describe("OfficialSdkClientAdapter.requestWithSchema", () => {
  it("forwards (req, resultSchema, options) verbatim to inner.request", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const adapter = new OfficialSdkClientAdapter({ request } as never);
    const options = { allowInputRequired: true, timeout: 5 };
    const result = await adapter.requestWithSchema(REQ, SCHEMA as never, options);
    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(REQ);
    expect(request.mock.calls[0][1]).toBe(SCHEMA);
    expect(request.mock.calls[0][2]).toBe(options);
  });
});

/** Minimal inner `ManagedMcpClient` recording `requestWithSchema` calls. */
function fakeInner(era: "modern" | "legacy" | undefined): {
  inner: ManagedMcpClient;
  calls: Array<{ req: Request; options?: unknown }>;
} {
  const calls: Array<{ req: Request; options?: unknown }> = [];
  const inner = {
    getProtocolEra: () => era,
    requestWithSchema: (req: Request, _schema: unknown, options?: unknown) => {
      calls.push({ req, options });
      return Promise.resolve({ ok: true });
    },
  } as unknown as ManagedMcpClient;
  return { inner, calls };
}

describe("LogLevelMetaClient.requestWithSchema", () => {
  it("injects the log level into params._meta on a modern connection", async () => {
    const { inner, calls } = fakeInner("modern");
    const client = new LogLevelMetaClient(inner, () => "warning");
    await client.requestWithSchema(REQ, SCHEMA as never);
    const params = calls[0].req.params as { _meta?: Record<string, unknown> };
    expect(params._meta?.[LOG_LEVEL_META_KEY]).toBe("warning");
  });

  it("does NOT inject on a legacy connection (level rides logging/setLevel there)", async () => {
    const { inner, calls } = fakeInner("legacy");
    const client = new LogLevelMetaClient(inner, () => "warning");
    await client.requestWithSchema(REQ, SCHEMA as never);
    const params = calls[0].req.params as { _meta?: Record<string, unknown> };
    expect(params._meta).toBeUndefined();
  });

  it("does NOT inject when no level is set (absence is opt-out)", async () => {
    const { inner, calls } = fakeInner("modern");
    const client = new LogLevelMetaClient(inner, () => undefined);
    await client.requestWithSchema(REQ, SCHEMA as never);
    // Forwarded untouched — same request object, no _meta added.
    expect(calls[0].req).toBe(REQ);
    expect((calls[0].req.params as { _meta?: unknown })._meta).toBeUndefined();
  });

  it("lets caller-supplied _meta keys win over the injected level", async () => {
    const { inner, calls } = fakeInner("modern");
    const client = new LogLevelMetaClient(inner, () => "error");
    const reqWithMeta = {
      method: "tools/call",
      params: { name: "t", _meta: { [LOG_LEVEL_META_KEY]: "debug", other: 1 } },
    } as unknown as Request;
    await client.requestWithSchema(reqWithMeta, SCHEMA as never);
    const params = calls[0].req.params as { _meta?: Record<string, unknown> };
    expect(params._meta?.[LOG_LEVEL_META_KEY]).toBe("debug");
    expect(params._meta?.other).toBe(1);
  });
});
