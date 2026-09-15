import { describe, expect, it } from "vitest";
import { detectCiMetadata } from "../src/conformance-ci.js";

describe("detectCiMetadata", () => {
  it("records clickable GitHub pull-request provenance", () => {
    expect(
      detectCiMetadata({
        GITHUB_ACTIONS: "true",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "MCPJam/inspector",
        GITHUB_SHA: "abcdef1234567890",
        GITHUB_REF: "refs/pull/4764/merge",
        GITHUB_REF_NAME: "4764/merge",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        MCPJAM_GITHUB_EVENT_PAYLOAD: JSON.stringify({
          number: 4764,
          pull_request: {
            number: 4764,
            html_url: "https://github.com/MCPJam/inspector/pull/4764",
            head: {
              ref: "feat/run-columns",
              repo: {
                full_name: "contributor/inspector",
                html_url: "https://github.com/contributor/inspector",
              },
            },
          },
        }),
      })
    ).toMatchObject({
      commitSha: "abcdef1234567890",
      branch: "feat/run-columns",
      pullRequestNumber: 4764,
      repositoryUrl: "https://github.com/MCPJam/inspector",
      prUrl: "https://github.com/MCPJam/inspector/pull/4764",
      branchUrl:
        "https://github.com/contributor/inspector/tree/feat%2Frun-columns",
      runId: "42.2",
    });
  });

  it("does not turn a pull request merge ref into a branch link", () => {
    const detected = detectCiMetadata({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "MCPJam/inspector",
      GITHUB_REF: "refs/pull/4764/merge",
      GITHUB_REF_NAME: "4764/merge",
    });
    expect(detected?.branch).toBeUndefined();
    expect(detected?.branchUrl).toBeUndefined();
  });

  it("links branch pushes to their repository", () => {
    expect(
      detectCiMetadata({
        GITHUB_ACTIONS: "1",
        GITHUB_REPOSITORY: "MCPJam/inspector",
        GITHUB_REF_NAME: "main",
      })?.branchUrl
    ).toBe("https://github.com/MCPJam/inspector/tree/main");
  });
});
