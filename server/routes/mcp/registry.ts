import { Hono } from "hono";

const registry = new Hono();

const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1";

// Helper to get registry headers with optional auth forwarding
function getRegistryHeaders(authHeader?: string): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }
  return headers;
}

// List all servers with pagination
registry.get("/servers", async (c) => {
  try {
    const limit = c.req.query("limit") || "50";
    const cursor = c.req.query("cursor");
    const registryUrl = c.req.query("registryUrl") || DEFAULT_REGISTRY_URL;

    let url = `${registryUrl}/servers?limit=${limit}`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    // Forward auth header if present
    const authHeader = c.req.header("Authorization");
    const response = await fetch(url, {
      headers: getRegistryHeaders(authHeader),
    });

    // Handle 401 - return auth challenge info for OAuth flow
    if (response.status === 401) {
      const wwwAuthenticate = response.headers.get("WWW-Authenticate");
      return c.json(
        {
          requiresAuth: true,
          wwwAuthenticate,
          registryUrl,
        },
        401,
      );
    }

    if (!response.ok) {
      throw new Error(`Registry API returned ${response.status}`);
    }

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error("Error fetching registry servers:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get all versions for a specific server
registry.get("/servers/:serverName/versions", async (c) => {
  try {
    const serverName = c.req.param("serverName");
    const registryUrl = c.req.query("registryUrl") || DEFAULT_REGISTRY_URL;
    const encodedName = encodeURIComponent(serverName);

    const url = `${registryUrl}/servers/${encodedName}/versions`;
    const authHeader = c.req.header("Authorization");
    const response = await fetch(url, {
      headers: getRegistryHeaders(authHeader),
    });

    if (response.status === 401) {
      const wwwAuthenticate = response.headers.get("WWW-Authenticate");
      return c.json(
        {
          requiresAuth: true,
          wwwAuthenticate,
          registryUrl,
        },
        401,
      );
    }

    if (!response.ok) {
      throw new Error(`Registry API returned ${response.status}`);
    }

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error("Error fetching server versions:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get specific version of a server
registry.get("/servers/:serverName/versions/:version", async (c) => {
  try {
    const serverName = c.req.param("serverName");
    const version = c.req.param("version");
    const registryUrl = c.req.query("registryUrl") || DEFAULT_REGISTRY_URL;
    const encodedName = encodeURIComponent(serverName);
    const encodedVersion = encodeURIComponent(version);

    const url = `${registryUrl}/servers/${encodedName}/versions/${encodedVersion}`;
    const authHeader = c.req.header("Authorization");
    const response = await fetch(url, {
      headers: getRegistryHeaders(authHeader),
    });

    if (response.status === 401) {
      const wwwAuthenticate = response.headers.get("WWW-Authenticate");
      return c.json(
        {
          requiresAuth: true,
          wwwAuthenticate,
          registryUrl,
        },
        401,
      );
    }

    if (!response.ok) {
      throw new Error(`Registry API returned ${response.status}`);
    }

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error("Error fetching server version:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default registry;
