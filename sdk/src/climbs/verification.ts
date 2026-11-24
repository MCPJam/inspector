/**
 * The verification as a reader wants it: whether the gain the mock showed
 * holds on the real server, both gains per environment, the baseline then and
 * now, and the commit. The keep rule's settling is the backend's; this reads
 * what it stored.
 */
import type { PlatformClimb, PlatformClimbVerification } from "../platform/climb-types.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (typeof value === "object" && value !== null ? (value as Obj) : {});
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export type VerificationEnvironment = {
  environmentId: string;
  /** Pass rate of the baseline mock when the climb recorded it, and of the restore arm just now. */
  baselineThenBps?: number;
  baselineNowBps?: number;
  /** Pass rate of the server as it is now. */
  serverNowBps?: number;
  /** The gain the best mock showed in the climb, and the gain the server shows over the restore arm, in basis points. */
  gainOnMockBps?: number;
  gainOnServerBps?: number;
  holds?: boolean;
};

export type VerificationReport = {
  index: number;
  mode: PlatformClimbVerification["mode"];
  verdict?: PlatformClimbVerification["verdict"];
  /** True when the keep rule kept the pair: the gain holds on the server. */
  holds: boolean;
  commit: { sha?: string; branch?: string; repositoryUrl?: string; dirty?: boolean; serverVersion?: string };
  startedBy: string;
  environments: VerificationEnvironment[];
  /** How old the climb's recorded numbers are, for a verification that ran the server alone. */
  recordedAgeMs?: Record<string, number>;
  summary: string;
};

export function verificationReport(
  climb: Pick<PlatformClimb, "baseline">,
  verification: PlatformClimbVerification,
): VerificationReport {
  const result = obj(verification.result);
  const environments = Array.isArray(result.environments) ? result.environments : [];
  // The kept round's results per environment, as a list or keyed by environment.
  const gains = Array.isArray(result.gainOnMock)
    ? result.gainOnMock.map(obj)
    : Object.entries(obj(result.gainOnMock)).map(([environmentId, value]): Obj => ({ environmentId, ...obj(value) }));
  const report: VerificationEnvironment[] = environments.map((entry) => {
    const env = obj(entry);
    const id = String(env.environmentId ?? "");
    const steering = obj(env.steering);
    const passRate = obj(steering.passRate);
    const then = climb.baseline?.environments.find((candidate) => candidate.environmentId === id)?.steering;
    const rates = then ? Math.round((then.passRateBps[0] + then.passRateBps[1]) / 2) : undefined;
    const mock: Obj = gains.find((candidate) => candidate.environmentId === id) ?? {};
    return {
      environmentId: id,
      ...(rates !== undefined ? { baselineThenBps: rates } : {}),
      ...(num(passRate.bestBps) !== undefined ? { baselineNowBps: num(passRate.bestBps) } : {}),
      ...(num(passRate.candidateBps) !== undefined ? { serverNowBps: num(passRate.candidateBps) } : {}),
      ...(num(obj(obj(mock.steering).passRate).deltaBps) !== undefined ? { gainOnMockBps: num(obj(obj(mock.steering).passRate).deltaBps) } : {}),
      ...(num(passRate.deltaBps) !== undefined ? { gainOnServerBps: num(passRate.deltaBps) } : {}),
    };
  });
  const holds = verification.verdict === "kept";
  return {
    index: verification.index,
    mode: verification.mode,
    ...(verification.verdict ? { verdict: verification.verdict } : {}),
    holds,
    commit: {
      ...(verification.commitSha ? { sha: verification.commitSha } : {}),
      ...(verification.branch ? { branch: verification.branch } : {}),
      ...(verification.repositoryUrl ? { repositoryUrl: verification.repositoryUrl } : {}),
      ...(verification.dirty !== undefined ? { dirty: verification.dirty } : {}),
      ...(verification.serverVersion ? { serverVersion: verification.serverVersion } : {}),
    },
    startedBy: verification.startedBy,
    environments: report,
    ...(result.recordedAgeMs
      ? { recordedAgeMs: Object.fromEntries(Object.entries(obj(result.recordedAgeMs)).filter(([, age]) => typeof age === "number").map(([key, age]) => [key, Number(age)])) }
      : {}),
    summary: summaryLine(verification, holds),
  };
}

function summaryLine(verification: PlatformClimbVerification, holds: boolean): string {
  if (verification.status === "failed") return `The verification did not finish: ${verification.failureReason ?? "its runs failed"}. It does not count against the limit of three.`;
  if (verification.status !== "settled") return "The verification is still running.";
  if (verification.mode === "server_only") {
    return "Only the server ran, because a kept change cannot be put back on a mock. Its numbers are set beside the ones the climb recorded, which are older: this is not a measured pair.";
  }
  if (verification.verdict === "not_decided") return "The verification could not be decided: the server's listing changed beyond the kept fields, or too many iterations were lost.";
  return holds
    ? "The gain holds on the real server: the rule kept the server against the mock that puts the old values back."
    : "The gain does not hold on the real server. Both gains are shown per environment.";
}
