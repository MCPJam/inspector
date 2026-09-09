import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunSourceBadge } from "../run-source-badge";

/**
 * The badge answers "where did this run come from", which stopped being a
 * one-field question: `source` is stamped server-side, so a CLI run, a GitHub
 * Actions job and an MCP agent all arrive as `api`. The precedence it resolves
 * — verified surface, then declared launcher, then the stamp — is the property
 * worth pinning, along with the fact that a declared origin SAYS it is
 * declared.
 */
describe("RunSourceBadge", () => {
  it("labels every stamped source", () => {
    const cases: Array<[string, string]> = [
      ["ui", "UI"],
      ["sdk", "SDK"],
      ["api", "API"],
      ["schedule", "Scheduled"],
      ["github_check", "GitHub"],
    ];

    for (const [source, label] of cases) {
      const { unmount } = render(
        <RunSourceBadge run={{ source: source as never }} />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("prefers a declared launcher over the stamp it was given", () => {
    // The whole reason this field exists: the server stamps `api` for all
    // three declarable launchers, so the stamp alone renders three different
    // things identically.
    const cases: Array<[string, string]> = [
      ["cli", "CLI"],
      ["mcp", "MCP"],
      ["github_action", "GitHub"],
    ];
    for (const [kind, label] of cases) {
      const { unmount } = render(
        <RunSourceBadge
          run={{ source: "api", launcher: { kind: kind as never } }}
        />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("lets a verified surface outrank a declared launcher", () => {
    render(
      <RunSourceBadge
        run={{
          source: "api",
          launcher: { kind: "cli" },
          attribution: { surface: "mcp" },
        }}
      />,
    );
    // A claim must never outrank a proof.
    expect(screen.getByText("MCP")).toBeTruthy();
  });

  it("does NOT promote a verified surface that says less than the launcher", () => {
    render(
      <RunSourceBadge
        run={{
          source: "api",
          // `rest` is what any API key looks like from the token's side.
          // Promoting it would relabel an Actions job as a plain REST call.
          launcher: { kind: "github_action" },
          attribution: { surface: "rest" },
        }}
      />,
    );
    expect(screen.getByText("GitHub")).toBeTruthy();
  });

  it("says when an origin is a claim rather than a stamp", () => {
    render(<RunSourceBadge run={{ source: "api", launcher: { kind: "cli" } }} />);
    // A badge that presented a claim and a proof identically would erase the
    // distinction from the one place a person reads it.
    expect(screen.getByTitle(/declared by the launching client/i)).toBeTruthy();
    render(<RunSourceBadge run={{ source: "github_check" }} />);
    expect(screen.getByTitle(/GitHub pull-request check$/i)).toBeTruthy();
  });

  it("treats a legacy run with no source at all as UI", () => {
    // Rows predating the field, and rows from a backend that predates run
    // provenance entirely — neither may crash or render blank.
    render(<RunSourceBadge run={{}} />);
    expect(screen.getByText("UI")).toBeTruthy();
  });

  it("falls back to the suite's provenance for a run with no source", () => {
    render(<RunSourceBadge run={{ suiteSource: "sdk" }} />);
    expect(screen.getByText("SDK")).toBeTruthy();
  });

  it("calls a VERIFIED mcp run verified, not declared", () => {
    // `mcp` is the one origin that arrives both ways. Reading claim-vs-proof
    // off the origin VALUE labelled a run the backend had verified from its
    // credential as something the client merely said — which is the exact
    // distinction the two-layer design exists to keep.
    render(
      <RunSourceBadge
        run={{
          source: "api",
          launcher: { kind: "mcp", client: "claude-code" },
          attribution: { surface: "mcp" },
        }}
      />,
    );
    expect(screen.getByTitle(/verified from the credential/i)).toBeTruthy();
    expect(screen.queryByTitle(/declared by the launching client/i)).toBeNull();
  });

  it("still calls an unverified mcp run declared", () => {
    render(
      <RunSourceBadge
        run={{ source: "api", launcher: { kind: "mcp", client: "some-agent" } }}
      />,
    );
    expect(screen.getByTitle(/declared by the launching client/i)).toBeTruthy();
  });
});
