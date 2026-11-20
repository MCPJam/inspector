/**
 * The forwarding endpoint as this Inspector serves it: connectors a local
 * Inspector registered for the tracer first, then the backend's, each behind
 * `web-clients-enabled`. `server/index.ts` and `server/app.ts` mount it ahead
 * of the global middleware.
 */
import type { Hono } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { getServiceCredential } from "../service-credential.js";
import { createBackendConnectorResolver } from "./backend-connector-resolver.js";
import type { WebConnectorResolver } from "./connectors.js";
import { webClientsEnabledFor } from "./endpoint-auth.js";
import {
  createWebConnectorEndpoint,
  mountWebConnectorEndpoint,
} from "./forwarding-endpoint.js";
import { localWebConnectors } from "./local-connectors.js";

export { createLocalConnectorRoutes } from "./local-connectors.js";

export function mountInspectorWebConnectors(app: Hono): void {
  const local = HOSTED_MODE ? undefined : localWebConnectors;
  const backend = createBackendConnectorResolver();
  // Asked only when this process can reach the backend: a local install
  // without the service credential has its own registry and nothing else.
  const pick = (connectorId: string): WebConnectorResolver | undefined =>
    local?.has(connectorId)
      ? local.resolver
      : process.env.CONVEX_HTTP_URL && getServiceCredential()
        ? backend
        : undefined;
  const resolver: WebConnectorResolver = {
    resolve: async (connectorId) => pick(connectorId)?.resolve(connectorId),
    upstream: async (connector, context) => {
      const chosen = pick(connector.connectorId);
      if (!chosen) throw new Error("No connector source serves this id.");
      return chosen.upstream(connector, context);
    },
    mayUse: async (connector, userId) =>
      (await pick(connector.connectorId)?.mayUse?.(connector, userId)) === true,
  };
  mountWebConnectorEndpoint(
    app,
    createWebConnectorEndpoint({
      resolver,
      // A local connector was registered with the flag on, by whoever runs
      // this Inspector, and names no user PostHog could be asked about.
      isEnabled: async (connector, context) =>
        local?.has(connector.connectorId) === true ||
        webClientsEnabledFor(context.userId),
    }),
  );
}
