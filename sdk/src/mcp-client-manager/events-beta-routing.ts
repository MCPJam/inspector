import {
  encodeMcpHeaderValue,
  buildMcpParamHeaders,
  EVENTS_BETA_ROUTED_METHODS,
  MCP_PARAM_HEADER_PREFIX,
  scanXMcpHeaderDeclarations,
} from "./mcp-header-mirror.js";
import type {
  EventDescriptorWire,
  EventsListResultWire,
} from "./events-ext-schemas.js";
import type { ServerEventTypesRead } from "../server-list-reads.js";

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
  // Cleanup must survive a catalog invalidation or outage on this connection.
  const knownDescriptors = new Map<string, EventDescriptorWire>();
  return async (input, init) => {
    const version = catalogVersion();
    if (!version) {
      cached = undefined;
      knownDescriptors.clear();
      return send(input, init);
    }
    if (typeof init?.body !== "string") return send(input, init);
    const originalHeaders = new Headers(init.headers);
    const method = originalHeaders.get("mcp-method");
    const listing = method === "events/list";
    if (!listing && (!method || !EVENTS_BETA_ROUTED_METHODS.has(method))) {
      return send(input, init);
    }
    const headers = new Headers();
    originalHeaders.forEach((value, name) => {
      if (name !== "mcp-name" && !name.startsWith(MCP_PARAM_HEADER_PREFIX)) {
        headers.set(name, value);
      }
    });
    if (listing) {
      cached = undefined;
      return send(input, { ...init, headers });
    }

    const {
      params,
    }: { params: { name: string; arguments?: Record<string, unknown> } } =
      JSON.parse(init.body);
    const refreshCatalog = async () => {
      const catalog = await list(init.signal ?? undefined);
      if (catalog.status === "failed") throw catalog.error;
      cached = { version, catalog };
      return catalog;
    };
    const route = async () => {
      const routed = new Headers(headers);
      routed.set("Mcp-Name", encodeMcpHeaderValue(params.name));
      if (Object.keys(params.arguments ?? {}).length) {
        let descriptor =
          method === "events/unsubscribe"
            ? knownDescriptors.get(params.name)
            : undefined;
        if (!descriptor) {
          const catalog = cached?.version === version
            ? cached.catalog
            : await refreshCatalog();
          descriptor = catalog.events.find(
            (event) => event.name === params.name
          );
          if (!descriptor && catalog.truncated)
            throw new Error("Incomplete Events catalog for HTTP routing");
          if (descriptor) knownDescriptors.set(params.name, descriptor);
        }
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
        knownDescriptors.delete(params.name);
        await refreshCatalog();
        return route();
      }
    }
    return response;
  };
}
