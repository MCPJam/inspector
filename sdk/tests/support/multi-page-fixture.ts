/**
 * Multi-page beta.4 dual-era fixture for pagination-parity evidence
 * (Phase 3 §11.1).
 *
 * Built on the LOW-LEVEL `Server` export (not `McpServer`) because the
 * high-level builder has no page-size knob — hand-written `tools/list`,
 * `prompts/list`, `resources/list`, and `resources/templates/list` handlers
 * honor `params.cursor` and return `nextCursor` themselves. 3 pages of 4
 * items each (12 total) per primitive, by default.
 *
 * `createMcpHandler(factory)` serves both the modern (2026-07-28) and
 * legacy-stateless eras off the ONE factory, exactly like
 * `dual-era-fixture.ts` — see that file's header for why a single factory
 * matters (no cross-era drift).
 *
 * Modes (see {@link MultiPageFixtureOptions}):
 *  - `capabilities`: omit a primitive's capability entirely to exercise the
 *    "unsupported capability" outcome (the official client special-cases a
 *    withheld capability and returns an empty list WITHOUT sending a wire
 *    request — see `pagination-parity.integration.test.ts`).
 *  - `emptyLists`: capability present, zero items, no `nextCursor` — the
 *    "empty result" outcome.
 *  - `malformedCursor`: page 2 (`cursor: "page-1"`) returns `nextCursor:
 *    "page-1"` again instead of advancing to `"page-2"` — a
 *    non-converging server. Proves how the client's list-walk ACTUALLY
 *    behaves on a repeated cursor: per the doc comment on `_listAllPages` in
 *    `@modelcontextprotocol/client`, it stops the walk silently and returns
 *    a PARTIAL aggregate — it does NOT throw. `operations.ts`'s own
 *    `drainPaginatedList` has a repeated-cursor throw, but (verified in
 *    `pagination-parity.integration.test.ts`) it never fires for the
 *    `listAll*` helpers, because their first no-cursor page request already
 *    goes through this same silently-truncating client-side walk.
 *  - `resourceTemplatesProtocolError`: `resources/templates/list` throws a
 *    real JSON-RPC `InternalError`, distinct from "method not found" — the
 *    "protocol error" outcome, which must NOT be mistaken for "unsupported"
 *    by `isUnsupportedMethodError`/`isMethodUnavailableError`.
 *  - `failingTool`: always registers a `fail-tool` that returns
 *    `{ isError: true }` — the "tool-execution error" outcome (spec-legal
 *    result, never a thrown protocol error).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import { createCapturingFetch, type RawExchange } from "./raw-capture.js";

export const MULTI_PAGE_FIXTURE_SERVER_INFO = {
  name: "mcpjam-multi-page-fixture",
  version: "1.0.0",
} as const;

/** Items per page. 3 pages × this size = the fixture's total item count. */
export const FIXTURE_PAGE_SIZE = 4;
/** Total items served (no-cursor auto-aggregation must recover all of these). */
export const FIXTURE_TOTAL_ITEMS = FIXTURE_PAGE_SIZE * 3;

export interface MultiPageFixtureOptions {
  /**
   * Which capabilities to advertise. A key set to `false` is OMITTED from
   * the server's declared capabilities entirely (not just emptied) — this
   * is what makes the client take its "unsupported capability" short
   * circuit instead of sending a wire request. Defaults to all `true`.
   */
  capabilities?: { tools?: boolean; resources?: boolean; prompts?: boolean };
  /** Serve zero items (no `nextCursor`) from every paginated endpoint. */
  emptyLists?: boolean;
  /**
   * After the first page, every subsequent page repeats the SAME
   * `nextCursor` instead of advancing — simulates a non-converging server.
   */
  malformedCursor?: boolean;
  /**
   * `resources/templates/list` throws a real protocol-level `InternalError`
   * instead of listing. Distinct from omitting the resources capability
   * (which is "unsupported") or from an unregistered method (which reads as
   * "method not found" / unsupported to MCPJam's error classifiers).
   */
  resourceTemplatesProtocolError?: boolean;
  /**
   * Register a `fail-tool` that always returns `{ isError: true }` — a
   * spec-legal tool-execution failure, never a thrown JSON-RPC error.
   */
  failingTool?: boolean;
  /**
   * Invoked with the tool name the instant a `tools/call` reaches the fixture
   * handler, BEFORE any work. Used to build a deterministic "the request
   * actually arrived" synchronization point (see `waitForToolCall` on
   * {@link ServedMultiPageFixture}) instead of racing a fixed sleep.
   */
  onToolCall?: (name: string) => void;
  /**
   * Enforce SEP-2243 the way a conforming 2026-07-28 server does: a
   * `tools/call` for a tool that DECLARES an `x-mcp-header` but arrives
   * without the matching `Mcp-Param-*` header is answered
   * `-32020 HeaderMismatch` instead of being served.
   *
   * Implemented at the HTTP seam rather than in the tool handler because the
   * defect being modeled is an HTTP-envelope one — the low-level `Server`
   * handler never sees request headers. Only honored by
   * {@link serveMultiPageFixtureOnPort}, which owns that seam.
   */
  requireParamHeaders?: boolean;
  /**
   * Omit these tool names from `tools/list` while still SERVING them on
   * `tools/call` (and still enforcing their mirrored header under
   * `requireParamHeaders`).
   *
   * Models the case where a tool's schema cannot be resolved at all — the
   * branch that decides whether a suppressed-mirroring call still suppresses,
   * or silently reverts to a conforming one.
   */
  hideFromList?: string[];
  /**
   * Advertise the held-open `slow-tool` in `tools/list` as well as serving it.
   *
   * Off by default because every pagination assertion in this fixture counts
   * `FIXTURE_TOTAL_ITEMS`, and an extra listed tool would move those numbers.
   * Opt in when the tool has to arrive through a path that only knows listed
   * tools — `getToolsForAiSdk`, for one, builds its set from `tools/list`.
   */
  listSlowTool?: boolean;
}

