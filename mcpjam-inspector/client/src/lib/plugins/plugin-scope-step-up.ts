import { applyToolCallStepUp } from "@/state/oauth-orchestrator";
import type { OAuthResult } from "@/lib/oauth/mcp-oauth";
import type { PluginServerScopeChallenge } from "@/shared/plugin-server-unavailable";
import type { PluginServerSignInTarget } from "./plugin-sign-in";

/** Use the same scope union, discovery guards and redirect budget as other MCP requests. */
export async function startPluginScopeStepUp(
  target: PluginServerSignInTarget,
  serverName: string,
  challenge: PluginServerScopeChallenge,
  beforeRedirect: () => void,
): Promise<OAuthResult> {
  const result = await applyToolCallStepUp(
    {
      name: serverName,
      config: { url: target.serverUrl },
      useOAuth: true,
      registrationMode: target.registrationMode,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    },
    challenge,
    {
      originalScopes: target.scopes,
      operation: { method: "tools/list", operation: "plugin-discovery" },
      beforeRedirect,
    },
  );
  if (result.reauthorization?.kind === "redirect") return { success: true };
  return {
    success: false,
    error:
      (result.reauthorization?.kind === "error"
        ? result.reauthorization.error
        : undefined) ??
      "This server still needs permissions. Check its access settings and try again later.",
  };
}
