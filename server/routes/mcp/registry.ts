import { Hono } from "hono";

const registry = new Hono();

const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io/v0.1";

// List all servers with pagination
registry.get("/servers", async (c) => {
  try {
    const limit = c.req.query("limit") || "50";
    const cursor = c.req.query("cursor");

    let url = `${REGISTRY_BASE_URL}/servers?limit=${limit}`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const response = await fetch(url);
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
    const encodedName = encodeURIComponent(serverName);

    const url = `${REGISTRY_BASE_URL}/servers/${encodedName}/versions`;
    const response = await fetch(url);

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
    const encodedName = encodeURIComponent(serverName);
    const encodedVersion = encodeURIComponent(version);

    const url = `${REGISTRY_BASE_URL}/servers/${encodedName}/versions/${encodedVersion}`;
    const response = await fetch(url);

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
