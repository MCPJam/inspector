import { useSoftQuery } from "@/hooks/use-soft-query";

/** `nativeHarnessTrial:get`, the organization's Free native harness trial. */
type NativeHarnessTrialRow = {
  /** False for paid plans, which have no turn limit. */
  applies: boolean;
  granted: number;
  used: number;
  remaining: number;
};

export type NativeHarnessTrial = { remaining: number; granted: number };

/** The usage rows' explainer, shared by the sidebar and the billing card. */
export const NATIVE_HARNESS_TURNS_TOOLTIP =
  "Turns on a native harness that MCPJam pays for before your organization needs a paid plan.";

/** "12 / 20 remaining", as the usage rows show it. */
export function nativeHarnessTurnsLeftText(trial: NativeHarnessTrial): string {
  return `${trial.remaining.toLocaleString()} / ${trial.granted.toLocaleString()} remaining`;
}

/** Turns left as a share of the trial, for the usage bars. */
export function nativeHarnessTurnsLeftPercent(trial: NativeHarnessTrial): number {
  if (trial.granted <= 0) return 0;
  return Math.min(100, (trial.remaining / trial.granted) * 100);
}

/**
 * The organization's native harness turns left, for the usage surfaces and the
 * refusal dialog. `null` while loading, when the trial does not apply (a paid
 * plan), when the read fails, and when `organizationId` is null, which skips
 * the read. Soft, like the other usage meters: the sidebar reads it on every
 * page, and a failed read must not replace the app.
 */
export function useNativeHarnessTrial(
  organizationId: string | null | undefined,
): NativeHarnessTrial | null {
  const { data } = useSoftQuery<NativeHarnessTrialRow>(
    "nativeHarnessTrial:get",
    organizationId ? { organizationId } : "skip",
  );
  return data?.applies
    ? { remaining: Math.max(0, data.remaining), granted: data.granted }
    : null;
}
