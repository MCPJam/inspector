import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunSourceBadge } from "../run-source-badge";

/**
 * The badge answers "where did this run come from", and the reason it takes
 * three fields rather than one is that `source` alone cannot answer it: the
 * server stamps every `/v1` launch `api`, so a CLI run, a GitHub Action and an
 * MCP agent were three different things wearing one label.
 */
describe("RunSourceBadge", () => {
  it("labels every value of the stamped source union", () => {
    const cases: Array<
      [Parameters<typeof RunSourceBadge>[0]["source"], string]
    > = [
      ["ui", "UI"],
      ["sdk", "SDK"],
      ["api", "API"],
      ["schedule", "Scheduled"],
      ["github_check", "GitHub"],
    ];

    for (const [source, label] of cases) {
      const { unmount } = render(<RunSourceBadge source={source} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("treats a legacy run with no source as UI", () => {
    // Rows predating the field. Same fallback `getRunMetricSource` uses.
    render(<RunSourceBadge source={undefined} />);
    expect(screen.getByText("UI")).toBeTruthy();
  });

  it("carries an explanatory title for each origin", () => {
    render(<RunSourceBadge source="github_check" />);
    expect(screen.getByTitle(/GitHub/i)).toBeTruthy();
  });

  it("prefers a DECLARED launcher over the coarse stamp", () => {
    const cases: Array<
      [NonNullable<Parameters<typeof RunSourceBadge>[0]["launcher"]>, string]
    > = [
      [{ kind: "cli" }, "CLI"],
      [{ kind: "mcp" }, "MCP"],
      [{ kind: "github_action" }, "GitHub"],
    ];

    for (const [launcher, label] of cases) {
      // Every one of these is stamped `api`, which is true and useless.
      const { unmount } = render(
        <RunSourceBadge source="api" launcher={launcher} />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("says a declared label is declared", () => {
    render(<RunSourceBadge source="api" launcher={{ kind: "cli" }} />);
    // The reader should be able to tell "the client told us" from "we know".
    expect(screen.getByTitle(/Declared by the launching client/i)).toBeTruthy();
  });

  it("prefers a VERIFIED channel over what the client declared", () => {
    render(
      <RunSourceBadge
        source="api"
        launcher={{ kind: "cli" }}
        attribution={{ surface: "mcp" }}
      />,
    );
    // The credential is the half nobody can forge, so it wins outright.
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.queryByText("CLI")).toBeNull();
  });

  it("does NOT let a plain REST credential overwrite a declared label", () => {
    render(
      <RunSourceBadge
        source="api"
        launcher={{ kind: "cli", client: "mcpjam-cli" }}
        attribution={{ surface: "rest", apiKeyId: "key_live_1" }}
      />,
    );
    // `rest` is what an ordinary API call mints — every CLI run has one. If it
    // outranked the label, the whole feature would collapse back to "API".
    expect(screen.getByText("CLI")).toBeTruthy();
  });

  it("folds an Action launch and a PR check into one GitHub badge", () => {
    const check = render(<RunSourceBadge source="github_check" />);
    expect(screen.getByText("GitHub")).toBeTruthy();
    check.unmount();

    render(
      <RunSourceBadge source="api" launcher={{ kind: "github_action" }} />,
    );
    // Two mechanisms, one answer to "where did this come from".
    expect(screen.getByText("GitHub")).toBeTruthy();
  });
});
