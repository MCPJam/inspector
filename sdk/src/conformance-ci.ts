/**
 * GitHub Actions / CI metadata for a conformance upload.
 *
 * Detected from the standard GITHUB_* environment, matching the eval reporter
 * so a composite CLI run and an eval run from the same job share identity.
 */

export type ConformanceCiMetadata = {
  provider?: string;
  repository?: string;
  commitSha?: string;
  branch?: string;
  pullRequestNumber?: number;
  workflow?: string;
  job?: string;
  runUrl?: string;
  runId?: string;
};

export function detectConformanceCiMetadata(
  env: NodeJS.ProcessEnv = process.env
): ConformanceCiMetadata | undefined {
  if (env.GITHUB_ACTIONS !== "true" && env.GITHUB_ACTIONS !== "1") {
    return undefined;
  }
  const repository = env.GITHUB_REPOSITORY;
  const rawServerUrl = env.GITHUB_SERVER_URL ?? "https://github.com";
  const serverUrl = rawServerUrl.endsWith("/")
    ? rawServerUrl.slice(0, -1)
    : rawServerUrl;
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = env.GITHUB_RUN_ATTEMPT;
  const prMatch = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
  return {
    provider: "github_actions",
    ...(repository ? { repository } : {}),
    ...(env.GITHUB_SHA ? { commitSha: env.GITHUB_SHA } : {}),
    ...(env.GITHUB_REF_NAME ? { branch: env.GITHUB_REF_NAME } : {}),
    ...(prMatch ? { pullRequestNumber: Number(prMatch[1]) } : {}),
    ...(env.GITHUB_WORKFLOW ? { workflow: env.GITHUB_WORKFLOW } : {}),
    ...(env.GITHUB_JOB ? { job: env.GITHUB_JOB } : {}),
    ...(repository && runId
      ? {
          runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
          runId: runAttempt ? `${runId}.${runAttempt}` : runId,
        }
      : {}),
  };
}

export function githubActionExternalRunId(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const runId = env.GITHUB_RUN_ID;
  if (!runId) return undefined;
  const job = env.GITHUB_JOB ?? "conformance";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  return `gha:${runId}:${job}:${attempt}`;
}

/**
 * The CI job this process is running inside, in the shape a RUN row stores.
 *
 * `detectConformanceCiMetadata` above speaks GitHub's own vocabulary
 * (`runId`, `job`, `repository`, `workflow`) because that is what a conformance
 * upload records. A run row speaks a provider-neutral one — `pipelineId`,
 * `jobId` — so a GitLab or Buildkite client is not forced to pretend to be
 * GitHub to fill it in.
 *
 * Rather than a second detector, this is a PROJECTION of the first: one place
 * decides what "we are in CI" means, so a composite CLI run and an eval run
 * from the same job cannot disagree about which commit they were. Fields with
 * no home in the run shape (`repository`, `workflow`, `pullRequestNumber`) are
 * dropped rather than folded into a neighbour — a `jobId` that sometimes means
 * the workflow name is worse than an absent one.
 *
 * `undefined` outside CI, which is the honest answer: a run launched from a
 * laptop has no pipeline, and inventing an empty envelope would make it look
 * like one was recorded.
 */
export type CiMetadata = {
  provider?: string;
  pipelineId?: string;
  jobId?: string;
  runUrl?: string;
  branch?: string;
  commitSha?: string;
};

export function detectCiMetadata(
  env: NodeJS.ProcessEnv = process.env
): CiMetadata | undefined {
  const detected = detectConformanceCiMetadata(env);
  if (!detected) return undefined;
  const ci: CiMetadata = {
    ...(detected.provider ? { provider: detected.provider } : {}),
    ...(detected.runId ? { pipelineId: detected.runId } : {}),
    ...(detected.job ? { jobId: detected.job } : {}),
    ...(detected.runUrl ? { runUrl: detected.runUrl } : {}),
    ...(detected.branch ? { branch: detected.branch } : {}),
    ...(detected.commitSha ? { commitSha: detected.commitSha } : {}),
  };
  return Object.keys(ci).length > 0 ? ci : undefined;
}

/**
 * Which of the three declarable origins this process is.
 *
 * Mirrors `detectSource` in `report-conformance-run.ts` — the same
 * `GITHUB_ACTIONS` probe, so a CLI invoked by an Action and a conformance
 * upload from the same job agree about where they came from. `fallback` is
 * what the process is when it is NOT in Actions: `"cli"` for the CLI, `"mcp"`
 * for the hosted MCP worker.
 *
 * Deliberately only ever returns a DECLARABLE kind. `api`, `sdk`, `ui` and
 * `schedule` are stamped by the server, and a client that claimed one would be
 * refused at the boundary anyway.
 */
export function detectLauncherKind(
  env: NodeJS.ProcessEnv = process.env,
  fallback: "cli" | "mcp"
): "cli" | "mcp" | "github_action" {
  if (env.GITHUB_ACTIONS === "true" || env.GITHUB_ACTIONS === "1") {
    return "github_action";
  }
  return fallback;
}
