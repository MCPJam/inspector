import { Hono } from "hono";
import type { Context } from "hono";
import { tunnelManager } from "../../services/tunnel-manager";
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

interface NgrokTokenResponse {
  token: string;
  credentialId: string;
  domain: string;
  domainId: string;
  // Edge-security fields (present when the backend provisioned a
  // per-server tunnel): bearer URL with ?k= secret, the Traffic Policy to
  // bind at listen time, and rotation bookkeeping.
  secret?: string;
  secretVersion?: number;
  url?: string;
  trafficPolicy?: string;
  secretHash?: string;
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

// Fetch ngrok token from Convex backend. Passing a serverId makes the
// backend reuse this user+server's persistent reserved domain and return
// the edge-enforcement material (secret-bearing URL + Traffic Policy).
async function fetchNgrokToken(
  authHeader?: string,
  serverId?: string
): Promise<NgrokTokenResponse> {
  const convexUrl = requireConvexUrl();

  const tokenUrl = serverId
    ? `${convexUrl}/tunnels/token?serverId=${encodeURIComponent(serverId)}`
    : `${convexUrl}/tunnels/token`;

  const response = await fetch(tokenUrl, {
    method: "GET",
    headers: convexHeaders(authHeader),
  });

  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || "Failed to fetch ngrok token");
  }

  const data = (await response.json()) as Partial<NgrokTokenResponse> & {
    ok?: boolean;
  };
  if (
    !data.ok ||
    !data.token ||
    !data.credentialId ||
    !data.domain ||
    !data.domainId
  ) {
    throw new Error("Invalid response from tunnel service");
  }

  return data as NgrokTokenResponse;
}

// Stage a secret rotation with the Convex backend (phase A of the
// two-phase rotation; the commit happens via recordTunnel after the local
// listener is re-established with the new policy).
async function stageRotation(
  serverId: string,
  full: boolean,
  authHeader?: string
): Promise<NgrokTokenResponse> {
  const convexUrl = requireConvexUrl();

  const response = await fetch(`${convexUrl}/tunnels/rotate`, {
    method: "POST",
    headers: convexHeaders(authHeader),
    body: JSON.stringify({ serverId, full }),
  });

  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || "Failed to rotate tunnel");
  }

  const data = (await response.json()) as Partial<NgrokTokenResponse> & {
    ok?: boolean;
  };
  if (
    !data.ok ||
    !data.token ||
    !data.credentialId ||
    !data.domain ||
    !data.domainId
  ) {
    throw new Error("Invalid response from tunnel service");
  }

  return data as NgrokTokenResponse;
}

// Abort a staged rotation whose local re-listen failed so the backend can
// revoke the pending credential and surface an explicit error state.
async function reportRotationFailed(
  serverId: string,
  errorMessage: string,
  authHeader?: string
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return;
  }
  try {
    await fetch(`${convexUrl}/tunnels/rotate-failed`, {
      method: "POST",
      headers: convexHeaders(authHeader),
      body: JSON.stringify({ serverId, errorMessage }),
    });
  } catch (error) {
    logger.error("Failed to report rotation failure", error, { serverId });
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// The secret-less base URL is the only shape ever reported for
// persistence; the bearer URL stays in tunnel-manager memory.
function stripBearerSecret(url: string): string {
  return url.split("?")[0];
}

// Report tunnel state to Convex backend (also the phase-B commit of a
// rotation when secretHash/secretVersion are present).
async function recordTunnel(
  serverId: string,
  url: string,
  credentialId?: string,
  domainId?: string,
  domain?: string,
  authHeader?: string,
  c?: Context,
  secretHash?: string,
  secretVersion?: number
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    logger.warn("CONVEX_HTTP_URL not configured, skipping tunnel recording");
    return;
  }

  try {
    await fetch(`${convexUrl}/tunnels/record`, {
      method: "POST",
      headers: convexHeaders(authHeader),
      body: JSON.stringify({
        serverId,
        url: stripBearerSecret(url),
        credentialId,
        domainId,
        domain,
        secretHash,
        secretVersion,
      }),
    });
  } catch (error) {
    const tunnelKind = serverId === "shared" ? "shared" : "server";
    if (c) {
      getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.record_failed", {
        tunnelKind,
        tunnelDomain: domain,
        errorCode: classifyTunnelError(error, "convex_record_failed"),
      });
    }
    logger.error("Failed to record tunnel", error, { serverId, url });
    // Don't throw - tunnel is already created, just log the error
  }
}

