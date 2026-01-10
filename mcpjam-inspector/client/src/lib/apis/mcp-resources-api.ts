export type ListResourcesResult = {
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  nextCursor?: string;
};

export async function listResources(
  serverId: string,
  cursor?: string,
): Promise<ListResourcesResult> {
  const res = await fetch("/api/mcp/resources/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, cursor }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(body?.error || `List resources failed (${res.status})`);
  }

  return {
    resources: body.resources || [],
    nextCursor: body.nextCursor,
  };
}

export async function readResource(serverId: string, uri: string) {
  const response = await fetch(`/api/mcp/resources/read`, {
    method: "POST",
    body: JSON.stringify({ serverId, uri }),
  });
  return response.json();
}
