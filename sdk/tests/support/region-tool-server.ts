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
}

/** One line per request, for asserting what reached the server and in what order. */
export type RegionServerLog = string[];

export function createRegionServer(
  options: RegionServerOptions,
  log: RegionServerLog
): (request: RegionServerRequest) => RegionServerAnswer {
  let listings = 0;

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
