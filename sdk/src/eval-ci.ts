import { detectCiMetadata } from "./conformance-ci.js";
import type { EvalCiMetadata } from "./eval-reporting-types.js";

// Match the backend's CI field limit without letting optional labels break uploads.
const MAX_FIELD_CHARS = 512;

function field(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= MAX_FIELD_CHARS ? trimmed : undefined;
}

function enabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function sanitize(metadata: EvalCiMetadata): EvalCiMetadata {
  const result: EvalCiMetadata = {};
  for (const key of [
    "provider",
    "commitSha",
    "branch",
    "pipelineId",
    "jobId",
    "runUrl",
    "repositoryUrl",
    "prUrl",
    "branchUrl",
  ] as const) {
    const value = field(metadata[key]);
    if (!value) continue;
    if (key === "commitSha" && !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) {
      continue;
    }
    if (["runUrl", "repositoryUrl", "prUrl", "branchUrl"].includes(key)) {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        if (url.username || url.password) continue;
      } catch {
        continue;
      }
    }
    result[key] = value;
  }
  if (metadata.dirty !== undefined) {
    if (typeof metadata.dirty !== "boolean")
      throw new TypeError("ci.dirty must be boolean");
    result.dirty = metadata.dirty;
  }
  if (metadata.pullRequestNumber !== undefined) {
    if (
      !Number.isSafeInteger(metadata.pullRequestNumber) ||
      metadata.pullRequestNumber < 1
    )
      throw new TypeError("ci.pullRequestNumber must be a positive integer");
    result.pullRequestNumber = metadata.pullRequestNumber;
  }
  return result;
}

/** Eval uploads use the backend's canonical CI names, unlike conformance uploads. */
export function detectEvalCiMetadata(
  env: NodeJS.ProcessEnv = process.env
): EvalCiMetadata | undefined {
  if (["0", "false"].includes(env.MCPJAM_CI_AUTODETECT ?? "")) return undefined;
  let metadata: EvalCiMetadata;
  const github = detectCiMetadata(env);
  if (github) {
    metadata = {
      provider: github.provider,
      commitSha: github.commitSha,
      branch: github.branch,
      pipelineId: github.runId,
      jobId: github.job,
      runUrl: github.runUrl,
      repositoryUrl: github.repositoryUrl,
      prUrl: github.prUrl,
    };
  } else if (enabled(env.GITLAB_CI)) {
    metadata = {
      provider: "gitlab_ci",
      commitSha: env.CI_COMMIT_SHA,
      branch:
        field(env.CI_COMMIT_BRANCH) ??
        field(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME) ??
        env.CI_COMMIT_REF_NAME,
      pipelineId: env.CI_PIPELINE_ID,
      jobId: env.CI_JOB_ID,
      runUrl: env.CI_PIPELINE_URL,
    };
  } else if (enabled(env.CIRCLECI)) {
    metadata = {
      provider: "circleci",
      commitSha: env.CIRCLE_SHA1,
      branch: env.CIRCLE_BRANCH,
      pipelineId: env.CIRCLE_PIPELINE_ID,
      jobId: env.CIRCLE_WORKFLOW_JOB_ID,
      runUrl: env.CIRCLE_BUILD_URL,
    };
  } else if (enabled(env.BUILDKITE)) {
    metadata = {
      provider: "buildkite",
      commitSha: env.BUILDKITE_COMMIT,
      branch: env.BUILDKITE_BRANCH,
      pipelineId: env.BUILDKITE_BUILD_ID,
      jobId: env.BUILDKITE_JOB_ID,
      runUrl: env.BUILDKITE_BUILD_URL,
    };
  } else if (env.JENKINS_URL?.trim() || env.JENKINS_HOME?.trim()) {
    metadata = {
      provider: "jenkins",
      commitSha: env.GIT_COMMIT,
      branch:
        field(env.BRANCH_NAME) ?? field(env.GIT_LOCAL_BRANCH) ?? env.GIT_BRANCH,
      pipelineId: env.BUILD_TAG,
      jobId: env.JOB_NAME,
      runUrl: env.BUILD_URL,
    };
  } else if (enabled(env.VERCEL)) {
    metadata = {
      provider: "vercel",
      commitSha: env.VERCEL_GIT_COMMIT_SHA,
      branch: env.VERCEL_GIT_COMMIT_REF,
      pipelineId: env.VERCEL_DEPLOYMENT_ID,
    };
  } else if (enabled(env.NETLIFY)) {
    metadata = {
      provider: "netlify",
      commitSha: env.COMMIT_REF,
      branch: env.BRANCH,
      pipelineId: env.BUILD_ID,
    };
  } else if (enabled(env.CI)) {
    metadata = {
      provider: "ci",
      branch: env.CI_COMMIT_BRANCH,
      commitSha: env.CI_COMMIT_SHA,
    };
  } else {
    return undefined;
  }
  return sanitize(metadata);
}

/** An explicit object is authoritative, including an empty object (opt-out). */
export function resolveEvalCiMetadata(
  ci: EvalCiMetadata | undefined,
  env: NodeJS.ProcessEnv = process.env
): EvalCiMetadata | undefined {
  if (ci && Object.keys(ci).length === 0) return {};
  if (ci) {
    for (const [key, value] of Object.entries(ci)) {
      if (value === undefined || key === "dirty" || key === "pullRequestNumber")
        continue;
      if (typeof value !== "string" || value.trim().length > MAX_FIELD_CHARS)
        throw new TypeError(`Invalid CI metadata field: ${key}`);
      if (["runUrl", "repositoryUrl", "prUrl", "branchUrl"].includes(key)) {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new TypeError(`Invalid CI URL: ${key}`);
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new TypeError(`Invalid CI URL: ${key}`);
      }
    }
  }
  return ci === undefined
    ? detectEvalCiMetadata(env)
    : {
        ...detectEvalCiMetadata(env),
        ...sanitize(ci),
      };
}
