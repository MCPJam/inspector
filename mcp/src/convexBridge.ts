type BridgeErrorBody = {
  error?: string;
  message?: string;
};

const MCP_BRIDGE_PREFIX = "/web/mcp";

async function fetchBridgeJson<T>(
  convexHttpUrl: string,
  path: string,
  bearerToken: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${convexHttpUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(body ?? {}),
  });

  let payload: T | BridgeErrorBody | null = null;
  try {
    payload = (await response.json()) as T | BridgeErrorBody;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      typeof (payload as BridgeErrorBody | null)?.error === "string"
        ? (payload as BridgeErrorBody).error
        : typeof (payload as BridgeErrorBody | null)?.message === "string"
          ? (payload as BridgeErrorBody).message
          : `Bridge request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

export async function fetchMcpWhoAmI(
  convexHttpUrl: string,
  bearerToken: string,
): Promise<{
  ok: true;
  userId: string;
  user: unknown;
}> {
  return await fetchBridgeJson(
    convexHttpUrl,
    `${MCP_BRIDGE_PREFIX}/me`,
    bearerToken,
  );
}

export async function fetchMcpWorkspaces(
  convexHttpUrl: string,
  bearerToken: string,
  organizationId: string,
): Promise<{
  ok: true;
  workspaces: unknown[];
}> {
  return await fetchBridgeJson(
    convexHttpUrl,
    `${MCP_BRIDGE_PREFIX}/workspaces`,
    bearerToken,
    {
      organizationId,
    },
  );
}

export async function fetchMcpWorkspaceServers(
  convexHttpUrl: string,
  bearerToken: string,
  workspaceId: string,
): Promise<{
  ok: true;
  servers: unknown[];
}> {
  return await fetchBridgeJson(
    convexHttpUrl,
    `${MCP_BRIDGE_PREFIX}/workspace-servers`,
    bearerToken,
    {
      workspaceId,
    },
  );
}
