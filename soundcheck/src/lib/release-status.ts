/**
 * Where the release stands, reduced to one status the release card renders
 * and one action its button takes. Pure: the fetching lives in
 * `release-card-data.ts`, so this file runs under `node --test` as is.
 *
 * The order matters. A run in flight beats everything, because the button
 * must never offer a second release while one is running (Start release's
 * prepare step included: until it pushes the version commit, main still
 * shows pending changesets). Next come versions on main that npm does not
 * have, then pending changesets.
 *
 * Hand-synced with .github/scripts/release-trigger.mjs (`Release <label>`
 * run names) and unpublished-versions.mjs.
 */

import type { WorkflowRun } from "./github";
import type { ReleasePlan } from "./changesets";

export interface UnpublishedVersion {
  name: string;
  newVersion: string;
}

export type ReleaseStatus =
  | { kind: "running"; label: string | null; run: WorkflowRun }
  | { kind: "publishing"; label: string; run: WorkflowRun }
  | { kind: "stopped"; label: string; run: WorkflowRun }
  | { kind: "waiting"; label: string }
  | { kind: "ready"; label: string; from: string | null; changes: number }
  | { kind: "idle" }
  | { kind: "unknown"; reason: string };

/** What the one button does in each status, or null for no button. */
export type ReleaseAction = "start" | "publish";

export interface ReleaseStatusInput {
  /** In-flight or queued release.yml run. */
  activeRelease: WorkflowRun | null;
  /** In-flight or queued prepare-release.yml (Start release) run. */
  activePrepare: WorkflowRun | null;
  /** Packages whose version on main npm lacks, or why that read failed. */
  unpublished: UnpublishedVersion[] | Error;
  /** What Start release would ship, or why that read failed. */
  plan: ReleasePlan | Error;
  /** Recent release.yml runs, newest first. */
  recentRuns: WorkflowRun[];
  /** Current time in ms, for the npm catch-up window. */
  now: number;
}

/**
 * npm can take several minutes to serve a version after `npm publish`
 * returns (seven, on 3.23.0). Inside this window after a successful release
 * run, a missing version means npm is catching up, not that nothing ran.
 */
export const NPM_CATCH_UP_MS = 20 * 60 * 1000;

/** release-trigger.mjs `releaseLabel`. */
export function releaseLabel(unpublished: UnpublishedVersion[]): string {
  const inspector = unpublished.find((r) => r.name === "@mcpjam/inspector");
  return inspector
    ? inspector.newVersion
    : unpublished.map((r) => `${r.name} ${r.newVersion}`).join(", ");
}

/** The version a release run is for, from its `Release <label>` title. */
export function runLabel(run: WorkflowRun): string | null {
  const match = run.displayTitle.match(/^Release (.+)$/);
  return match ? match[1] : null;
}

export function deriveReleaseStatus(input: ReleaseStatusInput): ReleaseStatus {
  const active = input.activeRelease ?? input.activePrepare;
  if (active) {
    return {
      kind: "running",
      label: input.activeRelease ? runLabel(input.activeRelease) : null,
      run: active
    };
  }

  if (input.unpublished instanceof Error) {
    return { kind: "unknown", reason: input.unpublished.message };
  }
  if (input.unpublished.length > 0) {
    // Checked before matching by label: once some packages are on npm, the
    // label of what's left no longer matches the run's `Release <label>`.
    const justShipped = input.recentRuns.find(
      (r) =>
        r.status === "completed" &&
        r.conclusion === "success" &&
        input.now - Date.parse(r.updatedAt) < NPM_CATCH_UP_MS
    );
    const shippedLabel = justShipped ? runLabel(justShipped) : null;
    if (justShipped && shippedLabel) {
      return { kind: "publishing", label: shippedLabel, run: justShipped };
    }
    const label = releaseLabel(input.unpublished);
    const last = input.recentRuns.find((r) => runLabel(r) === label);
    if (last && last.status === "completed" && last.conclusion !== "success") {
      return { kind: "stopped", label, run: last };
    }
    return { kind: "waiting", label };
  }

  if (input.plan instanceof Error) {
    return { kind: "unknown", reason: input.plan.message };
  }
  if (input.plan.packages.length === 0) return { kind: "idle" };
  const inspector = input.plan.packages.find(
    (p) => p.name === "@mcpjam/inspector"
  );
  return {
    kind: "ready",
    label: inspector
      ? inspector.newVersion
      : input.plan.packages.map((p) => `${p.name} ${p.newVersion}`).join(", "),
    from: inspector?.currentVersion ?? null,
    changes: input.plan.changesets.length
  };
}

/**
 * Start versions pending changesets. Publish re-runs release.yml for versions
 * already on main: after a failure, or when nothing started it (the fallback
 * trigger only fires on a green staging deploy).
 */
export function releaseAction(status: ReleaseStatus): ReleaseAction | null {
  if (status.kind === "ready") return "start";
  if (status.kind === "stopped" || status.kind === "waiting") return "publish";
  return null;
}

/** Median minutes of the last five successful release runs, or null. */
export function typicalReleaseMinutes(runs: WorkflowRun[]): number | null {
  const minutes = runs
    .filter((r) => r.conclusion === "success" && r.runStartedAt)
    .slice(0, 5)
    .map(
      (r) =>
        (Date.parse(r.updatedAt) - Date.parse(r.runStartedAt as string)) /
        60_000
    )
    .filter((m) => Number.isFinite(m) && m > 0)
    .sort((a, b) => a - b);
  if (minutes.length === 0) return null;
  return Math.round(minutes[Math.floor(minutes.length / 2)]);
}
