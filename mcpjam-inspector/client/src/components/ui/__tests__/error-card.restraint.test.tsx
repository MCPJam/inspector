import { ERROR_MESSAGES } from "@/lib/error-messages";
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

  it("keeps unknown backend text behind the diagnostic disclosure", () => {
    const message = "the widget declined to elaborate";
    render(<ErrorCard error={describeError(new Error(message))} />);
    expect(screen.getByText(ERROR_MESSAGES.unexpected)).toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    openDetails();
    expect(screen.getByText("Raw error")).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
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

  it("gives unclassified failures a catalog headline", () => {
    // "Unknown error" as a headline reads as a crash. The body already
    // carries the real text, so the title can say what kind of thing it was.
    render(
      <ErrorCard error={describeError(new Error("boom from the server"))} />,
    );

    expect(screen.getByText(ERROR_MESSAGES.unknownErrorTitle)).toBeInTheDocument();
    expect(screen.queryByText("Unknown error")).not.toBeInTheDocument();
  });

  it("uses the same safe headline when diagnostic text is empty", () => {
    render(<ErrorCard error={describeAsSlug("internal/unknown")} />);

    expect(screen.getByText(ERROR_MESSAGES.unknownErrorTitle)).toBeInTheDocument();
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
