import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { describeAsSlug, type NormalizedError } from "@mcpjam/sdk/browser";
import { ErrorCard } from "../error-card";

const BADGE = "error-card-origin-badge";

function normalizedFor(slug: string): NormalizedError {
  return describeAsSlug(slug, new Error(`synthetic ${slug}`));
}

describe("ErrorCard origin badge", () => {
  it("tells the user a user-config failure is not an MCPJam outage", () => {
    render(<ErrorCard error={normalizedFor("transport/econnrefused")} />);

    expect(screen.getByTestId(BADGE)).toHaveTextContent("Not an MCPJam outage");
  });

  it("uses the same badge for a user_server failure", () => {
    // The user_server/user_config split drives capture policy, not copy: both
    // mean "waiting on MCPJam will not fix this".
    render(<ErrorCard error={normalizedFor("jsonrpc/internal_error")} />);

    expect(screen.getByTestId(BADGE)).toHaveTextContent("Not an MCPJam outage");
  });

  it("owns an MCPJam-origin failure out loud", () => {
    render(
      <ErrorCard error={normalizedFor("sdk/not_yet_supported_in_stateless")} />,
    );

    expect(screen.getByTestId(BADGE)).toHaveTextContent("MCPJam issue");
    expect(screen.getByText(/This one is on us/)).toBeInTheDocument();
  });

  it("shows no badge when the evidence does not settle the question", () => {
    render(<ErrorCard error={normalizedFor("transport/etimedout")} />);

    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it("shows no badge for a payload from a server that predates origins", () => {
    // `normalized` blocks cross a wire. An older server sends one with no
    // `origin` field at all, and inventing an attribution for it would be
    // worse than saying nothing.
    const legacy = normalizedFor("transport/econnrefused");
    delete (legacy as { origin?: unknown }).origin;

    render(<ErrorCard error={legacy} />);

    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it("does not crash on a garbage origin value", () => {
    const tampered = {
      ...normalizedFor("transport/econnrefused"),
      origin: "not-a-real-origin",
    } as unknown as NormalizedError;

    render(<ErrorCard error={tampered} />);

    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it("still renders the catalog's own prose rather than per-origin copy", () => {
    // The badge answers "whose fault"; the slug's entry answers "what now".
    const normalized = normalizedFor("transport/econnrefused");
    render(<ErrorCard error={normalized} />);

    expect(screen.getByText(normalized.oneLine)).toBeInTheDocument();
  });
});
