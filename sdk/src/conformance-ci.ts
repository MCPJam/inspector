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

/**
 * The CI envelope for ANY MCPJam upload — a conformance report, or an eval-run
 * launch declaring where it came from.
 *
 * `detectConformanceCiMetadata` is the original name and still works; it is an
 * alias now. The shape was never conformance-specific, and the eval side needs
 * exactly the same fields, so the alternative was a second detector reading
 * the same eight environment variables and drifting from this one.
 *
 * SPELLINGS ARE GITHUB'S, not the run row's. The platform maps `runId` →
 * `pipelineId` and `job` → `jobId` at its header boundary, and drops the three
 * a run row has no column for. One mapping in one place beats every caller
 * learning two vocabularies.
 */
export function detectCiMetadata(
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

/**
 * The original name, kept as an alias.
 *
 * Renaming the export outright would break every importer at once for no gain
 * — including `@mcpjam/cli` versions already published against it. Same
 * function, one call site's worth of history.
 */
export const detectConformanceCiMetadata = detectCiMetadata;

/** What a launching process may DECLARE itself as. Mirrors the platform's allowlist. */
export type LauncherKind = "cli" | "mcp" | "github_action";

/**
 * The launcher this process should declare, from the environment.
 *
 * Mirrors `detectSource` in `report-conformance-run.ts` exactly — the same
 * `GITHUB_ACTIONS` test, deliberately, so a composite CLI run and an eval run
 * from the same job never disagree about which they came from.
 *
 * `fallback` is what the process is when it is NOT in CI: `"cli"` for the
 * command-line tool, `"mcp"` for the hosted worker. There is no default: a
 * caller that cannot say what it is has no business declaring anything.
 */
export function detectLauncherKind(
  env: NodeJS.ProcessEnv = process.env,
  fallback: LauncherKind,
): LauncherKind {
  if (env.GITHUB_ACTIONS === "true" || env.GITHUB_ACTIONS === "1") {
    return "github_action";
  }
  return fallback;
}
