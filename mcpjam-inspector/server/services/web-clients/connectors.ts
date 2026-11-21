/**
 * A web connector is what the vendor app is pointed at: one project server,
 * reached through one web account. Its id is the last segment of the
 * forwarding endpoint's path.
 */
import type {
  WebClientVendor,
  WebConnectorAuth,
} from "../../../shared/web-clients.js";

export type WebConnector = {
  connectorId: string;
  projectId: string;
  organizationId?: string;
  serverId: string;
  webAccountId?: string;
  vendor?: WebClientVendor;
  auth: WebConnectorAuth;
};

/** Where a forwarded request goes, with the project's credential for it. */
export type UpstreamTarget = {
  url: string;
  headers: Record<string, string>;
};

export interface WebConnectorResolver {
  resolve(connectorId: string): Promise<WebConnector | undefined>;
  /**
   * The project's server and its credential. `userId` is the MCPJam user the
   * vendor's OAuth token names, when the connector uses OAuth.
   */
  upstream(
    connector: WebConnector,
    context: { userId?: string },
  ): Promise<UpstreamTarget>;
  /** Whether that user may use this connector's project. */
  mayUse?(connector: WebConnector, userId: string): Promise<boolean>;
}

/** A fixed set of connectors, for tests and the local tracer. */
export function createStaticConnectorResolver(
  entries: ReadonlyArray<{ connector: WebConnector; upstream: UpstreamTarget }>,
): WebConnectorResolver {
  const byId = new Map(
    entries.map((entry) => [entry.connector.connectorId, entry]),
  );
  return {
    async resolve(connectorId) {
      return byId.get(connectorId)?.connector;
    },
    async upstream(connector) {
      const entry = byId.get(connector.connectorId);
      if (!entry) {
        throw new Error(
          `Connector ${connector.connectorId} has no upstream server.`,
        );
      }
      return entry.upstream;
    },
    async mayUse() {
      return true;
    },
  };
}
