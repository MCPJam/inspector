/** First CLI release whose bundled SDK renders local iteration evidence. */
export const CLI_REPORTING_VERSION = "6.4.1";

export function isCliVersionOlderThan(
  version: unknown,
  minimumVersion: string,
): boolean {
  if (typeof version !== "string") return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part)))
    return false;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const minimum = minimumVersion.split(".").map(Number);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== minimum[i]) return parts[i] < minimum[i];
  }
  return Boolean(match[4]);
}

export function isOlderReportingCli(version: unknown): boolean {
  return isCliVersionOlderThan(version, CLI_REPORTING_VERSION);
}

export function oldRunCliVersion(run: {
  launcher?: { kind?: string; client?: string; version?: string } | null;
}): string | undefined {
  const launcher = run.launcher;
  if (launcher?.client && launcher.client !== "mcpjam-cli") return;
  if (
    launcher?.kind !== "cli" &&
    !(launcher?.kind === "github_action" && launcher.client === "mcpjam-cli")
  )
    return;
  return isOlderReportingCli(launcher.version) ? launcher.version : undefined;
}
