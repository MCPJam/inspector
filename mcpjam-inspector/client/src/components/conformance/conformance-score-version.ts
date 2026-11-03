import type { UseConformanceRunResult } from "@/hooks/use-conformance-run";

/**
 * The headline's version. The pool names one only when every scored suite
 * agrees, so when they disagree the headline must not fall back to the pin.
 */
export function scoreVersionLabel(
  snapshot: Pick<
    UseConformanceRunResult,
    | "pooledScore"
    | "protocolScore"
    | "appsScore"
    | "tasksScore"
    | "oauthScore"
    | "versionPin"
  >,
): string {
  const { pooledScore, versionPin } = snapshot;
  if (pooledScore?.protocolVersion) return pooledScore.protocolVersion;
  const scores = [
    snapshot.protocolScore,
    snapshot.appsScore,
    snapshot.tasksScore,
    snapshot.oauthScore,
  ];
  const versions = new Set(
    scores
      .filter((score) => score && score.applicable > 0)
      .map((score) => score?.protocolVersion)
      .filter(Boolean),
  );
  if (versions.size > 1) return "Mixed versions";
  return versionPin === "auto" ? "Auto" : versionPin;
}
