/**
 * The forwarding endpoint as this Inspector serves it: connectors a local
 * Inspector registered for the tracer first, then the backend's, each behind
 * `web-clients-enabled`. `server/index.ts` and `server/app.ts` mount it ahead
 * of the global middleware.
 */
import type { Hono } from "hono";
import { HOSTED_MODE } from "../../config.js";
import {
  createBackendConnectorResolver,
  createBackendToolCallLedger,
  webClientService,
} from "./backend-connector-resolver.js";
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
  // Only with the service credential: a local install without one has its
  // own registry and nothing else.
  const service = webClientService();
  const backend = service && createBackendConnectorResolver(service);
  const durable = service && createBackendToolCallLedger(service);
  const pick = (connectorId: string): WebConnectorResolver | undefined =>
    local?.has(connectorId) ? local.resolver : backend;
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
      // The local registry's connectors are not the backend's to keep.
      ...(durable
        ? {
            durableLedger: {
              record: async (call) =>
                local?.has(call.connectorId) ? undefined : durable.record(call),
              settle: durable.settle,
            },
          }
        : {}),
      // A local connector's requests name no user PostHog could be asked
      // about, so it answers to the flag of whoever registered it, as it is
      // now: turned off, the connector stops forwarding.
      isEnabled: async (connector, context) =>
        local?.has(connector.connectorId)
          ? local.enabled(connector.connectorId)
          : webClientsEnabledFor(context.userId),
    }),
  );
}
