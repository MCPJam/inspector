import type { MCPServerConfig, ServerDoctorResult } from "@mcpjam/sdk";

export interface ServerDoctorTargetSummary {
  kind: "http" | "stdio";
  label: string;
  url?: string;
  command?: string;
  commandArgs: string[];
  envKeys: string[];
  headerNames: string[];
  timeoutMs?: number;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasClientSecret: boolean;
  clientCapabilities?: Record<string, unknown>;
}

export function summarizeServerDoctorTarget(
  target: string,
  config: MCPServerConfig,
): ServerDoctorTargetSummary {
  if ("url" in config) {
    return {
      kind: "http",
      label: target,
      url: config.url,
      commandArgs: [],
      envKeys: [],
      headerNames: Object.keys(extractHeaders(config.requestInit?.headers)),
      timeoutMs: config.timeout,
      hasAccessToken: Boolean(config.accessToken),
      hasRefreshToken: Boolean(config.refreshToken),
      hasClientSecret: Boolean(config.clientSecret),
      ...(config.clientCapabilities
        ? { clientCapabilities: config.clientCapabilities }
        : {}),
    };
  }

  return {
    kind: "stdio",
    label: target,
    command: config.command,
    commandArgs: config.args ?? [],
    envKeys: Object.keys(config.env ?? {}),
    headerNames: [],
    timeoutMs: config.timeout,
    hasAccessToken: false,
    hasRefreshToken: false,
    hasClientSecret: false,
    ...(config.clientCapabilities
      ? { clientCapabilities: config.clientCapabilities }
      : {}),
  };
}

export function formatServerDoctorHuman(
  result: ServerDoctorResult<ServerDoctorTargetSummary>,
  options: { artifactPath?: string } = {},
): string {
  const lines = [`Status: ${result.status}`, `Target: ${result.target.label}`];

  if (result.probe) {
    const transport =
      result.probe.transport.selected ??
      (result.probe.transport.attempts.length > 0 ? "attempted" : "none");
    lines.push(`Probe: ${result.probe.status} (${transport})`);
  } else {
    lines.push("Probe: skipped");
  }

  lines.push(
    `Connection: ${result.connection.status} (${result.connection.detail})`,
  );
  lines.push(
    `Counts: tools ${result.tools.length}, resources ${result.resources.length}, resourceTemplates ${result.resourceTemplates.length}, prompts ${result.prompts.length}`,
  );

  if (result.status === "oauth_required" && result.probe) {
    const strategies = result.probe.oauth.registrationStrategies.join(", ") || "none";
    lines.push(`OAuth: required (${strategies})`);
    lines.push(
      `Next: run \`mcpjam oauth login --url '${result.target.url ?? result.target.label}'\``,
    );
  } else if (result.error) {
    lines.push(`Error: ${result.error.code}: ${result.error.message}`);
  }

  lines.push("Checks:");
  for (const [name, check] of Object.entries(result.checks)) {
    lines.push(`- ${name}: ${check.status} (${check.detail})`);
  }

  if (options.artifactPath) {
    lines.push(`Artifact: ${options.artifactPath}`);
  }

  return lines.join("\n");
}

function extractHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)]),
    );
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}
