import type { ServerFormData } from "@/shared/types.js";

export type ParsedFirstRunServerInput =
  | { ok: true; formData: ServerFormData }
  | { ok: false; error: string };

/**
 * The first-run screen collects a server with a single field, so it has to
 * decide the transport itself rather than making a brand-new user pick one.
 * A value that parses as a URL is HTTP; anything else is treated as a stdio
 * command line. `AddServerModal` remains the place to express the full config
 * (headers, env, protocol pin) — this only has to get someone connected.
 */
export function parseFirstRunServerInput(
  raw: string,
  options: { hostedMode: boolean }
): ParsedFirstRunServerInput {
  const value = raw.trim();

  if (!value) {
    return { ok: false, error: "Enter a server URL or command." };
  }

  const url = asHttpUrl(value);
  if (url) {
    return {
      ok: true,
      formData: {
        name: deriveHttpServerName(url),
        type: "http",
        url: url.toString(),
        useOAuth: false,
      },
    };
  }

  if (looksLikeUrlAttempt(value)) {
    return {
      ok: false,
      error: `MCPJam only speaks HTTP and stdio — "${protocolOf(value)}" isn't a transport it can use.`,
    };
  }

  // Hosted MCPJam runs servers remotely, so there is no local process to spawn.
  if (options.hostedMode) {
    return {
      ok: false,
      error:
        "Hosted MCPJam can't run a local command. Paste an HTTP server URL, or run MCPJam locally to use stdio.",
    };
  }

  const parts = value.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? "";
  const args = parts.slice(1);

  return {
    ok: true,
    formData: {
      name: deriveStdioServerName(command, args),
      type: "stdio",
      command,
      args,
    },
  };
}

function asHttpUrl(value: string): URL | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : // A bare `mcp.example.com/mcp` is a URL a person would expect to work.
      // Requiring a scheme here would be pedantry, but only promote values
      // that actually look like a host — never a command like `npx foo`.
      looksLikeBareHost(value)
      ? `https://${value}`
      : null;

  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function looksLikeBareHost(value: string): boolean {
  if (/\s/.test(value)) return false;
  const [host = ""] = value.split("/");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host);
}

function looksLikeUrlAttempt(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function protocolOf(value: string): string {
  return value.slice(0, value.indexOf("://"));
}

/**
 * Server names are the identity used across the app (selection, persistence,
 * the tool rail), so they need to be recognizable rather than raw URLs.
 * `https://mcp.excalidraw.com/mcp` becomes "Excalidraw".
 */
function deriveHttpServerName(url: URL): string {
  const host = url.hostname.replace(/^www\./i, "").replace(/^mcp\./i, "");
  const labels = host.split(".").filter(Boolean);

  // Drop the public suffix (`.com`, `.co.uk`) to get at the memorable label.
  const meaningful =
    labels.length > 2 && labels[labels.length - 2]!.length <= 3
      ? labels.slice(0, -2)
      : labels.slice(0, -1);

  const label = (meaningful[meaningful.length - 1] ?? labels[0] ?? "").trim();
  return label ? titleCase(label) : url.hostname;
}

/**
 * `npx -y @acme/weather-mcp` should read as "Weather Mcp", not "Npx". Flags and
 * their values carry no identity, so the name comes from the last bare argument.
 */
function deriveStdioServerName(command: string, args: string[]): string {
  const candidate = [...args].reverse().find((arg) => !arg.startsWith("-"));
  const source = candidate ?? command;

  const base = source
    .replace(/^@[^/]+\//, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[/\\]/)
    .filter(Boolean)
    .pop();

  return base ? titleCase(base) : command;
}

function titleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
