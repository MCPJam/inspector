export type HostFeatureVisibility = {
  claudeCode: boolean;
  codex: boolean;
  cursorCli: boolean;
};

/** Same flags before PostHog answers, where `undefined` means "not resolved". */
export type HostFeatureVisibilityState = {
  [K in keyof HostFeatureVisibility]: boolean | undefined;
};

/**
 * Every host id gated behind a rollout flag, mapped to the visibility key that
 * governs it. Single source of truth: the New Host picker, the compare matrix,
 * and the `?template=` verify deep link all read it, so a newly gated host
 * cannot be enforced on one surface and silently missed on another.
 */
const FLAG_GATED_HOSTS: Partial<
  Record<string, keyof HostFeatureVisibility>
> = {
  "claude-code": "claudeCode",
  codex: "codex",
  // The Cursor CLI host ONLY. The emulated `cursor` template (the IDE chat
  // panel) is deliberately absent: it is a different, ungated host that has
  // shipped for months, and gating it here would hide it from everyone.
  "cursor-cli": "cursorCli",
};

export const FLAG_GATED_HOST_IDS: ReadonlySet<string> = new Set(
  Object.keys(FLAG_GATED_HOSTS)
);

/**
 * Tri-state sibling of {@link isHostVisibleByFeatureFlags}: returns `undefined`
 * while the host's flag is still loading, so callers that must not act early
 * (route guards, deep links) can wait instead of reading unresolved as off.
 */
export function hostFeatureFlagState(
  hostId: string,
  visibility: HostFeatureVisibilityState
): boolean | undefined {
  const key = FLAG_GATED_HOSTS[hostId];
  return key === undefined ? true : visibility[key];
}

export function isHostVisibleByFeatureFlags(
  hostId: string,
  visibility: HostFeatureVisibility
): boolean {
  return hostFeatureFlagState(hostId, visibility) === true;
}

/**
 * The flag-gated host ids currently hidden, as a Set.
 *
 * DERIVED from {@link FLAG_GATED_HOSTS} rather than hand-listed, which is the
 * whole point: the one caller that used to build this itself
 * (`HostConfigCompareView`) had `if (!claudeCodeEnabled) excluded.add(…)` typed
 * out per host, so a newly gated host was gated on five surfaces and silently
 * offered on the sixth. Adding a host to the map above now covers all of them.
 */
export function excludedFlagGatedHostIds(
  visibility: HostFeatureVisibility
): Set<string> {
  const excluded = new Set<string>();
  for (const hostId of Object.keys(FLAG_GATED_HOSTS)) {
    if (!isHostVisibleByFeatureFlags(hostId, visibility)) excluded.add(hostId);
  }
  return excluded;
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

export function filterHostsByFeatureFlags<T extends { id: string }>(
  hosts: T[],
  visibility: HostFeatureVisibility
): T[] {
  return hosts.filter((host) => isHostVisibleByFeatureFlags(host.id, visibility));
}