// Report tunnel closure to Convex backend (which also revokes the
// tunnel's ngrok credentials; the reserved domain is kept for reuse).
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

// Create a shared tunnel (legacy whole-app tunnel; no per-server scoping)
tunnels.post("/create", async (c) => {
  const authHeader = c.req.header("authorization");

  try {
    // Check if tunnel already exists
    const existingUrl = tunnelManager.getTunnelUrl();
    if (existingUrl) {
      getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.created", {
        tunnelKind: "shared",
        tunnelDomain: safeHostname(existingUrl),
        existed: true,
      });
      return c.json({
        url: existingUrl,
        existed: true,
      });
    }

    const { token, credentialId, domain, domainId } = await fetchNgrokToken(
      authHeader
    );
    const url = await tunnelManager.createTunnel("shared", {
      localAddr: LOCAL_SERVER_ADDR,
      ngrokToken: token,
      credentialId,
      domainId,
      domain,
    });
    await recordTunnel(
      "shared",
      url,
      credentialId,
      domainId,
      domain,
      authHeader,
      c
    );

    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.created", {
      tunnelKind: "shared",
      tunnelDomain: domain,
      existed: false,
      credentialIdPresent: !!credentialId,
    });
    return c.json({
      url,
      existed: false,
    });
  } catch (error: any) {
    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.creation_failed", {
      tunnelKind: "shared",
      errorCode: classifyTunnelError(error),
    });
    logger.error("Error creating tunnel", error);
    return c.json(
      {
        error: error.message || "Failed to create tunnel",
      },
      500
    );
  }
});

// Create a server-specific tunnel, secured at the ngrok edge: the bearer
// secret in the returned URL and the per-server path scope are enforced by
// the Traffic Policy bound at listen time.
tunnels.post("/create/:serverId", async (c) => {
  const authHeader = c.req.header("authorization");
  const serverId = c.req.param("serverId");

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

    const data = await fetchNgrokToken(authHeader, serverId);
    const baseUrl = await tunnelManager.createTunnel(serverId, {
      localAddr: LOCAL_SERVER_ADDR,
      ngrokToken: data.token,
      credentialId: data.credentialId,
      domainId: data.domainId,
      domain: data.domain,
      trafficPolicy: data.trafficPolicy,
      publicUrl: data.url,
      secretVersion: data.secretVersion,
    });
    await recordTunnel(
      serverId,
      data.url ?? baseUrl,
      data.credentialId,
      data.domainId,
      data.domain,
      authHeader,
      c,
      data.secretHash,
      data.secretVersion
    );

    const serverTunnelUrl = tunnelManager.getServerTunnelUrl(serverId);
    if (!serverTunnelUrl) {
      throw new Error("Failed to build server tunnel URL");
    }

    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.created", {
      tunnelKind: "server",
      tunnelDomain: data.domain,
      existed: false,
      credentialIdPresent: !!data.credentialId,
    });
    return c.json({
      url: serverTunnelUrl,
      serverId,
      domain: data.domain,
      secretVersion: data.secretVersion,
      existed: false,
    });
  } catch (error: any) {
    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.creation_failed", {
      tunnelKind: "server",
      errorCode: classifyTunnelError(error),
    });
    logger.error("Error creating server-specific tunnel", error, { serverId });
    return c.json(
      {
        error: error.message || "Failed to create server-specific tunnel",
      },
      500
    );
  }
});

