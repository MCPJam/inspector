import {
  encodeMcpHeaderValue,
  buildMcpParamHeaders,
  scanXMcpHeaderDeclarations,
} from "./mcp-header-mirror.js";
import type { EventsListResultWire } from "./events-ext-schemas.js";
import type { ServerEventTypesRead } from "../server-list-reads.js";

const namedMethods = new Set([
  "events/poll",
  "events/stream",
  "events/subscribe",
  "events/unsubscribe",
]);

export function validBetaHttpEventTypes(
  page: EventsListResultWire
): EventsListResultWire {
  return {
    ...page,
    events: page.events.filter(
      (event) => scanXMcpHeaderDeclarations(event.inputSchema).valid
    ),
  };
}

/** Add routing at the HTTP boundary, after the upstream transport builds its reserved headers. */
export function withEventsBetaRouting(
  send: typeof fetch,
  catalogVersion: () => symbol | undefined,
  list: (signal?: AbortSignal) => Promise<ServerEventTypesRead>
): typeof fetch {
  let cached: { version: symbol; catalog: ServerEventTypesRead } | undefined;
  return async (input, init) => {
    const version = catalogVersion();
    if (!version || typeof init?.body !== "string") return send(input, init);
    const headers = new Headers(init.headers);
    const method = headers.get("mcp-method");
    if (method === "events/list") cached = undefined;
    if (!method || !namedMethods.has(method)) return send(input, init);

    const {
      params,
    }: { params: { name: string; arguments?: Record<string, unknown> } } =
      JSON.parse(init.body);
    const route = async () => {
      const routed = new Headers(headers);
      routed.set("Mcp-Name", encodeMcpHeaderValue(params.name));
      if (Object.keys(params.arguments ?? {}).length) {
        if (cached?.version !== version) {
          const catalog = await list(init.signal ?? undefined);
          if (catalog.status === "failed") throw catalog.error;
          cached = { version, catalog };
        }
        const descriptor = cached.catalog.events.find(
          (event) => event.name === params.name
        );
        if (!descriptor && cached.catalog.truncated)
          throw new Error("Incomplete Events catalog for HTTP routing");
        const scan = scanXMcpHeaderDeclarations(descriptor?.inputSchema);
        if (scan.valid) {
          for (const [name, value] of Object.entries(
            buildMcpParamHeaders(scan.declarations, params.arguments)
          )) {
            routed.set(name, value);
          }
        }
      }
      return send(input, { ...init, headers: routed });
    };

    const response = await route();
    if (
      response.status === 400 &&
      response.headers.get("content-type")?.includes("application/json")
    ) {
      // Only HeaderMismatch guarantees the server rejected the request before handling it.
      let payload: unknown;
      try {
        payload = await response.clone().json();
      } catch (error) {
        // Preserve the original HTTP failure if its body is not a JSON-RPC error.
        if (error instanceof SyntaxError) return response;
        throw error;
      }
      if (
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        payload.error &&
        typeof payload.error === "object" &&
        "code" in payload.error &&
        payload.error.code === -32020
      ) {
        cached = undefined;
        return route();
      }
    }
    return response;
  };
}
