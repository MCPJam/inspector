import type { ShareAccessOption, ShareMode } from "@/components/sharing/share-types";

/**
 * Mirror of backend `SHARE_MODE_RANK` in `convex/lib/shareable/policy.ts`.
 * Undefined / null ceiling = fully permissive (safe under backend rollback).
 */
export const SHARE_MODE_RANK: Record<ShareMode, number> = {
  project_members: 0,
  invited_only: 1,
  anyone_with_link: 2,
};

export const SHARE_MODE_LABELS: Record<ShareMode, string> = {
  project_members: "project members",
  invited_only: "invited users only",
  anyone_with_link: "anyone with the link",
};

export function clampShareMode(
  mode: ShareMode,
  ceiling?: ShareMode | null,
): ShareMode {
  if (!ceiling) return mode;
  return SHARE_MODE_RANK[mode] <= SHARE_MODE_RANK[ceiling] ? mode : ceiling;
}

export function isShareModeAboveCeiling(
  mode: ShareMode,
  ceiling?: ShareMode | null,
): boolean {
  if (!ceiling) return false;
  return SHARE_MODE_RANK[mode] > SHARE_MODE_RANK[ceiling];
}

export function orgShareLimitReason(ceiling: ShareMode): string {
  return `Your organization limits sharing to ${SHARE_MODE_LABELS[ceiling]}.`;
}

export function applyShareCeilingToOptions(
  options: readonly ShareAccessOption[],
  ceiling?: ShareMode | null,
  valueToMode: (value: string) => ShareMode | null = (value) =>
    value in SHARE_MODE_RANK ? (value as ShareMode) : null,
): ShareAccessOption[] {
  return options.map((option) => {
    const mode = valueToMode(option.value);
    if (!mode || !isShareModeAboveCeiling(mode, ceiling)) {
      return { ...option, disabled: undefined, disabledReason: undefined };
    }
    return {
      ...option,
      disabled: true,
      disabledReason: orgShareLimitReason(ceiling!),
    };
  });
}
