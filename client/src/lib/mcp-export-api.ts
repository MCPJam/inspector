import { withProxyAuth } from "./proxy-auth";

export async function exportServerApi(serverId: string) {
  const res = await fetch(
    "/api/mcp/export/server",
    withProxyAuth({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId }),
    }),
  );
  if (!res.ok) {
    let message = `Export failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}
