export interface ThemeCapture {
  id: string;
  capturedAt: number;
  label: string;
  variables: Record<string, string>;
}

const HOSTS_WITH_HISTORY = new Set(["chatgpt", "claude"]);

/** Claude / ChatGPT probe dates used in the demo registry. */
export const DEMO_CAPTURE_AUG_4 = Date.parse("2026-08-04T16:00:00.000Z");
export const DEMO_CAPTURE_JUN_24 = Date.parse("2026-06-24T16:00:00.000Z");

const OLDER_PRIMARY =
  "light-dark(rgba(250, 249, 245, 1), rgba(32, 32, 30, 1))";
const MID_PRIMARY =
  "light-dark(rgba(252, 251, 248, 1), rgba(40, 40, 38, 1))";
const OLDER_RADIUS = "8px";
const ACCENT = "light-dark(rgba(214, 228, 246, 1), rgba(37, 62, 95, 1))";

export function hostStyleHasDemoHistory(hostStyle: string | undefined): boolean {
  return hostStyle !== undefined && HOSTS_WITH_HISTORY.has(hostStyle);
}

export function hostStyleDisplayName(hostStyle: string | undefined): string {
  if (hostStyle === "chatgpt") return "ChatGPT";
  if (hostStyle === "claude") return "Claude";
  return "This host";
}

/**
 * Prior MCPJam captures for ChatGPT / Claude. Latest is always the live
 * draft — these are slight mutations so the diff is visible.
 */
export function demoPriorCaptures(
  hostStyle: string | undefined,
  latest: Record<string, string>,
): ThemeCapture[] {
  if (!hostStyleHasDemoHistory(hostStyle)) return [];
  return [
    {
      id: "aug-4",
      capturedAt: DEMO_CAPTURE_AUG_4,
      label: "MCPJam probe",
      variables: mutate(latest, {
        "--color-background-primary": MID_PRIMARY,
        "--border-radius-lg": OLDER_RADIUS,
      }),
    },
    {
      id: "jun-24",
      capturedAt: DEMO_CAPTURE_JUN_24,
      label: "MCPJam probe",
      variables: mutate(latest, {
        "--color-background-primary": OLDER_PRIMARY,
        "--border-radius-lg": OLDER_RADIUS,
        "--color-background-accent": ACCENT,
      }),
    },
  ];
}

function mutate(
  latest: Record<string, string>,
  patch: Record<string, string>,
): Record<string, string> {
  return { ...latest, ...patch };
}
