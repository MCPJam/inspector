import type { ServerCapabilities } from "@modelcontextprotocol/server";

export const MODERN_REVISION = "2026-07-28";
const LEGACY_REVISIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

/**
 * The protocol revision one request is served under. 2026-07-28 traffic is
 * known by its era. A 2025-era request names its revision in the
 * `MCP-Protocol-Version` header, except the `initialize` that negotiates it
 * (the body carries the client's wish) and a 2025-03-26 client that sends no
 * header. A revision this mock does not know is answered with the newest 2025
 * one, as the server SDK does.
 */
export async function revisionOf(
  era: "legacy" | "modern",
  request: Request | undefined
): Promise<string> {
  if (era === "modern") return MODERN_REVISION;
  const header = request?.headers.get("mcp-protocol-version");
  let named = header ?? undefined;
  if (named === undefined && request?.method === "POST") {
    try {
      const body: unknown = await request.clone().json();
      const params =
        typeof body === "object" && body !== null
          ? (body as { params?: { protocolVersion?: unknown } }).params
          : undefined;
      if (typeof params?.protocolVersion === "string") {
        named = params.protocolVersion;
      }
    } catch {
      // A body that is not JSON is the server SDK's to refuse; serve as the oldest revision.
      return "2025-03-26";
    }
  }
  if (named === undefined) return "2025-03-26";
  return LEGACY_REVISIONS.includes(named) ? named : "2025-11-25";
}

/**
 * Keeps only the capabilities a revision defines: `tasks` is the 2025-11-25
 * utility (2026-07-28 carries tasks in `extensions`). `extensions` is a
 * 2026-07-28 field; a 2025-era revision shows only what the real server
 * itself declared there.
 */
export function capabilitiesForRevision(
  capabilities: ServerCapabilities,
  revision: string
): ServerCapabilities {
  const kept = { ...capabilities };
  if (revision !== "2025-11-25") delete kept.tasks;
  return kept;
}
