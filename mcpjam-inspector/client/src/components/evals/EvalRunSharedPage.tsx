import { SharedArtifactPage } from "@/components/sharing/SharedArtifactPage";
import { useSharedArtifact } from "@/hooks/useSharedArtifact";

const ALLOWED_ARTIFACT_KEYS = [
  "schemaVersion",
  "suiteName",
  "runNumber",
  "outcome",
  "aggregate",
  "cases",
] as const;

const ALLOWED_CASE_KEYS = [
  "name",
  "result",
  "scores",
  "durationMs",
  "judge",
] as const;

const ALLOWED_JUDGE_KEYS = ["verdict", "rationale"] as const;
const ALLOWED_AGGREGATE_KEYS = [
  "total",
  "passed",
  "failed",
  "passRate",
] as const;

function pick<T extends Record<string, unknown>>(
  value: unknown,
  keys: readonly string[],
): T {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== "object") return out as T;
  for (const key of keys) {
    if (key in value) out[key] = (value as Record<string, unknown>)[key];
  }
  return out as T;
}

/** Allowlist-only projection. Extra/malicious artifact keys never render. */
export function projectEvalSharedView(artifact: unknown): {
  suiteName: string;
  runNumber: number | null;
  outcome: string;
  aggregate: Record<string, unknown>;
  cases: Array<Record<string, unknown>>;
} {
  const raw = pick<Record<string, unknown>>(artifact, ALLOWED_ARTIFACT_KEYS);
  const casesIn = Array.isArray(raw.cases) ? raw.cases : [];
  return {
    suiteName: typeof raw.suiteName === "string" ? raw.suiteName : "Eval run",
    runNumber: typeof raw.runNumber === "number" ? raw.runNumber : null,
    outcome: typeof raw.outcome === "string" ? raw.outcome : "unknown",
    aggregate: pick(raw.aggregate, ALLOWED_AGGREGATE_KEYS),
    cases: casesIn.map((row) => {
      const projected = pick<Record<string, unknown>>(row, ALLOWED_CASE_KEYS);
      if (projected.judge) {
        projected.judge = pick(projected.judge, ALLOWED_JUDGE_KEYS);
      }
      return projected;
    }),
  };
}

export function EvalRunSharedPage({ token }: { token: string }) {
  const { loading, error, artifact } = useSharedArtifact({
    resourceType: "evalRun",
    token,
  });
  const view = projectEvalSharedView(artifact);

  return (
    <SharedArtifactPage title="Shared eval run" loading={loading} error={error}>
      <p className="text-sm text-muted-foreground">
        Frozen snapshot. Transcripts, tool arguments, credentials, and full
        server URLs are not included. Guests who opened this link are auditable
        browser sessions, not verified individuals.
      </p>
      <p className="text-sm">
        {view.suiteName}
        {view.runNumber != null ? ` · run ${view.runNumber}` : ""}
        {` · ${view.outcome}`}
      </p>
      <ul className="space-y-2 text-sm">
        {view.cases.map((row, index) => (
          <li
            key={`${String(row.name)}-${index}`}
            className="rounded border border-border/50 px-3 py-2"
          >
            <div className="font-medium">{String(row.name ?? "untitled")}</div>
            <div className="text-muted-foreground">{String(row.result ?? "")}</div>
          </li>
        ))}
      </ul>
    </SharedArtifactPage>
  );
}
