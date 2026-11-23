/**
 * A 2026-07-28 server with one tool, `hello-region`, whose `region` argument
 * is marked `x-mcp-header: "Region"`. Like a conforming server, it refuses a
 * `tools/call` whose `Mcp-Param-Region` header is missing or differs from the
 * body, with HTTP 400 and JSON-RPC `-32020`.
 *
 * It is a plain function from a request to an answer, so a unit test can use
 * it as a scripted `fetch` and an integration test can put it behind a socket.
 */

export const REGION_TOOL = "hello-region";

export interface RegionServerOptions {
  /**
   * How many `tools/list` answers leave the `x-mcp-header` mark off before the
   * server starts declaring it. With 1, a client that listed once has a stale
   * schema and only learns about the header by listing again.
   */
  listingsWithoutTheMark?: number;
  /** Refuse every call with `-32020`, whatever headers it carries. */
  alwaysRefuse?: boolean;
  /**
   * Also mark a `zone` argument with the same header name as `region`. The
   * spec does not allow two arguments to share one, so the whole schema is
   * invalid and a client has no valid header to build from it.
   */
  duplicateMark?: boolean;
  /**
   * Break one `tools/list`, counted from 1: answer a page with no `tools`
   * array (`malformed`), or do not answer at all (`unreachable`, which makes
   * the scripted `fetch` reject as a dropped connection would).
   */
  brokenListing?: { nth: number; how: "malformed" | "unreachable" };
  /** Send one log notification along with every refusal. */
  logOnRefusal?: boolean;
  /**
   * Do not answer one `tools/call`, counted from 1: the scripted `fetch`
   * rejects as a dropped connection would.
   */
  unreachableCall?: number;
}

export interface RegionServerRequest {
  method: string;
  id: unknown;
  params?: Record<string, unknown>;
  /** The `Mcp-Param-Region` header as received, if any. */
  paramRegion: string | undefined;
}

export interface RegionServerAnswer {
  status: number;
  body: Record<string, unknown>;
  /** Notifications the server streams before `body`, when it has any. */
  notifications?: Array<Record<string, unknown>>;
}

/** One line per request, for asserting what reached the server and in what order. */
export type RegionServerLog = string[];

/** Thrown by the server function for a `tools/list` it does not answer. */
export class ListingUnreachable extends Error {
  constructor() {
    super("connection reset");
    this.name = "ListingUnreachable";
  }
}

/** Thrown by the server function for a `tools/call` it does not answer. */
export class CallUnreachable extends Error {
  constructor() {
    super("connection reset");
    this.name = "CallUnreachable";
  }
}

export function createRegionServer(
  options: RegionServerOptions,
  log: RegionServerLog
): (request: RegionServerRequest) => RegionServerAnswer {
  let listings = 0;
  let toolCalls = 0;

  return (request) => {
    const ok = (result: Record<string, unknown>): RegionServerAnswer => ({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "public",
          ...result,
        },
      },
    });
    const refuse = (message: string): RegionServerAnswer => ({
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32020, message },
      },
      ...(options.logOnRefusal
        ? {
            notifications: [
              {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: { level: "info", data: "refusing the call" },
              },
            ],
          }
        : {}),
    });

    switch (request.method) {
      case "server/discover":
        log.push("server/discover");
        return ok({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        });
      case "tools/list": {
        listings += 1;
        if (options.brokenListing?.nth === listings) {
          log.push(`tools/list (${options.brokenListing.how})`);
          if (options.brokenListing.how === "unreachable") {
            throw new ListingUnreachable();
          }
          return ok({ notTools: true });
        }
        const marked = listings > (options.listingsWithoutTheMark ?? 0);
        log.push(`tools/list (${marked ? "with" : "without"} the mark)`);
        return ok({
          tools: [
            {
              name: REGION_TOOL,
              inputSchema: {
                type: "object",
                properties: {
                  region: {
                    type: "string",
                    ...(marked ? { "x-mcp-header": "Region" } : {}),
                  },
                  ...(options.duplicateMark
                    ? { zone: { type: "string", "x-mcp-header": "region" } }
                    : {}),
                },
              },
              outputSchema: {
                type: "object",
                properties: { greeting: { type: "string" } },
                required: ["greeting"],
              },
            },
          ],
        });
      }
      case "tools/call": {
        const args = request.params?.arguments as
          { region?: unknown } | undefined;
        log.push(
          `tools/call Mcp-Param-Region=${request.paramRegion ?? "(none)"}`
        );
        toolCalls += 1;
        if (options.unreachableCall === toolCalls) {
          throw new CallUnreachable();
        }
        if (options.alwaysRefuse) {
          return refuse("Mcp-Param-Region header is not accepted");
        }
        if (request.paramRegion === undefined) {
          return refuse("Missing Mcp-Param-Region header");
        }
        if (request.paramRegion !== args?.region) {
          return refuse("Mcp-Param-Region header does not match");
        }
        return ok({
          content: [{ type: "text", text: `Hello from ${args.region}` }],
          structuredContent: { greeting: `Hello from ${String(args.region)}` },
        });
      }
      default:
        log.push(request.method);
        return {
          status: 404,
          body: {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Method not found" },
          },
        };
    }
  };
}

/**
 * The region server as a scripted `fetch`. An answer with notifications goes
 * out as an event stream, the notifications first and the answer last, the
 * way a server streams a response.
 */
export function regionServerFetch(
  options: RegionServerOptions,
  log: RegionServerLog
): typeof fetch {
  const server = createRegionServer(options, log);
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const answer = server({
      method: body.method,
      id: body.id,
      params: body.params,
      paramRegion:
        new Headers(init?.headers).get("mcp-param-region") ?? undefined,
    });
    if (answer.notifications) {
      const frames = [...answer.notifications, answer.body]
        .map((message) => `data: ${JSON.stringify(message)}\n\n`)
        .join("");
      return new Response(frames, {
        status: answer.status,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
