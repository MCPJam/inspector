/**
 * `MCPJAM_PLATFORM_AGENT=off` turns the MCPJam agent ("Ask MCPJam") off for
 * this deployment. The agent dials MCPJam's own MCP servers — the platform
 * worker at `mcp.mcpjam.com` and the hosted docs servers — which a
 * self-hosted install cannot reach. Off, its routes refuse before any of that
 * runs (`platformAgentGate`), the boot check stops vetting the worker URL it
 * will never dial, and the browser, told through the runtime config, hides
 * the agent. Any other value, or none, keeps the agent as it is.
 *
 * Read at call time, like `DO_NOT_TRACK`: `.env` files load after imports.
 */
export function isPlatformAgentEnabled(): boolean {
  return process.env.MCPJAM_PLATFORM_AGENT !== "off";
}
