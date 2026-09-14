import type { EvalCiMetadata } from "../../src/eval-reporting-types.js";

export const commitSha = "a".repeat(40);
export const ciFixtures: Array<{
  name: string;
  env: NodeJS.ProcessEnv;
  expected: EvalCiMetadata;
}> = [
  {
    name: "GitHub Actions",
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: commitSha,
      GITHUB_REF_NAME: "123/merge",
      GITHUB_HEAD_REF: "feature/ci",
      GITHUB_REF: "refs/pull/123/merge",
      GITHUB_REPOSITORY: "acme/server",
      GITHUB_SERVER_URL: "https://github.example.com/",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_JOB: "evals",
    },
    expected: {
      provider: "github_actions",
      commitSha,
      branch: "feature/ci",
      pipelineId: "42.2",
      jobId: "evals",
      runUrl: "https://github.example.com/acme/server/actions/runs/42",
      repositoryUrl: "https://github.example.com/acme/server",
      prUrl: "https://github.example.com/acme/server/pull/123",
    },
  },
  {
    name: "GitLab CI",
    env: {
      GITLAB_CI: "true",
      CI_COMMIT_SHA: commitSha,
      CI_COMMIT_BRANCH: "main",
      CI_PIPELINE_ID: "42",
      CI_JOB_ID: "7",
      CI_PIPELINE_URL: "https://gitlab.example.com/acme/server/-/pipelines/42",
    },
    expected: {
      provider: "gitlab_ci",
      commitSha,
      branch: "main",
      pipelineId: "42",
      jobId: "7",
      runUrl: "https://gitlab.example.com/acme/server/-/pipelines/42",
    },
  },
  {
    name: "CircleCI",
    env: {
      CIRCLECI: "true",
      CIRCLE_SHA1: commitSha,
      CIRCLE_BRANCH: "main",
      CIRCLE_PIPELINE_ID: "pipeline-42",
      CIRCLE_WORKFLOW_JOB_ID: "job-7",
      CIRCLE_BUILD_URL: "https://circleci.com/gh/acme/server/42",
    },
    expected: {
      provider: "circleci",
      commitSha,
      branch: "main",
      pipelineId: "pipeline-42",
      jobId: "job-7",
      runUrl: "https://circleci.com/gh/acme/server/42",
    },
  },
  {
    name: "Buildkite",
    env: {
      BUILDKITE: "true",
      BUILDKITE_COMMIT: commitSha,
      BUILDKITE_BRANCH: "main",
      BUILDKITE_BUILD_ID: "build-42",
      BUILDKITE_JOB_ID: "job-7",
      BUILDKITE_BUILD_URL: "https://buildkite.com/acme/server/builds/42",
    },
    expected: {
      provider: "buildkite",
      commitSha,
      branch: "main",
      pipelineId: "build-42",
      jobId: "job-7",
      runUrl: "https://buildkite.com/acme/server/builds/42",
    },
  },
  {
    name: "Jenkins",
    env: {
      JENKINS_URL: "https://jenkins.example.com",
      GIT_COMMIT: commitSha,
      BRANCH_NAME: "main",
      BUILD_TAG: "jenkins-evals-42",
      JOB_NAME: "evals",
      BUILD_URL: "https://jenkins.example.com/job/evals/42/",
    },
    expected: {
      provider: "jenkins",
      commitSha,
      branch: "main",
      pipelineId: "jenkins-evals-42",
      jobId: "evals",
      runUrl: "https://jenkins.example.com/job/evals/42/",
    },
  },
  {
    name: "Vercel",
    env: {
      VERCEL: "1",
      VERCEL_GIT_COMMIT_SHA: commitSha,
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_DEPLOYMENT_ID: "dpl_42",
      VERCEL_URL: "server.vercel.app",
    },
    expected: {
      provider: "vercel",
      commitSha,
      branch: "main",
      pipelineId: "dpl_42",
    },
  },
  {
    name: "Netlify",
    env: {
      NETLIFY: "true",
      COMMIT_REF: commitSha,
      BRANCH: "main",
      BUILD_ID: "build-42",
      DEPLOY_URL: "https://server.netlify.app",
    },
    expected: {
      provider: "netlify",
      commitSha,
      branch: "main",
      pipelineId: "build-42",
    },
  },
];
