export async function listTools(serverId: string) {
  const res = await fetch("/api/mcp/tools/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
  });
  if (!res.ok) throw new Error(`List tools failed (${res.status})`);
  return res.json();
}

export async function executeToolApi(
  serverId: string,
  toolName: string,
  parameters: Record<string, any>,
) {
  const res = await fetch("/api/mcp/tools/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, toolName, parameters }),
  });
  if (!res.ok) throw new Error(`Execute tool failed (${res.status})`);
  return res.json();
}

export async function respondToElicitationApi(
  requestId: string,
  response: any,
) {
  const res = await fetch("/api/mcp/tools/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
  });
  if (!res.ok) throw new Error(`Respond failed (${res.status})`);
  return res.json();
}
