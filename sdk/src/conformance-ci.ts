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
  env: NodeJS.ProcessEnv = process.env,
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
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const runId = env.GITHUB_RUN_ID;
  if (!runId) return undefined;
  const job = env.GITHUB_JOB ?? "conformance";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  return `gha:${runId}:${job}:${attempt}`;
}
