/**
 * A run's verdict under the gate a submission chose. By default the gate is
 * the directory's blocking set, every `required` or `runtime-blocker` check;
 * `warnOnly` takes a check out and `failOn` adds any check. The page shows
 * every finding whatever the gate, and the result names the gate it applied.
 *
 * A gated check with no current verdict (not evaluated, blocked, stale or
 * never reported) makes the run `incomplete`. A check the run's path can
 * never evaluate, or whose evidence no run gathers yet, is listed apart, with
 * the reason, and leaves the default gate unless `failOn` names it.
 *
 * Pure. Safe from the browser entry.
 */

import { UNGATHERED_EVIDENCE_DETAIL_KEY } from "../helpers.js";
import { isDispositiveDirectoryFinding } from "../types.js";
import type { DirectoryReadinessFinding } from "../types.js";
import { isUnsureModelFlag } from "./place.js";
import type { PlacedFinding } from "./types.js";

/** Which checks fail a run, by check id. `failOn` wins over `warnOnly`. */
export interface DirectoryCheckGate {
  failOn?: readonly string[];
  warnOnly?: readonly string[];
}

/** Where the run happened: a hosted worker, or the CLI on a user's machine. */
export type DirectoryRunPath = "hosted" | "cli";

export interface DirectoryVerdict {
  verdict: "ready" | "not-ready" | "incomplete";
  /** Gated checks that were violated. */
  failing: string[];
  /** Gated checks with no current verdict: why the run is incomplete. */
  undetermined: string[];
  /** Checks this path cannot evaluate. Only `failOn` puts one in the gate. */
  notCheckedOnPath: string[];
  /** Why each of {@link notCheckedOnPath} is not checked here. */
  notCheckedReasons: Record<string, string>;
  /** The gate as applied, so a caller can name it. */
  gate: { failOn: string[]; warnOnly: string[] };
}

const NO_CHANGES_HOSTED =
  "hosted runs never make probes that change the server, such as registering an OAuth client or spending a refresh token";
const NO_SIGN_IN_RECORD =
  "it reads the requests of a completed OAuth sign-in, and no run records those yet";

/**
 * Why `path` can never evaluate a finding, if it cannot. Read from what the
 * finding says it lacked, so a check that did reach a verdict stays gated.
 */
function pathLimit(
  finding: DirectoryReadinessFinding,
  path: DirectoryRunPath
): string | undefined {
  if (finding.status !== "not-evaluated") return undefined;
  // No path gathers it, so the finding's own reason says why on every path.
  if (finding.details?.[UNGATHERED_EVIDENCE_DETAIL_KEY] !== undefined) {
    return finding.notEvaluatedReason ?? "no run gathers this evidence yet";
  }
  const missing = String(finding.details?.missingInput ?? "");
  const intrusive =
    finding.intrusiveness === "side-effecting" ||
    /^intrusive(\.|$)/.test(missing);
  if (path === "hosted" && intrusive) return NO_CHANGES_HOSTED;
  const signIn =
    missing === "authorizationRequests" ||
    finding.requiresCapabilities?.includes("interactive-oauth");
  return signIn ? NO_SIGN_IN_RECORD : undefined;
}

export function directoryVerdict(
  findings: ReadonlyArray<DirectoryReadinessFinding | PlacedFinding>,
  options: { checkGate?: DirectoryCheckGate; path: DirectoryRunPath }
): DirectoryVerdict {
  const failOn = new Set(options.checkGate?.failOn ?? []);
  const warnOnly = new Set(
    [...(options.checkGate?.warnOnly ?? [])].filter((id) => !failOn.has(id))
  );
  const failing = new Set<string>();
  const undetermined = new Set<string>();
  const notCheckedReasons: Record<string, string> = {};
  const reported = new Set<string>();
  let gated = 0;

  for (const entry of findings) {
    const placed = "finding" in entry ? entry : undefined;
    const finding = "finding" in entry ? entry.finding : entry;
    reported.add(finding.id);
    const limit = pathLimit(finding, options.path);
    if (limit) notCheckedReasons[finding.id] = limit;
    const inGate =
      failOn.has(finding.id) ||
      (!limit &&
        isDispositiveDirectoryFinding(finding) &&
        !warnOnly.has(finding.id));
    if (!inGate) continue;
    gated += 1;
    // Stale, blocked or inconclusive evidence settles nothing, whatever it
    // once said: a model's unsure answer is never a pass.
    const current = placed
      ? placed.evidenceStatus === "established"
      : !isUnsureModelFlag(finding);
    if (finding.status === "not-evaluated" || !current) {
      undetermined.add(finding.id);
    } else if (finding.status === "violated") {
      failing.add(finding.id);
    }
  }
  // A check the gate names that the run never reported was not checked.
  for (const id of failOn) {
    if (!reported.has(id)) undetermined.add(id);
  }

  const verdict =
    failing.size > 0
      ? "not-ready"
      : undetermined.size > 0 || gated === 0
        ? "incomplete"
        : "ready";
  return {
    verdict,
    failing: [...failing].sort(),
    undetermined: [...undetermined].sort(),
    notCheckedOnPath: Object.keys(notCheckedReasons).sort(),
    notCheckedReasons,
    gate: { failOn: [...failOn].sort(), warnOnly: [...warnOnly].sort() },
  };
}