/** The SEP-2243 `HeaderMismatch` JSON-RPC error code (2026-07-28). */
export const HEADER_MISMATCH_ERROR_CODE = -32020;

function paginatedPage<T>(
  all: T[],
  cursor: string | undefined,
  opts: Pick<MultiPageFixtureOptions, "emptyLists" | "malformedCursor">
): { items: T[]; nextCursor?: string } {
  if (opts.emptyLists) return { items: [] };

  const pageIndex = cursor === undefined ? 0 : parsePageCursor(cursor);
  const start = pageIndex * FIXTURE_PAGE_SIZE;
  const items = all.slice(start, start + FIXTURE_PAGE_SIZE);
  const isLastPage = start + FIXTURE_PAGE_SIZE >= all.length;

  if (opts.malformedCursor && pageIndex >= 1) {
    // Non-converging server: keep pointing back at the same cursor forever
    // instead of advancing (or terminating).
    return { items, nextCursor: "page-1" };
  }

  return { items, nextCursor: isLastPage ? undefined : `page-${pageIndex + 1}` };
}

function parsePageCursor(cursor: string): number {
  const match = /^page-(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

/** Build the fixture's fresh item lists (called once per server build). */
function buildItems() {
  const tools = Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => ({
    name: `tool-${i}`,
    description: `Paginated tool ${i}`,
    // `tool-0` (page 1) and `tool-4` (first item of page 2) declare a SEP-2243
    // `x-mcp-header` on their `message` property, so a `tools/call` for either
    // exercises the `Mcp-Param-Message` header path (the official client only
    // mirrors `x-mcp-header` params it can read off a CACHED `tools/list`
    // entry's `inputSchema` — see `modern-evidence.integration.test.ts`).
    //
    // The page-2 one exists so a first-page-only client can be told apart from
    // a conforming one on a tool the server still serves: same `tools/call`,
    // but the truncated client never cached `tool-4`'s schema, so it mirrors
    // nothing and the server answers `-32020`.
    inputSchema:
      i === 0 || i === FIXTURE_PAGE_SIZE
        ? {
            type: "object" as const,
            properties: {
              message: { type: "string" as const, "x-mcp-header": "Message" },
            },
          }
        : { type: "object" as const, properties: {} },
  }));
  const prompts = Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => ({
    name: `prompt-${i}`,
    description: `Paginated prompt ${i}`,
  }));
  const resources = Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => ({
    uri: `test://resource/${i}`,
    name: `resource-${i}`,
    mimeType: "text/plain",
  }));
  const resourceTemplates = Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => ({
    name: `template-${i}`,
    uriTemplate: `test://template/${i}/{id}`,
  }));
  return { tools, prompts, resources, resourceTemplates };
}

/**
 * Build a fresh low-level `Server` instance for the fixture.
 * `createMcpHandler` calls this per request — keep it side-effect-free.
 */
