/**
 * What the I10 tests share: a mock in front of the fixture's real server (or
 * none), a client pinned to one protocol revision that answers questions and
 * model requests, and one raw JSON-RPC request per revision.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, expect } from "vitest";
import {
  modernHeaders,
  modernRequestBody,
} from "../../mcp-conformance/raw-http.js";
import { buildMock, NO_REAL_SERVER, validateMockDefinition } from "../index.js";
import type {
  BuildMockOptions,
  JsonObject,
  MockDefinition,
  MockRealServer,
  MockSavedCase,
} from "../index.js";
import { buildRealHandler, connectRealServer } from "./real-fixture.js";
import type { RealCalls } from "./real-fixture.js";

export const REVISIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;
export type Revision = (typeof REVISIONS)[number];
export const isModern = (revision: string) => revision === "2026-07-28";

export const text = (value: string) => ({
  content: [{ type: "text", text: value }],
});

/** One tool, `work`, answered by the given saved cases. */
export function workDefinition(
  cases: MockSavedCase[],
  inputSchema: JsonObject = {
    type: "object",
    properties: { who: { type: "string" } },
  }
): MockDefinition {
  return {
    tools: { work: { inputSchema, answer: { from: "saved", cases } } },
  };
}

export interface Replies {
  elicit?: (params: Record<string, unknown>) => Record<string, unknown>;
  sample?: (params: Record<string, unknown>) => Record<string, unknown>;
}

export interface ConnectOptions {
  revision: Revision;
  /** Put the fixture's real server behind the mock. */
  backed?: boolean;
  /**
   * The revision the mock's connection to the real server speaks, when it is
   * not the caller's (a host connects to the real server on the newest
   * revision both speak, whatever the caller pinned).
   */
  realRevision?: Revision;
  replies?: Replies;
  build?: BuildMockOptions;
  /** Wrap or replace the real server the mock reaches (for a forward that needs special answers). */
  realWrap?: (real: MockRealServer) => MockRealServer;
  /** Client capabilities beyond the default of answering questions and model requests. */
  capabilities?: Record<string, unknown>;
}

type Rpc = {
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: Record<string, any> };
};

/** The tests' per-test state and helpers; call it at the top of a test file. */
export function useProtocolHarness() {
  const closers: Array<() => Promise<void>> = [];
  const harness = {
    state: { calls: [], hideTools: new Set(), asked: [] } as RealCalls,
    /** The fixture's real server, once a test connected a backed mock. */
    realHandler: undefined as McpHttpHandler | undefined,
    async connect(definition: MockDefinition, o: ConnectOptions) {
      expect(validateMockDefinition(definition)).toMatchObject({ ok: true });
      let real: MockRealServer = NO_REAL_SERVER;
      if (o.backed) {
        harness.realHandler = buildRealHandler(harness.state);
        const connected = await connectRealServer(
          harness.realHandler,
          harness.state,
          o.realRevision ?? o.revision
        );
        real = connected.real;
        closers.push(connected.close);
      }
      if (o.realWrap) real = o.realWrap(real);
      const handler = buildMock(definition, real, o.build);
      const client = new Client(
        { name: "mock-test", version: "1.0.0" },
        {
          capabilities: {
            elicitation: { form: {}, url: {} },
            sampling: {},
            ...o.capabilities,
          },
          ...(isModern(o.revision)
            ? {
                supportedProtocolVersions: ["2025-11-25", "2026-07-28"],
                versionNegotiation: { mode: { pin: "2026-07-28" } },
              }
            : { supportedProtocolVersions: [o.revision] }),
        }
      );
      const asked: Array<{ method: string; params: unknown }> = [];
      client.setRequestHandler("elicitation/create", async (request) => {
        asked.push({ method: "elicitation/create", params: request.params });
        return (o.replies?.elicit?.(
          request.params as Record<string, unknown>
        ) ?? { action: "decline" }) as never;
      });
      client.setRequestHandler("sampling/createMessage", async (request) => {
        asked.push({
          method: "sampling/createMessage",
          params: request.params,
        });
        return (o.replies?.sample?.(
          request.params as Record<string, unknown>
        ) ?? {
          role: "assistant",
          content: { type: "text", text: "" },
          model: "test-model",
        }) as never;
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
          fetch: (input, init) =>
            handler.fetch(new Request(input as string | URL, init)),
        })
      );
      closers.push(() => client.close());
      return { client, handler, asked };
    },
    /** One JSON-RPC request straight to the handler, on the wire of `revision`. */
    async rpc(
      handler: Pick<McpHttpHandler, "fetch">,
      revision: Revision,
      method: string,
      params: Record<string, unknown> = {},
      /** For 2026-07-28: what the caller declares it can do (a tasks caller declares the extension). */
      clientCapabilities: Record<string, unknown> = {}
    ): Promise<Rpc> {
      const modern = isModern(revision);
      const body = modern
        ? modernRequestBody({
            id: 1,
            method,
            params,
            protocolVersion: "2026-07-28",
            clientCapabilities,
          })
        : { jsonrpc: "2.0", id: 1, method, params };
      const headers = modern
        ? modernHeaders({
            protocolVersion: "2026-07-28",
            method,
            ...((typeof params.name === "string" ||
              typeof params.taskId === "string") && {
              name: String(params.name ?? params.taskId),
            }),
          })
        : {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": revision,
          };
      const response = await handler.fetch(
        new Request("http://mock.local/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      );
      const raw = await response.text();
      // A stream carries notifications before the response; the response has a result or an error.
      const messages = /^(event|data):/m.test(raw)
        ? raw
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => JSON.parse(l.slice(5)) as Rpc)
        : [JSON.parse(raw || "{}") as Rpc];
      return messages.find((m) => m.result || m.error) ?? {};
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

export const pollUntil = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the condition never held");
};

/**
 * Opens a 2026-07-28 `subscriptions/listen` stream on the handler and reads
 * its messages one at a time (`undefined` when none arrives in time).
 */
export async function openListen(
  handler: Pick<McpHttpHandler, "fetch">,
  notifications: Record<string, unknown>
) {
  const response = await handler.fetch(
    new Request("http://mock.local/mcp", {
      method: "POST",
      headers: modernHeaders({
        protocolVersion: "2026-07-28",
        method: "subscriptions/listen",
      }),
      body: JSON.stringify(
        modernRequestBody({
          id: 1,
          method: "subscriptions/listen",
          params: { notifications },
          protocolVersion: "2026-07-28",
          clientCapabilities: {},
        })
      ),
    })
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const messages: Array<Record<string, any>> = [];
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({
        value: undefined,
        done: true,
      }));
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      for (
        let end = buffered.indexOf("\n\n");
        end >= 0;
        end = buffered.indexOf("\n\n")
      ) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) messages.push(JSON.parse(data.slice(5)));
      }
    }
  })();
  return {
    /** The next message this stream sent, waiting up to `ms`. */
    async next(ms = 500) {
      for (let waited = 0; waited < ms; waited += 10) {
        if (messages.length > 0) return messages.shift();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return undefined;
    },
    async close() {
      await reader.cancel().catch(() => undefined);
      await pump;
    },
  };
}
