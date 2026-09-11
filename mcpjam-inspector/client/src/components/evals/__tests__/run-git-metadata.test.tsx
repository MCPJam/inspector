import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  readRunGitMetadata,
  readRunPullRequest,
  RunGitMetadata,
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
  it("reads the repository from a recorded GitHub URL and shows branch, SHA, and CI links", () => {
    const metadata = {
      branch: "feat/evals",
      commitSha: "abcdef1234567890",
      runUrl: "https://github.com/acme/server/actions/runs/123",
      pipelineId: "123",
      jobId: "evals",
    };
    expect(readRunGitMetadata(metadata).repository).toBe("acme/server");
    render(<RunGitMetadata metadata={metadata} />);
    expect(screen.getByRole("link", { name: "acme/server" })).toHaveAttribute(
      "href",
      "https://github.com/acme/server",
    );
    expect(screen.getByRole("link", { name: "abcdef1" })).toHaveAttribute(
      "href",
      "https://github.com/acme/server/commit/abcdef1234567890",
    );
    expect(screen.getByRole("link", { name: "Open CI run" })).toHaveAttribute(
      "href",
      metadata.runUrl,
    );
    expect(screen.getByText("feat/evals")).toBeVisible();
    expect(screen.getByText("Pipeline 123 · Job evals")).toBeVisible();
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
    render(<RunGitMetadata metadata={null} />);
    expect(screen.getByText("Not recorded")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