export function buildMultiPageFixtureServer(
  options: MultiPageFixtureOptions = {}
): Server {
  const caps = {
    tools: options.capabilities?.tools ?? true,
    resources: options.capabilities?.resources ?? true,
    prompts: options.capabilities?.prompts ?? true,
  };

  const server = new Server(MULTI_PAGE_FIXTURE_SERVER_INFO, {
    capabilities: {
      ...(caps.tools ? { tools: {} } : {}),
      ...(caps.resources ? { resources: {} } : {}),
      ...(caps.prompts ? { prompts: {} } : {}),
    },
  });

  const { tools, prompts, resources, resourceTemplates } = buildItems();

  if (caps.tools) {
    const baseTools = options.listSlowTool
      ? [
          ...tools,
          {
            name: "slow-tool",
            description: "Held open until the caller aborts",
            inputSchema: {
              type: "object" as const,
              properties: { delayMs: { type: "number" as const } },
            },
          },
        ]
      : tools;
    const listedTools =
      options.hideFromList && options.hideFromList.length > 0
        ? baseTools.filter((tool) => !options.hideFromList!.includes(tool.name))
        : baseTools;
    server.setRequestHandler("tools/list", (request: any) => {
      const { items, nextCursor } = paginatedPage(
        listedTools,
        request?.params?.cursor,
        options
      );
      return { tools: items, nextCursor };
    });

    server.setRequestHandler("tools/call", async (request: any, ctx: any) => {
      const name = request.params.name as string;
      options.onToolCall?.(name);
      // `fail-tool` is opt-in: only the `failingTool` mode makes it fail, so a
      // test that forgot to enable the mode can't silently get the failing
      // outcome anyway.
      if (name === "fail-tool" && options.failingTool) {
        return {
          content: [{ type: "text", text: "fail-tool always fails" }],
          isError: true,
        };
      }
      if (name === "slow-tool") {
        // Held open for abort-mid-call evidence (modern-evidence.integration.test.ts):
        // never resolves on its own within a test's timeout, so the test's
        // `AbortSignal` is what ends the call.
        const delayMs = Number(request.params.arguments?.delayMs ?? 60_000);
        const signal: AbortSignal | undefined = ctx?.signal;
        await new Promise<void>((resolve, reject) => {
          // Already aborted before we could attach a listener — reject now so
          // no timer is ever created for a doomed call.
          if (signal?.aborted) {
            reject(new Error("slow-tool aborted"));
            return;
          }
          const timer = setTimeout(resolve, delayMs);
          // Never let this held-open timer keep the test process (or a
          // wait-for-open-handles runner) alive for the full delay if the
          // abort listener doesn't fire — e.g. the transport doesn't surface
          // cancellation on `ctx.signal`. `unref` is enough on its own; the
          // abort listener is the fast, deterministic path when it does fire.
          (timer as unknown as { unref?: () => void }).unref?.();
          signal?.addEventListener?.("abort", () => {
            clearTimeout(timer);
            reject(new Error("slow-tool aborted"));
          });
        });
        return { content: [{ type: "text", text: "slow-tool finished" }] };
      }
      if (name === "echo" || name.startsWith("tool-")) {
        return {
          content: [
            { type: "text", text: String(request.params.arguments?.message ?? `called ${name}`) },
          ],
        };
      }
      return { content: [{ type: "text", text: `called ${name}` }] };
    });
  }

  if (caps.resources) {
    server.setRequestHandler("resources/list", (request: any) => {
      const { items, nextCursor } = paginatedPage(resources, request?.params?.cursor, options);
      return { resources: items, nextCursor };
    });

    server.setRequestHandler("resources/templates/list", (request: any) => {
      if (options.resourceTemplatesProtocolError) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "resource template listing is temporarily unavailable"
        );
      }
      const { items, nextCursor } = paginatedPage(
        resourceTemplates,
        request?.params?.cursor,
        options
      );
      return { resourceTemplates: items, nextCursor };
    });
  }

  if (caps.prompts) {
    server.setRequestHandler("prompts/list", (request: any) => {
      const { items, nextCursor } = paginatedPage(prompts, request?.params?.cursor, options);
      return { prompts: items, nextCursor };
    });
  }

  if (options.failingTool && !caps.tools) {
    // failingTool implies a tools/call handler must exist even if the
    // paginated tools/list surface itself is disabled for a test.
    server.setRequestHandler("tools/call", async () => ({
      content: [{ type: "text", text: "fail-tool always fails" }],
      isError: true,
    }));
  }

  return server;
}

/** A `createMcpHandler` bound to the fixture. Drive it with `handler.fetch(request)`. */
export function createMultiPageFixtureHandler(options: MultiPageFixtureOptions = {}) {
  return createMcpHandler(() => buildMultiPageFixtureServer(options));
}

