import { isPrivateNetworkUrl } from "@/shared/private-address";

/**
 * What the hosted web app can tell about a server input before it submits.
 *
 * The hosted backend runs in the cloud: it cannot start a local command and
 * cannot reach this computer's loopback, so those inputs are refused here with
 * a way forward instead of failing a connect. Private network addresses only
 * warn, because a tunnel or VPN can make them reachable.
 */
export type HostedInputCheck =
  | { kind: "ok" }
  | { kind: "blocked"; reason: "stdio" | "localhost"; copyCommand: string }
  | { kind: "private_network" };

export const LOCAL_INSPECTOR_COMMAND = "npx @mcpjam/inspector@latest";
export const DESKTOP_APP_DOWNLOAD_URL =
  "https://github.com/MCPJam/inspector/releases/latest";

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const BARE_HOST =
  /^(?:localhost|(?:[a-z\d-]+\.)+[a-z\d-]+)(?::\d+)?(?:[/?#]|$)/i;
const SCRIPT_FILE = /^[^/:\s]+\.(?:[cm]?js|tsx?|py|sh|rb|exe)$/i;

/** A bare host such as `mcp.example.com/mcp` is a URL missing its scheme. */
export function looksLikeStdioCommand(input: string): boolean {
  const value = input.trim();
  if (!value || HAS_SCHEME.test(value)) return false;
  if (/\s/.test(value) || SCRIPT_FILE.test(value)) return true;
  return !BARE_HOST.test(value);
}

function isLoopbackUrl(input: string): boolean {
  let host: string;
  try {
    host = new URL(input).hostname.toLowerCase();
  } catch {
    // Not a URL at all, so not a loopback one; the form validator reports it.
    return false;
  }
  host = host.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export function checkHostedServerInput(
  input: string,
  transport: "http" | "stdio",
): HostedInputCheck {
  const value = input.trim();
  if (!value) return { kind: "ok" };
  if (transport === "stdio") {
    return { kind: "blocked", reason: "stdio", copyCommand: value };
  }
  const url = HAS_SCHEME.test(value) ? value : `http://${value}`;
  if (isLoopbackUrl(url)) {
    return {
      kind: "blocked",
      reason: "localhost",
      copyCommand: LOCAL_INSPECTOR_COMMAND,
    };
  }
  if (isPrivateNetworkUrl(url)) return { kind: "private_network" };
  return { kind: "ok" };
}

/**
 * The transport the first screen assumes for what was pasted. The hosted app
 * reads a bare host as an HTTP URL missing its scheme; locally anything
 * without `http(s)://` is a command, as it always was.
 */
export function inferFirstRunTransport(
  input: string,
  hosted: boolean,
): "http" | "stdio" {
  if (/^https?:\/\//i.test(input)) return "http";
  if (!hosted) return "stdio";
  return looksLikeStdioCommand(input) ? "stdio" : "http";
}
