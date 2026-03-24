import { authFetch } from "@/lib/session-token";
import { exportHostedServer } from "@/lib/apis/web/export-api";
import { runByMode } from "@/lib/apis/mode-client";

export async function exportServerApi(serverId: string) {
  return runByMode({
    hosted: () => exportHostedServer(serverId),
    local: async () => {
      const res = await authFetch("/api/mcp/export/server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      if (!res.ok) {
        let message = `Export failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {}
        throw new Error(message);
      }
      return res.json();
    },
  });
}
