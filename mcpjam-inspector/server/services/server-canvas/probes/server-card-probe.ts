/**
 * The `server-card` probe: the SDK's `probeServerCard` over the pinned
 * transport, with the facts the connected server reported for the
 * consistency check.
 *
 * The SDK sends only GETs with an Accept header, never the configured URL's
 * query or user info, and dials a catalog-named URL only on the server's own
 * origin. The pinned transport adds what only a resolver can: a hostname that
 * answers with a private address, and a redirect to one, are refused hosted,
 * and locally unless the server itself is on a private network.
 */
import {
  probeServerCard,
  type ProbeSummary,
  type ServerCardRuntimeFacts,
  type ServerFeatureSnapshotV3,
} from "@mcpjam/sdk";
import { isLoopbackOAuthUrl } from "@mcpjam/sdk/oauth/node";
import { HOSTED_MODE } from "../../../config.js";
import { hostedPrivateEgressAdmission } from "../../../utils/hosted-egress-guard.js";
import { createPinnedFetch } from "../../../utils/pinned-fetch.js";

export const SERVER_CARD_FETCH_TIMEOUT_MS = 5_000;

function defaultCardFetch(serverUrl: string, privateTarget: boolean): typeof fetch {
  return createPinnedFetch({
    allowLoopback: !HOSTED_MODE && isLoopbackOAuthUrl(serverUrl),
    allowPrivateNetwork: !HOSTED_MODE && privateTarget,
    admitPrivateDestination: HOSTED_MODE
      ? hostedPrivateEgressAdmission()
      : undefined,
    timeoutMs: SERVER_CARD_FETCH_TIMEOUT_MS,
  });
}

/** What the capture saw of the running server, for the card comparison. */
export function serverCardRuntimeFacts(
  snapshot: ServerFeatureSnapshotV3,
  serverUrl: string,
): ServerCardRuntimeFacts {
  const server = snapshot.servers[0];
  const info = server?.discovery?.serverInfo;
  const transport = server?.transport;
  return {
    serverUrl,
    ...(info
      ? {
          serverInfo: {
            ...(info.name ? { name: info.name } : {}),
            ...(info.version ? { version: info.version } : {}),
            ...(info.title ? { title: info.title } : {}),
          },
        }
      : {}),
    ...(server?.discovery?.protocolVersion
      ? { protocolVersion: server.discovery.protocolVersion }
      : {}),
    ...(transport === "streamable-http" || transport === "sse"
      ? { transport }
      : {}),
  };
}

export async function runServerCardProbe(
  input: {
    serverUrl: string;
    snapshot: ServerFeatureSnapshotV3;
    now: () => number;
    signal?: AbortSignal;
    /** The server itself is on a private network (`serverOnPrivateNetwork`). */
    privateTarget: boolean;
  },
  dependencies: { fetchFn?: typeof fetch } = {},
): Promise<ProbeSummary<"server-card">> {
  return probeServerCard({
    serverUrl: input.serverUrl,
    runtime: serverCardRuntimeFacts(input.snapshot, input.serverUrl),
    fetchFn:
      dependencies.fetchFn ?? defaultCardFetch(input.serverUrl, input.privateTarget),
    timeoutMs: SERVER_CARD_FETCH_TIMEOUT_MS,
    allowPrivateNetwork: !HOSTED_MODE && input.privateTarget,
    ...(input.signal ? { signal: input.signal } : {}),
    now: input.now,
  });
}
