export async function readResource(serverId: string, uri: string) {
  const response = await fetch(`/api/mcp/resources/read`, {
    method: "POST",
    body: JSON.stringify({ serverId, uri }),
  });
  return response.json();
}
