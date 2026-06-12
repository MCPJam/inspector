import { Hono } from "hono";
import { tunnelManager } from "../../services/tunnel-manager";
import { withTunnelLock } from "../../services/tunnel-locks";
import {
  clearTunnelRequests,
  getTunnelRequests,
} from "../../services/tunnel-request-log";
import { LOCAL_SERVER_ADDR } from "../../config";
import "../../types/hono";
import { logger } from "../../utils/logger";
import { getRequestLogger } from "../../utils/request-logger";
import { classifyTunnelError } from "../../utils/error-classify";

const tunnels = new Hono();

// Grant minted by the Convex backend: a stable slug, the bearer URL with a
// fresh ?k= secret, and a connect token the relay edge verifies at the
// WebSocket handshake. The secret/URL/token live in inspector memory only.
interface RelayGrant {
  slug: string;
  url: string;
  secret?: string;
  secretHash?: string;
  secretVersion?: number;
  connectToken: string;
  connectTokenExpiresAt?: number;
  relayWsUrl: string;
}

function convexHeaders(authHeader?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }
  return headers;
}

function requireConvexUrl(): string {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_HTTP_URL not configured");
  }
  return convexUrl;
}

function validateGrant(
  data: Partial<RelayGrant> & { ok?: boolean }
): RelayGrant {
  if (!data.ok || !data.slug || !data.url) {
    throw new Error("Invalid response from tunnel service");
  }
  if (!data.connectToken || !data.relayWsUrl) {
    // Local-dev skew: a backend without the relay routes answered.
    throw new Error(
      "Tunnel backend does not support relay tunnels yet — deploy the relay-enabled backend (or set TUNNEL_RELAY_* env on it)"
    );
  }
  return data as RelayGrant;
}

// Fetch a relay tunnel grant from the Convex backend. `transport=relay`
// marks this inspector as relay-capable; backends answer pre-relay
// inspectors (no marker) with an actionable 410.
async function fetchRelayGrant(
  serverId: string,
  authHeader?: string
): Promise<RelayGrant> {
  const convexUrl = requireConvexUrl();

  const response = await fetch(
    `${convexUrl}/tunnels/token?serverId=${encodeURIComponent(
      serverId
    )}&transport=relay`,
    {
      method: "GET",
      headers: convexHeaders(authHeader),
    }
  );

  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || "Failed to fetch tunnel grant");
  }

  return validateGrant(
    (await response.json()) as Partial<RelayGrant> & { ok?: boolean }
  );
}

// Rotate the bearer secret with the Convex backend. Single-phase: the
// backend patches the row AND revokes the old grant at the edge before
// responding, so the old URL is already dead; we just reconnect with the
// fresh grant.
async function fetchRotationGrant(
  serverId: string,
  full: boolean,
  authHeader?: string
): Promise<RelayGrant> {
  const convexUrl = requireConvexUrl();

  const response = await fetch(`${convexUrl}/tunnels/rotate`, {
    method: "POST",
    headers: convexHeaders(authHeader),
    body: JSON.stringify({ serverId, full, transport: "relay" }),
  });

  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || "Failed to rotate tunnel");
  }

  return validateGrant(
    (await response.json()) as Partial<RelayGrant> & { ok?: boolean }
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// Report tunnel closure to Convex backend (which also tells the relay edge
// to drop the socket and deny the now-superseded grant; the slug is kept so
// the URL stays stable on recreate).
async function reportTunnelClosure(
  serverId: string,
  authHeader?: string
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return;
  }

  try {
    await fetch(`${convexUrl}/tunnels/close`, {
      method: "POST",
      headers: convexHeaders(authHeader),
      body: JSON.stringify({ serverId }),
    });
  } catch (error) {
    logger.error("Failed to report tunnel closure", error, { serverId });
  }
}

// Create a server-specific tunnel over the MCPJam relay: the bearer secret
// in the returned URL and the per-server path scope are enforced at the
// relay edge, and the tunnel is live exactly while our outbound WebSocket
// is connected.
tunnels.post("/create/:serverId", async (c) => {
  const authHeader = c.req.header("authorization");
  const serverId = c.req.param("serverId");

  // Serialized per server: grant minting rotates the secret server-side,
  // so overlapping creates would race the edge's view of the live grant.
  // Inside the lock the existence check observes any concurrent create's
  // finished connection.
  return withTunnelLock(serverId, async () => {
    try {
      const existingUrl = tunnelManager.getServerTunnelUrl(serverId);
      if (existingUrl) {
        getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.created", {
          tunnelKind: "server",
          tunnelDomain: safeHostname(existingUrl),
          existed: true,
        });
        return c.json({
          url: existingUrl,
          existed: true,
        });
      }

      let grant: RelayGrant;
      try {
        grant = await fetchRelayGrant(serverId, authHeader);
      } catch (error: any) {
        getRequestLogger(c, "routes.mcp.tunnels").event(
          "tunnel.creation_failed",
          {
            tunnelKind: "server",
            errorCode: classifyTunnelError(error, "fetch_relay_grant_failed"),
          }
        );
        throw error;
      }

      await tunnelManager.createTunnel(serverId, {
        localAddr: LOCAL_SERVER_ADDR,
        slug: grant.slug,
        relayWsUrl: grant.relayWsUrl,
        connectToken: grant.connectToken,
        publicUrl: grant.url,
        secretVersion: grant.secretVersion,
      });

      // The handshake succeeded, so the grant URL is the right answer. Don't
      // re-derive it from live manager state: a permanent edge close
      // (replaced/revoked) racing in right after createTunnel could drop the
      // entry and turn a completed create into a misleading 500. If the
      // tunnel did die, the card's revalidation poll detects it and clears
      // the URL.
      const serverTunnelUrl =
        tunnelManager.getServerTunnelUrl(serverId) ?? grant.url;

      getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.created", {
        tunnelKind: "server",
        tunnelDomain: safeHostname(grant.url),
        existed: false,
      });
      return c.json({
        url: serverTunnelUrl,
        serverId,
        slug: grant.slug,
        secretVersion: grant.secretVersion,
        existed: false,
      });
    } catch (error: any) {
      getRequestLogger(c, "routes.mcp.tunnels").event(
        "tunnel.creation_failed",
        {
          tunnelKind: "server",
          errorCode: classifyTunnelError(error, "relay_connect_failed"),
        }
      );
      logger.error("Error creating server-specific tunnel", error, {
        serverId,
      });
      return c.json(
        {
          error: error.message || "Failed to create server-specific tunnel",
        },
        500
      );
    }
  });
});

