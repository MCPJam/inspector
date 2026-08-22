import type {
  PlatformCatalogServer,
  PlatformRegistryInstallResult,
} from "@mcpjam/sdk/platform";

function line(label: string, value: string | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  return `${label}: ${value}`;
}

/**
 * Decision-relevant fields for `registry show`. The freshness pin is the
 * field an agent must pass to `registry install`, so it is printed first
 * among the actionable block rather than buried in a raw-row dump.
 */
export function formatRegistryDirectoryServerHuman(
  server: PlatformCatalogServer,
): string {
  const title = server.displayName ?? server.serverName;
  const lines = [
    `${title}  (${server.id})`,
    line("source", server.source),
    line("serverName", server.serverName),
    line("authPosture", server.authPosture),
    line("verifiedTier", server.verifiedTier),
    line("endpointKind", server.endpointKind),
    line("unavailableReason", server.unavailableReason),
    line("latestContentHash", server.latestContentHash),
    line("remoteUrl", server.remoteUrl),
    line("remoteUrlRegex", server.remoteUrlRegex),
    line("remoteUrlHint", server.remoteUrlHint),
    server.remoteUrlOptions && server.remoteUrlOptions.length > 0
      ? `remoteUrlOptions: ${server.remoteUrlOptions.join(", ")}`
      : null,
    server.description ? `\n${server.description}` : null,
    server.remoteUrl
      ? `\nTry locally:\n  mcpjam server probe --url ${server.remoteUrl}`
      : null,
    server.latestContentHash
      ? `\nInstall pin (pass to registry install):\n  --expected-content-hash ${server.latestContentHash}`
      : null,
  ].filter((entry): entry is string => entry !== null);
  return lines.join("\n");
}

/**
 * Human install success: the follow-ups, not just the outcome. JSON callers
 * already get the same facts as `nextSteps` on the structured result.
 */
export function formatRegistryInstallHuman(
  result: PlatformRegistryInstallResult,
): string {
  const lines = [
    `Installed ${result.serverName} (${result.outcome}).`,
    `serverId: ${result.serverId}`,
    "This wrote a project servers row — it is not a live connection.",
    "Next steps:",
    `  Check connection status via ${result.nextSteps.connectionStatusOp}`,
    `  mcpjam cloud projects servers connect --server ${result.serverId} --url <endpoint-url>`,
  ];
  if (result.nextSteps.connectLinkUrl) {
    lines.push("  Finish OAuth in the browser:");
    lines.push(`    ${result.nextSteps.connectLinkUrl}`);
  }
  return lines.join("\n");
}
