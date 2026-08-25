import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EVALS_EMPTY_HERO_MAX_SERVERS,
  EvalsEmptyHero,
} from "../evals-empty-hero";

const defaultProps = {
  onCreateSuite: vi.fn(),
  onQuickstart: vi.fn(),
  isQuickstartRunning: false,
  showQuickstart: true,
};

describe("EvalsEmptyHero", () => {
  it("renders the illustration-led empty state and wires Create suite", () => {
    const onCreateSuite = vi.fn();
    render(
      <EvalsEmptyHero
        {...defaultProps}
        onCreateSuite={onCreateSuite}
      />,
    );

    expect(screen.getByTestId("evals-empty-hero")).toBeTruthy();
    expect(screen.getByText("Create your first eval suite")).toBeTruthy();
    expect(
      screen.getByText("Start from a server you've already connected."),
    ).toBeTruthy();
    expect(screen.queryByText("What a suite looks like")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^create suite$/i }));
    expect(onCreateSuite).toHaveBeenCalledTimes(1);
  });

  it("wires Try sample suite when quickstart is available", () => {
    const onQuickstart = vi.fn();
    render(
      <EvalsEmptyHero {...defaultProps} onQuickstart={onQuickstart} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^try sample suite$/i }));
    expect(onQuickstart).toHaveBeenCalledTimes(1);
  });

  it("hides Try sample suite when quickstart is unavailable", () => {
    render(<EvalsEmptyHero {...defaultProps} showQuickstart={false} />);

    expect(
      screen.queryByRole("button", { name: /^try sample suite$/i }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /^create suite$/i }),
    ).toBeTruthy();
  });

  it("keeps Create suite and Try sample suite alongside project server cards", () => {
    const onCreateSuiteFromServer = vi.fn();
    render(
      <EvalsEmptyHero
        {...defaultProps}
        onCreateSuiteFromServer={onCreateSuiteFromServer}
        servers={[
          { id: "srv-1", name: "checkout-server" },
          { id: "srv-2", name: "payments-server" },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Create suite from checkout-server" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create suite from payments-server" }),
    ).toBeTruthy();
    // The quickstart has no other entry point in the product, so a project
    // that already has servers must not lose it.
    expect(
      screen.getByRole("button", { name: /^try sample suite$/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^create suite$/i }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Create suite from checkout-server" }),
    );
    expect(onCreateSuiteFromServer).toHaveBeenCalledTimes(1);
    expect(onCreateSuiteFromServer).toHaveBeenCalledWith({
      id: "srv-1",
      name: "checkout-server",
    });
  });

  it("caps server cards so the hero does not overflow", () => {
    const servers = Array.from({ length: EVALS_EMPTY_HERO_MAX_SERVERS + 2 }, (_, i) => ({
      id: `srv-${i}`,
      name: `server-${i}`,
    }));
    render(<EvalsEmptyHero {...defaultProps} servers={servers} />);

    expect(
      screen.getByRole("button", { name: "Create suite from server-0" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `Create suite from server-${EVALS_EMPTY_HERO_MAX_SERVERS - 1}`,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: `Create suite from server-${EVALS_EMPTY_HERO_MAX_SERVERS}`,
      }),
    ).toBeNull();
  });

  it("holds the CTAs until project servers finish loading", () => {
    render(
      <EvalsEmptyHero {...defaultProps} servers={[]} serversLoading />,
    );

    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^try sample suite$/i }),
    ).toBeNull();
  });
});