// Rotate a server tunnel's bearer secret (single-phase). The slug is
// stable; only the ?k= secret changes, and the backend revokes the old
// grant at the edge before we even see the response. `full: true`
// additionally swaps the slug — a rare escape hatch.
tunnels.post("/rotate/:serverId", async (c) => {
  const authHeader = c.req.header("authorization");
  const serverId = c.req.param("serverId");

  let full = false;
  try {
    const body = await c.req.json();
    full = body?.full === true;
  } catch {}

  // Serialized with create/close for this server so a rotation can never
  // interleave with another lifecycle operation's grant/connect steps.
  return withTunnelLock(serverId, async () => {
    let grant: RelayGrant;
    try {
      grant = await fetchRotationGrant(serverId, full, authHeader);
    } catch (error: any) {
      getRequestLogger(c, "routes.mcp.tunnels").event(
        "tunnel.rotation_failed",
        {
          tunnelKind: "server",
          errorCode: classifyTunnelError(error, "fetch_relay_grant_failed"),
        }
      );
      logger.error("Error rotating tunnel secret", error, { serverId });
      return c.json({ error: error.message || "Failed to rotate tunnel" }, 500);
    }

    try {
      // Reconnect with the fresh grant. The old secret is already dead at
      // the edge (the backend disconnected + deny-listed it), so a failure
      // here leaves the tunnel offline — never serving the old secret.
      await tunnelManager.rotateTunnel(serverId, {
        localAddr: LOCAL_SERVER_ADDR,
        slug: grant.slug,
        relayWsUrl: grant.relayWsUrl,
        connectToken: grant.connectToken,
        publicUrl: grant.url,
        secretVersion: grant.secretVersion,
      });
    } catch (error: any) {
      getRequestLogger(c, "routes.mcp.tunnels").event(
        "tunnel.rotation_failed",
        {
          tunnelKind: "server",
          errorCode: classifyTunnelError(error, "relay_connect_failed"),
          tunnelDomain: safeHostname(grant.url),
        }
      );
      logger.error("Error reconnecting rotated tunnel", error, { serverId });
      return c.json(
        {
          error:
            (error.message || "Failed to reconnect rotated tunnel") +
            " — the old URL is already revoked; retry rotate or recreate the tunnel",
        },
        500
      );
    }

    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.rotated", {
      tunnelKind: "server",
      tunnelDomain: safeHostname(grant.url),
      full,
    });
    return c.json({
      url: tunnelManager.getServerTunnelUrl(serverId) ?? grant.url,
      serverId,
      slug: grant.slug,
      secretVersion: grant.secretVersion,
    });
  });
});

// Get server-specific tunnel URL (in-memory bearer URL — this protected
// route is how the UI re-shows the full URL after a reload; the persisted
// record never contains the secret).
tunnels.get("/server/:serverId", async (c) => {
  const serverId = c.req.param("serverId");
  const url = tunnelManager.getServerTunnelUrl(serverId);

  if (!url) {
    return c.json({ error: "No tunnel found" }, 404);
  }

  return c.json({ url, serverId });
});

// Recent requests that arrived through this server's tunnel (for the UI's
// observability panel). Session-auth protected like the rest of /tunnels.
tunnels.get("/requests/:serverId", async (c) => {
  const serverId = c.req.param("serverId");
  return c.json({ serverId, requests: getTunnelRequests(serverId) });
});

// Close a server-specific tunnel
tunnels.delete("/server/:serverId", async (c) => {
  const authHeader = c.req.header("authorization");
  const serverId = c.req.param("serverId");

  return withTunnelLock(serverId, async () => {
    try {
      await tunnelManager.closeTunnel(serverId);
      // Backend marks the row closed and has the edge deny the grant; the
      // slug is kept so the URL stays stable when the tunnel is recreated.
      await reportTunnelClosure(serverId, authHeader);
      // The observability panel describes the closed connection — drop it
      // so a future tunnel for this server starts with a clean history.
      clearTunnelRequests(serverId);
      return c.json({ success: true, serverId });
    } catch (error: any) {
      logger.error("Error closing server-specific tunnel", error, { serverId });
      return c.json(
        {
          error: error.message || "Failed to close server-specific tunnel",
        },
        500
      );
    }
  });
});

export default tunnels;
