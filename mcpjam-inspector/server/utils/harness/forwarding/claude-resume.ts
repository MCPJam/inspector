import type { HarnessV1 } from "@ai-sdk/harness";

import type { HarnessMcpJson } from "../mcp-config.js";
import { withForwardingResume } from "./bridge-refresh.js";
import { MAX_SEALED_PLAINTEXT_BYTES } from "../harness-proxy-limits.js";
const marker = "mcpjamRefreshNativeMcp";

/** Refresh the paused query without changing its prompt, replay cursor or tools. */
export function patchClaudeForwardingResume(source: string): string {
  if (source.includes(`var ${marker};`)) return source;
  const turn = "async function runTurn(start, turn) {";
  const control = '      case "abort":';
  const queryEnd = "  gracefulAbort = () => {";
  const cleanup = "    gracefulAbort = void 0;";
  if (
    ![turn, control, queryEnd, cleanup].every((needle) =>
      source.includes(needle),
    )
  )
    throw new Error(
      "Claude bridge does not support forwarding configuration refresh.",
    );
  return source
    .replace(turn, `var ${marker};\n${turn}`)
    .replace(
      control,
      `      case "mcpjam-refresh-mcp": {
        let ok = false;
        try {
          if (typeof msg.id !== "string" || msg.id.length > 64 || !${marker}) throw new Error("Unavailable");
          await ${marker}(msg.servers);
          ok = true;
        } catch {
          // The host receives a refusal; do not leak configuration or resume.
          ok = false;
        }
        sendControl(ws, { type: "mcpjam-mcp-refreshed", id: msg.id, ok });
        return;
      }
${control}`,
    )
    .replace(
      queryEnd,
      `  const refreshNativeMcp = async (servers) => {
    const keys = Object.keys(start.mcpServers ?? {}).sort();
    if (!servers || typeof servers !== "object" || Array.isArray(servers) ||
        JSON.stringify(Object.keys(servers).sort()) !== JSON.stringify(keys)) throw new Error("Server set changed");
    const refreshed = { ...mcpServers };
    for (const key of keys) {
      const entry = servers[key];
      const prior = start.mcpServers[key];
      if (entry?.type !== "http" || entry.url !== prior.url ||
          !entry.headers || Object.keys(entry.headers).length !== 2 ||
          entry.headers.Connection !== "close" ||
          typeof entry.headers["X-MCPJam-Forwarding-Context"] !== "string" ||
          entry.headers["X-MCPJam-Forwarding-Context"].length > ${2 * MAX_SEALED_PLAINTEXT_BYTES}) throw new Error("Invalid forwarding configuration");
      refreshed[key] = { ...prior, headers: entry.headers };
    }
    const result = await q.setMcpServers(refreshed);
    if (Object.keys(result.errors ?? {}).length) throw new Error("MCP refresh failed");
    Object.assign(mcpServers, refreshed);
  };
  ${marker} = refreshNativeMcp;
${queryEnd}`,
    )
    .replace(
      cleanup,
      `${cleanup}\n    if (${marker} === refreshNativeMcp) ${marker} = void 0;`,
    );
}


export function withClaudeForwardingResume<T extends HarnessV1>(
  harness: T, servers: HarnessMcpJson["mcpServers"], policyDigest: string,
): T {
  return withForwardingResume(harness, servers, policyDigest, patchClaudeForwardingResume);
}
