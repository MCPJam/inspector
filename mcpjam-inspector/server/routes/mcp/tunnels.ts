import { Hono } from "hono";
import { tunnelManager } from "../../services/tunnel-manager";
import { LOCAL_SERVER_ADDR } from "../../config";
import { cleanupOrphanedTunnels } from "../../services/tunnel-cleanup";
import "../../types/hono";
import { logger } from "../../utils/logger";

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

// Report tunnel creation to Convex backend
async function recordTunnel(
  serverId: string,
  url: string,
  credentialId?: string,
  domainId?: string,
  domain?: string,
  authHeader?: string,
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
      return c.json({
        url: existingUrl,
        existed: true,
      });
    }

    const { token, credentialId, domain, domainId } =
      await fetchNgrokToken(authHeader);
    tunnelManager.setNgrokToken(token, credentialId, domainId, domain);

    const url = await tunnelManager.createTunnel(LOCAL_SERVER_ADDR);
    await recordTunnel(
      "shared",
      url,
      credentialId,
      domainId,
      domain,
      authHeader,
    );

    return c.json({
      url,
      existed: false,
    });
  } catch (error: any) {
    logger.error("Error creating tunnel", error);
    return c.json(
      {
        error: error.message || "Failed to create tunnel",
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
    const credentialId = tunnelManager.getCredentialId();
    const domainId = tunnelManager.getDomainId();

    await tunnelManager.closeTunnel();
    await reportTunnelClosure("shared", authHeader);

    if (credentialId) {
      await cleanupCredential(credentialId, domainId || undefined, authHeader);
    }

    tunnelManager.clearCredentials();
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
