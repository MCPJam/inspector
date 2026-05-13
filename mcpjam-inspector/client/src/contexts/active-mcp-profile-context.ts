import { createContext, useContext } from "react";
import type { HostConfigMcpProfileV1 } from "@/lib/host-config-v2";

/**
 * Per-scope active `mcpProfile` envelope. Mirrors
 * {@link ChatboxHostCapabilitiesOverrideContext} — a single Provider sets
 * the value for whatever scope owns the host config (chatbox, eval suite,
 * project default), and downstream consumers read via
 * {@link useActiveMcpProfile}.
 *
 * Why a Context (and not the host-context store): mcpProfile is a strict
 * `HostConfigInputV2`/`HostConfigDtoV2` field — it's the persistent host
 * identity / sandbox policy, not the per-resource environment the UI
 * Playground tweaks. Two providers exist:
 *
 *   - **Hosted-chat flow** (ChatboxChatPage): provides
 *     `session.payload.mcpProfile` decoded from the redeem response.
 *   - **In-inspector flows** (project default, eval suite): provide the
 *     `projectDefaultDto.mcpProfile` (or chatbox/suite-specific DTO) so
 *     in-inspector connections honor the same pin as hosted runs.
 *
 * Consumers:
 *   - `use-server-state` → `buildResolverConnectionDefaults(serverConfig,
 *     activeMcpProfile)` to forward `initialize.clientInfo` /
 *     `supportedProtocolVersions` on /api/mcp/connect.
 *   - `mcp-apps-renderer` / ChatGPT-app renderer → pass
 *     `profile.apps.sandbox.csp` and `.permissions` into the shared
 *     `resolveSandboxCsp` / `resolveSandboxPermissions` from
 *     `@mcpjam/sdk`.
 *
 * `undefined` (the default) means "use SDK defaults / resource-declared
 * sandbox policy" — preserves historical behavior for users who haven't
 * opted into the mcpProfile feature.
 */
const ActiveMcpProfileContext = createContext<
  HostConfigMcpProfileV1 | undefined
>(undefined);

export const ActiveMcpProfileProvider = ActiveMcpProfileContext.Provider;

export function useActiveMcpProfile(): HostConfigMcpProfileV1 | undefined {
  return useContext(ActiveMcpProfileContext);
}
