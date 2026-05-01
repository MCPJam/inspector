import { Hono } from "hono";
import type { Context } from "hono";
import { tunnelManager } from "../../services/tunnel-manager";
import { LOCAL_SERVER_ADDR } from "../../config";
import { cleanupOrphanedTunnels } from "../../services/tunnel-cleanup";
import "../../types/hono";
import { logger } from "../../utils/logger";
import { getRequestLogger } from "../../utils/request-logger";
import { classifyTunnelError } from "../../utils/error-classify";

const tunnels = new Hono();

// Fetch ngrok token from Convex backend
async function fetchNgrokToken(authHeader?: string): Promise<{
  token: string;
  credentialId: string;
  domain: string;
  domainId: string;
}> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_HTTP_URL not configured");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const response = await fetch(`${convexUrl}/tunnels/token`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || "Failed to fetch ngrok token");
  }

  const data = (await response.json()) as {
    ok?: boolean;
    token?: string;
    credentialId?: string;
    domain?: string;
    domainId?: string;
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

  return {
    token: data.token,
    credentialId: data.credentialId,
    domain: data.domain,
    domainId: data.domainId,
  };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// Report tunnel creation to Convex backend
async function recordTunnel(
  serverId: string,
  url: string,
  credentialId?: string,
  domainId?: string,
  domain?: string,
  authHeader?: string,
  c?: Context,
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    logger.warn("CONVEX_HTTP_URL not configured, skipping tunnel recording");
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  try {
    await fetch(`${convexUrl}/tunnels/record`, {
      method: "POST",
      headers,
      body: JSON.stringify({ serverId, url, credentialId, domainId, domain }),
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

// Report tunnel closure to Convex backend
async function reportTunnelClosure(
  serverId: string,
  authHeader?: string,
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  try {
    await fetch(`${convexUrl}/tunnels/close`, {
      method: "POST",
      headers,
      body: JSON.stringify({ serverId }),
    });
  } catch (error) {
    logger.error("Failed to report tunnel closure", error, { serverId });
  }
}

// Cleanup ngrok credential and domain
async function cleanupCredential(
  credentialId: string,
  domainId?: string,
  authHeader?: string,
): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  try {
    await fetch(`${convexUrl}/tunnels/cleanup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ credentialId, domainId }),
    });
  } catch (error) {
    logger.error("Failed to cleanup credential", error, {
      credentialId,
      domainId,
    });
  }
}

// Create a shared tunnel
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

    const { token, credentialId, domain, domainId } =
      await fetchNgrokToken(authHeader);
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
      c,
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
      500,
    );
  }
});

// Create a server-specific tunnel
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

    const { token, credentialId, domain, domainId } =
      await fetchNgrokToken(authHeader);
    const baseUrl = await tunnelManager.createTunnel(serverId, {
      localAddr: LOCAL_SERVER_ADDR,
      ngrokToken: token,
      credentialId,
      domainId,
      domain,
    });
    await recordTunnel(
      serverId,
      baseUrl,
      credentialId,
      domainId,
      domain,
      authHeader,
      c,
    );

    const serverTunnelUrl = tunnelManager.getServerTunnelUrl(serverId);
    if (!serverTunnelUrl) {
      throw new Error("Failed to build server tunnel URL");
    }

    getRequestLogger(c, "routes.mcp.tunnels").event("tunnel.created", {
      tunnelKind: "server",
      tunnelDomain: domain,
      existed: false,
      credentialIdPresent: !!credentialId,
    });
    return c.json({
      url: serverTunnelUrl,
      serverId,
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
      500,
    );
  }
});

// Get existing tunnel URL
tunnels.get("/", async (c) => {
  const url = tunnelManager.getTunnelUrl();

  if (!url) {
    return c.json({ error: "No tunnel found" }, 404);
  }

  return c.json({ url });
});

// Get server-specific tunnel URL
tunnels.get("/server/:serverId", async (c) => {
  const serverId = c.req.param("serverId");
  const url = tunnelManager.getServerTunnelUrl(serverId);

  if (!url) {
    return c.json({ error: "No tunnel found" }, 404);
  }

  return c.json({ url, serverId });
});

// Close the tunnel
tunnels.delete("/", async (c) => {
  const authHeader = c.req.header("authorization");

  try {
    const credentialId = tunnelManager.getCredentialId("shared");
    const domainId = tunnelManager.getDomainId("shared");

    await tunnelManager.closeTunnel("shared");
    await reportTunnelClosure("shared", authHeader);

    if (credentialId) {
      await cleanupCredential(credentialId, domainId || undefined, authHeader);
    }

    tunnelManager.clearCredentials("shared");
    return c.json({ success: true });
  } catch (error: any) {
    logger.error("Error closing tunnel", error);
    return c.json(
      {
        error: error.message || "Failed to close tunnel",
      },
      500,
    );
  }
});

// Close a server-specific tunnel
tunnels.delete("/server/:serverId", async (c) => {
  const authHeader = c.req.header("authorization");
  const serverId = c.req.param("serverId");

  try {
    const credentialId = tunnelManager.getCredentialId(serverId);
    const domainId = tunnelManager.getDomainId(serverId);

    await tunnelManager.closeTunnel(serverId);
    await reportTunnelClosure(serverId, authHeader);

    if (credentialId) {
      await cleanupCredential(credentialId, domainId || undefined, authHeader);
    }

    tunnelManager.clearCredentials(serverId);
    return c.json({ success: true, serverId });
  } catch (error: any) {
    logger.error("Error closing server-specific tunnel", error, { serverId });
    return c.json(
      {
        error: error.message || "Failed to close server-specific tunnel",
      },
      500,
    );
  }
});

// Cleanup all orphaned tunnels for the current user
tunnels.post("/cleanup-orphaned", async (c) => {
  const authHeader = c.req.header("authorization");

  try {
    await cleanupOrphanedTunnels(authHeader);
    return c.json({ success: true });
  } catch (error: any) {
    logger.error("Error cleaning up orphaned tunnels", error);
    return c.json(
      {
        error: error.message || "Failed to cleanup orphaned tunnels",
      },
      500,
    );
  }
});

export default tunnels;
