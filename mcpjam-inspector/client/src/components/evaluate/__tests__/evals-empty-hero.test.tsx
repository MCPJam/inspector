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
    expect(
      screen.getByText("Automate the checks you'd run by hand"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "We generate cases from a server you already use, then keep running them in CI.",
      ),
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

  it("starts the first-run preview from Eval my server, not Create suite", () => {
    const onEvalServer = vi.fn();
    render(
      <EvalsEmptyHero
        {...defaultProps}
        onEvalServer={onEvalServer}
        servers={[
          { id: "srv-1", name: "checkout-server" },
          { id: "srv-2", name: "payments-server" },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Eval my server: checkout-server" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Eval my server: payments-server" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^try sample suite$/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Eval my server: checkout-server" }),
    );
    expect(onEvalServer).toHaveBeenCalledTimes(1);
    expect(onEvalServer).toHaveBeenCalledWith({
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
      screen.getByRole("button", { name: "Eval my server: server-0" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `Eval my server: server-${EVALS_EMPTY_HERO_MAX_SERVERS - 1}`,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: `Eval my server: server-${EVALS_EMPTY_HERO_MAX_SERVERS}`,
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
