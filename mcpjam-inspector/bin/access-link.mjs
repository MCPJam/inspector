import { randomBytes } from "node:crypto";

export function createLaunchToken(env = process.env) {
  if (env.VITE_MCPJAM_HOSTED_MODE === "true") return undefined;
  const token =
    env.MCPJAM_SESSION_TOKEN ?? randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{24,}$/.test(token))
    throw new Error(
      "MCPJAM_SESSION_TOKEN must contain at least 24 URL-safe letters, digits, underscores or hyphens",
    );
  return token;
}
export function createAccessLink(base, token, tab) {
  const url = new URL(base);
  if (token)
    url.hash = new URLSearchParams({
      token,
      ...(tab ? { tab } : {}),
    }).toString();
  else if (tab) url.hash = tab;
  return url.href;
}
export function networkAccessLinks(base, token, allowedHosts = "", tab) {
  return allowedHosts
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host && !host.includes("*"))
    .flatMap((host) => {
      try {
        // Configuration names hosts, not schemes, paths or credentials.
        const authority = new URL(`http://${host}`);
        if (
          authority.username ||
          authority.password ||
          authority.pathname !== "/" ||
          authority.search ||
          authority.hash
        )
          return [];
        const url = new URL(base);
        url.hostname = authority.hostname;
        if (authority.port) url.port = authority.port;
        return [createAccessLink(url.href, token, tab)];
      } catch {
        return [];
      }
    });
}

/** CLI-owned launches open their own link; redirected launcher logs stay credential-free. */
export function shouldPrintAccessLink(token, env = process.env) {
  return Boolean(token) && env.MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN !== "1";
}