export interface ServedMultiPageFixture {
  url: string;
  /** Every request/response the fixture handled, verbatim, in call order. */
  exchanges: RawExchange[];
  /**
   * Resolves when a `tools/call` for `name` has actually reached the fixture
   * handler (resolving immediately if one already has). A deterministic
   * request-arrival signal for held-open calls (e.g. `slow-tool`), whose
   * response never completes and so never lands in {@link exchanges} — making
   * the exchange log useless as a "did it dispatch?" check.
   */
  waitForToolCall: (name: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * The tools this fixture publishes with an `x-mcp-header` declaration, and the
 * header a conforming client MUST therefore mirror onto their `tools/call`.
 * Kept beside {@link buildItems}, which is where the declaration is written.
 */
const REQUIRED_PARAM_HEADER_BY_TOOL: Record<string, string> = {
  "tool-0": "mcp-param-message",
  // First item of page 2 (`FIXTURE_PAGE_SIZE` === 4).
  "tool-4": "mcp-param-message",
};

/**
 * Answer `-32020 HeaderMismatch` when a `tools/call` for a declaring tool
 * arrives without its mirrored header — what
 * `MultiPageFixtureOptions.requireParamHeaders` buys. Returns `undefined` for
 * every request that should be served normally.
 *
 * Reads `(input, init)` the same way `captureRequest` does — never by
 * constructing a `Request` — so the real handler still receives an unconsumed
 * body, and a non-POST probe (which carries none) passes straight through.
 */
async function headerMismatchRejection(
  input: any,
  init: any
): Promise<Response | undefined> {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const headers = new Headers(isRequest ? (input as Request).headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  let bodyText = "";
  if (typeof init?.body === "string") {
    bodyText = init.body;
  } else if (init?.body == null && isRequest) {
    try {
      bodyText = await (input as Request).clone().text();
    } catch {
      return undefined;
    }
  }
  if (!bodyText) return undefined;

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const frames = Array.isArray(body) ? body : [body];
  for (const frame of frames) {
    if (frame?.method !== "tools/call") continue;
    const required = REQUIRED_PARAM_HEADER_BY_TOOL[frame?.params?.name];
    if (required === undefined) continue;
    if (headers.get(required) !== null) continue;
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id ?? null,
        error: {
          code: HEADER_MISMATCH_ERROR_CODE,
          message: `Mcp-Param-Message header is absent for tool ${frame.params.name}`,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return undefined;
}

/**
 * Serve the fixture over a REAL loopback HTTP port (mirrors
 * `mcp-client-manager-fixture.integration.test.ts`'s `serveFixtureOnPort`),
 * while also recording every exchange verbatim via `createCapturingFetch`.
 *
 * The capture point is `handler.fetch` — the same web-standard seam
 * `toNodeHandler` calls internally — so this captures the true JSON-RPC
 * request/response bodies MCPClientManager's real HTTP client produces,
 * with a real socket in between. `exchanges` accumulates for the lifetime
 * of the returned handle; read it any time.
 */
export async function serveMultiPageFixtureOnPort(
  options: MultiPageFixtureOptions = {}
): Promise<ServedMultiPageFixture> {
  // Track which tool calls have reached the handler so callers can await a
  // real arrival signal (see `waitForToolCall`) rather than a racy sleep.
  const seenToolCalls = new Set<string>();
  const toolCallWaiters: Array<{ name: string; resolve: () => void }> = [];
  const onToolCall = (name: string) => {
    seenToolCalls.add(name);
    for (let i = toolCallWaiters.length - 1; i >= 0; i--) {
      if (toolCallWaiters[i]!.name === name) {
        toolCallWaiters.splice(i, 1)[0]!.resolve();
      }
    }
    options.onToolCall?.(name);
  };
  const waitForToolCall = (name: string): Promise<void> => {
    if (seenToolCalls.has(name)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      toolCallWaiters.push({ name, resolve });
    });
  };

  const handler = createMultiPageFixtureHandler({ ...options, onToolCall });
  // Sits INSIDE the capture wrapper so a rejected call still lands in
  // `exchanges` — the test's evidence is precisely which headers arrived.
  const serve = async (input: any, init: any): Promise<Response> => {
    const rejection = options.requireParamHeaders
      ? await headerMismatchRejection(input, init)
      : undefined;
    return rejection ?? ((handler.fetch as any)(input, init) as Promise<Response>);
  };
  const cap = createCapturingFetch(serve);
  const httpServer = http.createServer(
    toNodeHandler({ fetch: cap.fetch } as any)
  );
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    exchanges: cap.exchanges,
    waitForToolCall,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
