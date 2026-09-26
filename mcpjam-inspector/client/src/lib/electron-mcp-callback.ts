export function buildElectronMcpCallbackUrl(): string | null {
  if (window.isElectron || window.location.pathname !== "/oauth/callback") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  if (!params.get("code") && !params.get("error")) {
    return null;
  }

  // Electron-started MCP OAuth explicitly tags the state parameter so the
  // browser callback can hand control back to the desktop app without relying
  // on browser-local storage heuristics.
  if (!params.get("state")?.startsWith("electron_mcp:")) {
    return null;
  }

  const callbackUrl = new URL("mcpjam://oauth/callback");
  callbackUrl.searchParams.set("flow", "mcp");

  for (const [key, value] of params.entries()) {
    callbackUrl.searchParams.append(key, value);
  }

  return callbackUrl.toString();
}
