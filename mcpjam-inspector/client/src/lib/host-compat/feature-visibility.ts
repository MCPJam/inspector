export type HostFeatureVisibility = {
  claudeCode: boolean;
  codex: boolean;
};

export function isHostVisibleByFeatureFlags(
  hostId: string,
  visibility: HostFeatureVisibility
): boolean {
  if (hostId === "claude-code") return visibility.claudeCode;
  if (hostId === "codex") return visibility.codex;
  return true;
}

export function filterReportsByFeatureFlags<T extends { hostId: string }>(
  reports: T[],
  visibility: HostFeatureVisibility
): T[] {
  return reports.filter((report) =>
    isHostVisibleByFeatureFlags(report.hostId, visibility)
  );
}

export function filterProfilesByFeatureFlags<T extends { id: string }>(
  profiles: T[],
  visibility: HostFeatureVisibility
): T[] {
  return profiles.filter((profile) =>
    isHostVisibleByFeatureFlags(profile.id, visibility)
  );
}
