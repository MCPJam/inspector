import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSecretsBoundary } from "../ProjectSecretsBoundary";

afterEach(() => vi.restoreAllMocks());

describe("ProjectSecretsBoundary", () => {
  it("contains rejected sessions and retries without exposing server details", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let rejected = true;
    function Secrets() {
      if (rejected)
        throw new Error(
          "[CONVEX Q(projectSecrets:listSecrets)] Authenticated user required at requireUserActor",
        );
      return <p>Secrets loaded</p>;
    }
    render(
      <>
        <p>Settings navigation</p>
        <ProjectSecretsBoundary>
          <Secrets />
        </ProjectSecretsBoundary>
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("sign in again");
    expect(screen.queryByText(/CONVEX/)).not.toBeInTheDocument();
    expect(screen.getByText("Settings navigation")).toBeVisible();
    rejected = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Secrets loaded")).toBeVisible();
  });

  it("shows a neutral fallback for other query failures", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Secrets(): never {
      throw new Error("internal database detail");
    }
    render(
      <ProjectSecretsBoundary>
        <Secrets />
      </ProjectSecretsBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("couldn’t be loaded");
    expect(
      screen.queryByText(/internal database detail/),
    ).not.toBeInTheDocument();
  });
});
