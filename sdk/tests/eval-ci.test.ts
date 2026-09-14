import { detectEvalCiMetadata, resolveEvalCiMetadata } from "../src/eval-ci.js";
import { ciFixtures, commitSha } from "./fixtures/eval-ci.js";

describe("SDK eval CI detection", () => {
  it.each(ciFixtures)(
    "detects $name without mutating the environment",
    ({ env, expected }) => {
      expect(detectEvalCiMetadata(Object.freeze({ ...env }))).toEqual(expected);
    }
  );

  it.each([{}, { GITHUB_SHA: commitSha }, { JENKINS_HOME: " " }])(
    "does not guess a provider from %j",
    (env) => {
      expect(detectEvalCiMetadata(env)).toBeUndefined();
    }
  );

  it.each([
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "BUILDKITE",
    "VERCEL",
    "NETLIFY",
  ])("requires an enabled %s flag", (flag) => {
    for (const value of ["false", "0", "", "yes"]) {
      expect(detectEvalCiMetadata({ [flag]: value })).toBeUndefined();
    }
    for (const value of ["true", "1"]) {
      expect(detectEvalCiMetadata({ [flag]: value })).toEqual({
        provider: expect.any(String),
      });
    }
  });

  it("uses the first matching provider without borrowing missing fields", () => {
    for (let i = 0; i < ciFixtures.length; i++) {
      const env = Object.assign(
        {},
        ...ciFixtures.slice(i).map((fixture) => fixture.env)
      );
      expect(detectEvalCiMetadata(env)).toEqual(ciFixtures[i].expected);
    }
    expect(
      detectEvalCiMetadata({ GITHUB_ACTIONS: "true", ...ciFixtures[1].env })
    ).toEqual({ provider: "github_actions" });
  });

  it("uses GitLab branch, merge-request branch, then tag/ref", () => {
    const env = {
      GITLAB_CI: "true",
      CI_COMMIT_BRANCH: "main",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature",
      CI_COMMIT_REF_NAME: "v1",
    };
    expect(detectEvalCiMetadata(env)?.branch).toBe("main");
    expect(
      detectEvalCiMetadata({ ...env, CI_COMMIT_BRANCH: " " })?.branch
    ).toBe("feature");
    expect(
      detectEvalCiMetadata({
        ...env,
        CI_COMMIT_BRANCH: "",
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "",
      })?.branch
    ).toBe("v1");
  });

  it("recognizes Jenkins home and preserves branch fallback values", () => {
    const env = {
      JENKINS_HOME: "/var/jenkins",
      BRANCH_NAME: "feature",
      GIT_LOCAL_BRANCH: "local",
      GIT_BRANCH: "origin/main",
    };
    expect(detectEvalCiMetadata(env)?.branch).toBe("feature");
    expect(detectEvalCiMetadata({ ...env, BRANCH_NAME: "" })?.branch).toBe(
      "local"
    );
    expect(
      detectEvalCiMetadata({ ...env, BRANCH_NAME: "", GIT_LOCAL_BRANCH: "" })
        ?.branch
    ).toBe("origin/main");
  });

  it("drops invalid automatic values without failing reporting", () => {
    expect(
      detectEvalCiMetadata({
        BUILDKITE: "true",
        BUILDKITE_COMMIT: "HEAD",
        BUILDKITE_BRANCH: "x".repeat(513),
        BUILDKITE_BUILD_ID: " ",
        BUILDKITE_JOB_ID: "  job-1  ",
        BUILDKITE_BUILD_URL: "file:///tmp/run",
      })
    ).toEqual({ provider: "buildkite", jobId: "job-1" });
    for (const runUrl of [
      "not-a-url",
      "javascript:alert(1)",
      "https://example.com/" + "x".repeat(512),
    ]) {
      expect(
        detectEvalCiMetadata({ BUILDKITE: "true", BUILDKITE_BUILD_URL: runUrl })
          ?.runUrl
      ).toBeUndefined();
    }
    expect(
      detectEvalCiMetadata({
        BUILDKITE: "true",
        BUILDKITE_COMMIT: "B".repeat(64),
        BUILDKITE_BRANCH: "x".repeat(512),
        BUILDKITE_BUILD_URL: "http://ci.example.com/run",
      })
    ).toEqual({
      provider: "buildkite",
      commitSha: "B".repeat(64),
      branch: "x".repeat(512),
      runUrl: "http://ci.example.com/run",
    });
  });

  it("keeps GitHub push identity and does not invent missing run URLs", () => {
    expect(
      detectEvalCiMetadata({
        GITHUB_ACTIONS: "1",
        GITHUB_SHA: commitSha,
        GITHUB_REF_NAME: "main",
        GITHUB_REPOSITORY: "acme/server",
        GITHUB_RUN_ID: "42",
      })
    ).toMatchObject({
      pipelineId: "42",
      branch: "main",
      runUrl: "https://github.com/acme/server/actions/runs/42",
    });
    expect(
      detectEvalCiMetadata({ GITHUB_ACTIONS: "1", GITHUB_RUN_ID: "42" })
    ).toEqual({ provider: "github_actions" });
  });

  it("preserves explicit settings and allows opting out with an empty object", () => {
    const ci = Object.freeze({
      provider: "custom",
      commitSha: "c".repeat(40),
      runUrl: "https://ci.example.com/run",
    });
    expect(resolveEvalCiMetadata(ci, ciFixtures[0].env)).toEqual({
      ...ciFixtures[0].expected,
      ...ci,
    });
    expect(resolveEvalCiMetadata({}, ciFixtures[0].env)).toEqual({});
    expect(resolveEvalCiMetadata(undefined, ciFixtures[0].env)).toEqual(
      ciFixtures[0].expected
    );
  });
  it("omits malformed explicit commit identity through the same sanitizer", () => {
    expect(resolveEvalCiMetadata({ commitSha: "not-a-sha" }, {})).toEqual({});
    expect(
      resolveEvalCiMetadata({ commitSha: "  " + "d".repeat(40) + "  " }, {})
    ).toEqual({ commitSha: "d".repeat(40) });
  });
});
