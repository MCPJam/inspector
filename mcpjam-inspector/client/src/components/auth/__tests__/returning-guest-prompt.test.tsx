import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReturningGuestDialog } from "../returning-guest-prompt";
import { resetGuestVisitForTests } from "@/lib/returning-guest";

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  signUp: vi.fn(),
  captureReturn: vi.fn(),
  user: null as { id: string } | null,
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mocks.user, isLoading: false }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
vi.mock("@/hooks/use-inspector-auth", () => ({
  useInspectorAuth: () => ({ signUp: mocks.signUp, signIn: vi.fn() }),
}));
vi.mock("@/lib/app-signin-return-path", () => ({
  captureAppSignInReturnPath: mocks.captureReturn,
}));
vi.mock("@/lib/permalink-signin-return", () => ({
  permalinkSignInOptions: () => ({ state: "return" }),
}));

const DAY = 24 * 60 * 60 * 1000;

function seedPreviousVisit(lastActiveAt: number) {
  localStorage.setItem(
    "mcpjam:returning-guest-v1",
    JSON.stringify({
      lastActiveAt,
      visitStartedAt: lastActiveAt,
      visitCount: 1,
    }),
  );
}

function eventsNamed(name: string) {
  return mocks.track.mock.calls.filter(([event]) => event === name);
}

describe("returning guest dialog", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGuestVisitForTests();
    mocks.track.mockClear();
    mocks.signUp.mockClear();
    mocks.user = null;
  });

  it("shows nothing on a guest's first visit", () => {
    render(<ReturningGuestDialog enabled />);
    expect(screen.queryByTestId("returning-guest-dialog")).toBeNull();
  });

  it("shows nothing to a signed-in user", () => {
    mocks.user = { id: "user_1" };
    seedPreviousVisit(Date.now() - DAY);
    render(<ReturningGuestDialog enabled />);
    expect(screen.queryByTestId("returning-guest-dialog")).toBeNull();
  });

  it("waits for the announcement queue to be enabled", () => {
    seedPreviousVisit(Date.now() - DAY);
    render(<ReturningGuestDialog enabled={false} />);
    expect(screen.queryByTestId("returning-guest-dialog")).toBeNull();
  });

  it("asks a returning guest once per visit", () => {
    seedPreviousVisit(Date.now() - DAY);
    const { unmount } = render(<ReturningGuestDialog enabled />);
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
    expect(eventsNamed("returning_guest_prompt_shown")).toEqual([
      [
        "returning_guest_prompt_shown",
        expect.objectContaining({ prompt: "dialog", visit_number: 2 }),
      ],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Welcome back")).toBeNull();
    expect(eventsNamed("returning_guest_prompt_dismissed")).toHaveLength(1);

    unmount();
    render(<ReturningGuestDialog enabled />);
    expect(screen.queryByText("Welcome back")).toBeNull();
  });

  it("starts sign-up from the dialog", () => {
    seedPreviousVisit(Date.now() - DAY);
    render(<ReturningGuestDialog enabled />);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(mocks.track).toHaveBeenCalledWith(
      "sign_up_button_clicked",
      expect.objectContaining({ location: "returning_guest_dialog" }),
    );
    expect(mocks.captureReturn).toHaveBeenCalled();
    expect(mocks.signUp).toHaveBeenCalledWith({ state: "return" });
  });

  it("starts the next day's visit on input with the tab left open", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      seedPreviousVisit(start - DAY);
      render(<ReturningGuestDialog enabled />);
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(screen.queryByText("Welcome back")).toBeNull();

      vi.setSystemTime(start + DAY);
      expect(screen.queryByText("Welcome back")).toBeNull();

      act(() => {
        fireEvent.pointerDown(document);
      });
      expect(screen.getByText("Welcome back")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
