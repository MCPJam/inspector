/**
 * What the prompt, resource, template and skill tests share: a mock in front of
 * the fixture's real server (or none), a client in either wire era, and a raw
 * JSON-RPC request for methods the client has no typed call for.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, expect } from "vitest";
import {
  modernHeaders,
  modernRequestBody,
} from "../../mcp-conformance/raw-http.js";
import { buildMock, NO_REAL_SERVER, validateMockDefinition } from "../index.js";
import type { MockDefinition } from "../index.js";
import { buildRealHandler, connectRealServer } from "./real-fixture.js";
import type { RealCalls } from "./real-fixture.js";

export type Era = "legacy" | "modern";

type Handler = { fetch: (r: Request) => Promise<Response> };

/** Registers the per-test setup and returns the helpers; call it at the top of a test file. */
export function useItemHarness() {
  const closers: Array<() => Promise<void>> = [];
  const harness = {
    state: { calls: [], hideTools: new Set(), asked: [] } as RealCalls,
    async connect(
      definition: MockDefinition,
      era: Era,
      fromNothing = false,
      /** Pin the protocol revision the client asks for; default is the era's newest. */
      revision?: string
    ) {
      expect(validateMockDefinition(definition)).toMatchObject({ ok: true });
      let real = NO_REAL_SERVER;
      if (!fromNothing) {
        const connected = await connectRealServer(
          buildRealHandler(harness.state),
          harness.state
        );
        real = connected.real;
        closers.push(connected.close);
      }
      const handler = buildMock(definition, real);
      const client = new Client(
        { name: "mock-test", version: "1.0.0" },
        era === "modern"
          ? {
              supportedProtocolVersions: ["2025-11-25", "2026-07-28"],
              versionNegotiation: { mode: { pin: "2026-07-28" } },
            }
          : revision
            ? { supportedProtocolVersions: [revision] }
            : undefined
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
          fetch: (input, init) =>
            handler.fetch(new Request(input as string | URL, init)),
        })
      );
      closers.push(() => client.close());
      return { client, handler };
    },
    /** One JSON-RPC request straight to the handler. */
    async rpc(
      handler: Handler,
      era: Era,
      method: string,
      params: Record<string, unknown> = {}
    ) {
      const body =
        era === "modern"
          ? modernRequestBody({
              id: 1,
              method,
              params,
              protocolVersion: "2026-07-28",
            })
          : { jsonrpc: "2.0", id: 1, method, params };
      const headers =
        era === "modern"
          ? modernHeaders({ protocolVersion: "2026-07-28", method })
          : {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            };
      const response = await handler.fetch(
        new Request("http://mock.local/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      );
      const text = await response.text();
      const payload = /^(event|data):/m.test(text)
        ? text
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.slice(5)
        : text;
      return JSON.parse(payload ?? "{}") as {
        result?: Record<string, any>;
        error?: {
          code: number;
          message: string;
          data?: Record<string, unknown>;
        };
      };
    },
  };
  beforeEach(() => {
    harness.state = { calls: [], hideTools: new Set(), asked: [] };
  });
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });
  return harness;
}
