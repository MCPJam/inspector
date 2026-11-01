import { usesMcpjamClient } from "@/shared/harness-descriptors";
/**
 * Extension operations need the saved-server authority of the existing web
 * route. A Codex harness turn takes it too: its MCP tools run on the server
 * (host-executed delivery), so the web route answers its servers' forms on
 * the composer card and owns its App results. The server still decides
 * whether the turn runs on this machine, exactly as the local route does.
 * A harness whose runtime calls MCP itself keeps its existing route.
 */
export function shouldUseOwnedExtensionModelRoute(input: {
  flag: boolean;
  admitted: boolean;
  /** The client's OpenAI plugin extensions master switch (C1). */
  extensionsEnabled: boolean;
  harness?: string;
  agentLoop?: string;
  hostId?: string | null;
  actorId?: string | null;
}): boolean {
  return input.flag && input.admitted && input.extensionsEnabled &&
    usesMcpjamClient(input) &&
    !!input.hostId && !!input.actorId;
}