// Rotate a server tunnel's bearer secret (two-phase). The base domain is
// stable; only the ?k= secret (and agent credential) change. `full: true`
// additionally swaps the reserved domain — a rare escape hatch.
tunnels.post("/rotate/:serverId", async (c) => {
  const authHeader = c.req.header("authorization");
  const serverId = c.req.param("serverId");

  let full = false;
  try {
    const body = await c.req.json();
    full = body?.full === true;
  } catch {}

  let data: NgrokTokenResponse;
  try {
    // Phase A: backend mints the new secret/credential as PENDING state.
    data = await stageRotation(serverId, full, authHeader);
  } catch (error: any) {
    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.rotation_failed", {
      tunnelKind: "server",
      errorCode: classifyTunnelError(error),
    });
    logger.error("Error staging tunnel rotation", error, { serverId });
    return c.json({ error: error.message || "Failed to rotate tunnel" }, 500);
  }

  try {
    // Re-listen with the new authtoken + traffic policy. The old secret
    // dies here: the previous listener is closed before the new one binds.
    await tunnelManager.rotateTunnel(serverId, {
      localAddr: LOCAL_SERVER_ADDR,
      ngrokToken: data.token,
      credentialId: data.credentialId,
      domainId: data.domainId,
      domain: data.domain,
      trafficPolicy: data.trafficPolicy,
      publicUrl: data.url,
      secretVersion: data.secretVersion,
    });
  } catch (error: any) {
    // Phase B (abort): land in an explicit error state; the backend
    // revokes the pending credential.
    await reportRotationFailed(
      serverId,
      error?.message || "Failed to re-establish tunnel listener",
      authHeader
    );
    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.rotation_failed", {
      tunnelKind: "server",
      errorCode: classifyTunnelError(error),
      tunnelDomain: data.domain,
    });
    logger.error("Error re-establishing rotated tunnel", error, { serverId });
    return c.json(
      { error: error.message || "Failed to re-establish rotated tunnel" },
      500
    );
  }

  // Phase B (commit): promote the pending secret/credential to active;
  // the backend revokes the superseded credential.
  await recordTunnel(
    serverId,
    data.url ?? `https://${data.domain}`,
    data.credentialId,
    data.domainId,
    data.domain,
    authHeader,
    c,
    data.secretHash,
    data.secretVersion
  );

  getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.rotated", {
    tunnelKind: "server",
    tunnelDomain: data.domain,
    full,
  });
  return c.json({
    url: tunnelManager.getServerTunnelUrl(serverId) ?? data.url,
    serverId,
    domain: data.domain,
    secretVersion: data.secretVersion,
  });
});

// Get existing tunnel URL
tunnels.get("/", async (c) => {
  const url = tunnelManager.getTunnelUrl();

  if (!url) {
    return c.json({ error: "No tunnel found" }, 404);
  }

  return c.json({ url });
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

// Close the tunnel
tunnels.delete("/", async (c) => {
  const authHeader = c.req.header("authorization");

  try {
    await tunnelManager.closeTunnel("shared");
    // Backend revokes the tunnel's credentials; the domain is kept.
    await reportTunnelClosure("shared", authHeader);
    tunnelManager.clearCredentials("shared");
    return c.json({ success: true });
  } catch (error: any) {
    logger.error("Error closing tunnel", error);
    return c.json(
      {
        error: error.message || "Failed to close tunnel",
      },
      500
    );
  }
});

// Close a server-specific tunnel
tunnels.delete("/server/:serverId", async (c) => {
  const authHeader = c.req.header("authorization");
  const serverId = c.req.param("serverId");

  try {
    await tunnelManager.closeTunnel(serverId);
    // Backend revokes the tunnel's credentials; the domain is kept so the
    // URL stays stable when the tunnel is recreated.
    await reportTunnelClosure(serverId, authHeader);
    tunnelManager.clearCredentials(serverId);
    // The observability panel describes the closed listener — drop it so a
    // future tunnel for this server starts with a clean history.
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

export default tunnels;
