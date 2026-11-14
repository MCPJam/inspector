/**
 * `FieldError` exists to make `role="alert"` the default rather than something
 * a caller has to remember. These tests pin that guarantee, including against a caller
 * who passes `role` themselves, plus the empty-body behaviour that keeps a live
 * region from announcing a blank string.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { FieldError } from "../components/field-error";

afterEach(cleanup);

describe("FieldError", () => {
  it("announces its message as an alert", () => {
    render(<FieldError>Couldn&apos;t save: enter a server URL.</FieldError>);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't save: enter a server URL.",
    );
  });

  it("keeps role=alert even when a caller passes their own role", () => {
    // The spread sits BEFORE `role` in the component for exactly this case:
    // the accessibility guarantee is the component's reason to exist, so it is
    // not something a call site can switch off by accident.
    render(
      <FieldError role="status" data-testid="field-error">
        Couldn&apos;t connect.
      </FieldError>,
    );

    expect(screen.getByTestId("field-error")).toHaveAttribute("role", "alert");
  });

  it("renders nothing when there is no message", () => {
    // Callers hold the message in a nullable variable and write
    // `<FieldError>{error}</FieldError>` directly. An empty live region must
    // not announce a blank string.
    const { container } = render(<FieldError>{null}</FieldError>);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders an empty string as nothing, but zero as a message", () => {
    const { container, rerender } = render(<FieldError>{""}</FieldError>);
    expect(container).toBeEmptyDOMElement();

    // `0` is a legitimate body (a count, a limit), so the guard checks for
    // null/empty rather than falsiness.
    rerender(<FieldError>{0}</FieldError>);
    expect(screen.getByRole("alert")).toHaveTextContent("0");
  });

  it("forwards an id so an input can point at it with aria-describedby", () => {
    // `role="alert"` only covers the moment the message appears. The
    // association is what a screen reader follows afterwards, and it needs the
    // id to survive.
    render(<FieldError id="url-error">Enter the URL.</FieldError>);

    expect(screen.getByRole("alert")).toHaveAttribute("id", "url-error");
  });

  it("merges a caller's className with the destructive text styles", () => {
    render(<FieldError className="mt-2">Enter the URL.</FieldError>);

    const message = screen.getByRole("alert");
    expect(message).toHaveClass("mt-2");
    expect(message).toHaveClass("text-destructive");
  });
});
