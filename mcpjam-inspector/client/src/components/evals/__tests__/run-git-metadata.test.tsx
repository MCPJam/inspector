import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  readRunGitMetadata,
  readRunPullRequest,
  RunBranchCell,
  RunCommitCell,
  RunPullRequestCell,
} from "../run-git-metadata";

describe("run Git metadata", () => {
  it("uses recorded PR URLs, supports enterprise hosts, and never treats workflow IDs as PRs", () => {
    expect(
      readRunPullRequest({ prUrl: "https://github.com/acme/server/pull/4674" }),
    ).toEqual({
      url: "https://github.com/acme/server/pull/4674",
      number: "4674",
    });
    expect(
      readRunPullRequest({ prUrl: "https://git.acme.com/acme/server/pull/12" })
        ?.number,
    ).toBe("12");
    expect(
      readRunPullRequest({ runUrl: "https://github.com/acme/server/pull/42" })
        ?.number,
    ).toBe("42");
    for (const prUrl of [
      "javascript:alert(1)",
      "https://user:token@github.com/acme/server/pull/42",
      "https://github.com/acme/server/actions/runs/4674",
      "not-a-url",
    ]) {
      expect(readRunPullRequest({ prUrl })).toBeNull();
    }
    expect(readRunPullRequest(null)).toBeNull();
    expect(
      readRunPullRequest({
        runUrl: "https://github.com/acme/server/actions/runs/4674",
      }),
    ).toBeNull();
  });
  it("shows commit, PR, and branch as separate links", () => {
    const metadata = {
      branch: "feat/evals",
      commitSha: "abcdef1234567890",
      runUrl: "https://github.com/acme/server/actions/runs/123",
      prUrl: "https://github.com/acme/server/pull/4764",
      pipelineId: "123",
      jobId: "evals",
    };
    const git = readRunGitMetadata(metadata);
    expect(git.repository).toBe("acme/server");
    render(
      <>
        <RunCommitCell git={git} />
        <RunPullRequestCell git={git} />
        <RunBranchCell git={git} />
      </>,
    );
    expect(screen.getByRole("link", { name: "abcdef1" })).toHaveAttribute(
      "href",
      "https://github.com/acme/server/commit/abcdef1234567890",
    );
    expect(screen.getByRole("link", { name: "#4764" })).toHaveAttribute(
      "href",
      "https://github.com/acme/server/pull/4764",
    );
    expect(screen.getByRole("link", { name: "feat/evals" })).toHaveAttribute(
      "href",
      "https://github.com/acme/server/tree/feat%2Fevals",
    );
    expect(screen.getByRole("link", { name: "abcdef1" })).toHaveAttribute(
      "title",
      "abcdef1234567890",
    );
  });

  it("uses explicit fork and enterprise branch destinations", () => {
    const git = readRunGitMetadata({
      branch: "feat/fork",
      commitSha: "abcdef1234567890",
      repositoryUrl: "https://git.acme.com/fork/server",
      branchUrl: "https://git.acme.com/fork/server/tree/feat%2Ffork",
      prUrl: "https://git.acme.com/base/server/pull/12",
    });
    expect(git.commitUrl).toBe(
      "https://git.acme.com/fork/server/commit/abcdef1234567890",
    );
    expect(git.branchUrl).toBe(
      "https://git.acme.com/fork/server/tree/feat%2Ffork",
    );
    expect(git.pullRequestUrl).toBe("https://git.acme.com/base/server/pull/12");
  });

  it("does not fabricate a repository from another provider or a lookalike domain", () => {
    expect(
      readRunGitMetadata({ runUrl: "https://github.com.example/acme/repo" })
        .repository,
    ).toBeNull();
    expect(
      readRunGitMetadata({ runUrl: "https://gitlab.com/acme/repo" }).repository,
    ).toBeNull();
    expect(readRunGitMetadata({ branch: "main" }).repository).toBeNull();
  });

  it("withholds unsafe URLs and clearly marks missing metadata", () => {
    for (const runUrl of [
      "javascript:alert(1)",
      "data:text/html,test",
      "https://user:token@github.com/acme/repo",
      "not-a-url",
    ]) {
      expect(readRunGitMetadata({ runUrl }).runUrl).toBeNull();
    }
    render(<RunCommitCell git={null} />);
    expect(screen.getByText("—")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
