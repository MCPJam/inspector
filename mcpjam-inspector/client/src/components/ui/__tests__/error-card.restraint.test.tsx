import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describeAsSlug, describeError } from "@mcpjam/sdk/browser";
import { ErrorCard } from "../error-card";

/**
 * The expanded panel is only worth opening if every row in it carries
 * something the reader has not already been told. These are the cases where
 * the old card padded itself out instead: it repeated the headline under a
 * "RAW ERROR" heading, and for an unclassified error it printed developer
 * notes ("Unhandled error path", "file an issue so we can add it to the
 * catalog") to a customer under a red title.
 */
describe("ErrorCard restraint", () => {
  const openDetails = () => fireEvent.click(screen.getByText("Show details"));

  it("drops a raw row that only repeats the headline", () => {
    // `describeError` promotes an unclassified message into `oneLine`, so the
    // raw row would render the identical sentence a second time. The message
    // must be one the describer genuinely cannot place — anything matching a
    // catalog pattern gets catalog prose in `oneLine` and the raw row then
    // carries something new, which is the next test.
    const message = "the widget declined to elaborate";
    const normalized = describeError(new Error(message));
    expect(normalized.slug).toBe("internal/unknown");
    expect(normalized.oneLine).toBe(message);

    render(<ErrorCard error={normalized} />);

    // Nothing is left for the panel to hold, so the card does not offer a
    // disclosure that would open onto an empty box. The docs link takes the
    // toggle's place on the action row.
    expect(screen.queryByText("Show details")).not.toBeInTheDocument();
    expect(screen.queryByText("Raw error")).not.toBeInTheDocument();
    expect(screen.getByText("Learn more")).toBeInTheDocument();
  });

  it("offers the disclosure whenever the panel has something to hold", () => {
    const normalized = describeAsSlug(
      "auth/consent_required",
      new Error("x"),
    );
    render(<ErrorCard error={normalized} />);

    expect(screen.getByText("Show details")).toBeInTheDocument();
  });

  it("keeps the raw row when it carries text the headline does not", () => {
    const normalized = describeAsSlug(
      "transport/econnrefused",
      new Error("connect ECONNREFUSED 127.0.0.1:6277"),
    );
    render(<ErrorCard error={normalized} />);
    openDetails();

    expect(screen.getByText("Raw error")).toBeInTheDocument();
  });

  it("suppresses the file-an-issue filler for an unclassified error", () => {
    // Long enough that `oneLine` is truncated and the raw row therefore
    // carries something new, which keeps the disclosure. The panel is then
    // genuinely open and the absent headings mean suppression rather than a
    // panel that never rendered.
    const normalized = describeError(new Error("something odd. ".repeat(20)));
    expect(normalized.slug).toBe("internal/unknown");

    render(<ErrorCard error={normalized} />);
    openDetails();

    expect(screen.getByText("Raw error")).toBeInTheDocument();
    expect(screen.queryByText("Likely causes")).not.toBeInTheDocument();
    expect(screen.queryByText("Why this happened")).not.toBeInTheDocument();
    expect(screen.queryByText("Next steps")).not.toBeInTheDocument();
    expect(screen.queryByText(/file an issue/i)).not.toBeInTheDocument();
  });

  it("calls an unclassified failure a connection error, not an unknown one", () => {
    // "Unknown error" as a headline reads as a crash. The body already
    // carries the real text, so the title can say what kind of thing it was.
    render(
      <ErrorCard error={describeError(new Error("boom from the server"))} />,
    );

    expect(screen.getByText("Connection error")).toBeInTheDocument();
    expect(screen.queryByText("Unknown error")).not.toBeInTheDocument();
  });

  it("still admits to knowing nothing when there is no raw text at all", () => {
    render(<ErrorCard error={describeAsSlug("internal/unknown")} />);

    expect(screen.getByText("Unknown error")).toBeInTheDocument();
  });

  it("keeps a non-error severity off the destructive palette", () => {
    // A consent prompt is one click from resolved. Rendering it in the same
    // red as a dead transport is what made the surface read as broken.
    const { container } = render(
      <ErrorCard
        error={describeAsSlug("auth/consent_required", new Error("x"))}
      />,
    );

    expect(screen.getByRole("alert").className).not.toContain("destructive");
    expect(container.querySelector(".text-destructive")).toBeNull();
  });
});
