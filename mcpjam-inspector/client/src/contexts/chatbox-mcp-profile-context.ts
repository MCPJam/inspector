import { createContext, useContext } from "react";
import type { HostConfigMcpProfileV1 } from "@/lib/host-config-v2";

/**
 * Per-scope MCP profile envelope (clientInfo, supported protocol
 * versions, MCP Apps sandbox policy).
 *
 * Mirrors the shape of {@link chatbox-host-capabilities-override-context}:
 * one Provider per scope (chatbox, eval suite, direct chat) sets the
 * value resolved from the active hostConfig DTO. Consumers read via
 * {@link useChatboxMcpProfile} and treat `undefined` as
 * "SDK defaults / no host-level sandbox override" — same semantics as
 * the backend storage (`undefined` is a distinct canonical hash from
 * `{ profileVersion: 1 }`).
 *
 * Kept separate from `hostContext` and `hostCapabilitiesOverride`
 * because mcpProfile carries host **identity** and **sandbox policy**,
 * not vendor capability traits or per-resource environment data. A
 * single Provider per scope lets the sandbox-policy resolver and the
 * upstream MCP client wiring read from the same source without
 * threading the profile through every intermediate component.
 */
const ChatboxMcpProfileContext = createContext<
  HostConfigMcpProfileV1 | undefined
>(undefined);

export const ChatboxMcpProfileProvider = ChatboxMcpProfileContext.Provider;

export function useChatboxMcpProfile(): HostConfigMcpProfileV1 | undefined {
  return useContext(ChatboxMcpProfileContext);
}
