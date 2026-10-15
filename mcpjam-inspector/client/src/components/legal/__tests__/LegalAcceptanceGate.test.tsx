import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LegalAcceptanceGate,
  type LegalAcceptanceStatus,
} from "../LegalAcceptanceGate";

const state = vi.hoisted(() => ({
  workosUser: null as { id: string } | null,
  convexAuthenticated: false,
  dbUserReady: false,
  status: undefined as unknown,
  statusRequests: [] as unknown[],
  accept: vi.fn(),
  reportCaught: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("convex/react", async () =>
  (await import("@/test/mocks/convex-use-queries")).withUseQueries({
    useConvexAuth: () => ({
      isAuthenticated: state.convexAuthenticated,
      isLoading: false,
    }),
    useQuery: (name: string, args: unknown) => {
      if (name !== "legalAcceptance:getStatus") return undefined;
      state.statusRequests.push(args);
      return state.status;
    },
    useMutation: () => state.accept,
  }),
);

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: state.workosUser }),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => state.dbUserReady,
}));

vi.mock("@/lib/error-reporting", () => ({
  reportCaught: state.reportCaught,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: state.toastError },
}));

const pending: LegalAcceptanceStatus = {
  needsAcceptance: true,
  termsVersion: "2026-01-29",
  privacyVersion: "2026-01-31",
  minimumAge: 16,
};

function signIn() {
  state.workosUser = { id: "user_1" };
  state.convexAuthenticated = true;
  state.dbUserReady = true;
}

describe("LegalAcceptanceGate", () => {
  beforeEach(() => {
    state.workosUser = null;
    state.convexAuthenticated = false;
    state.dbUserReady = false;
    state.status = undefined;
    state.statusRequests = [];
    state.accept.mockReset();
    state.reportCaught.mockReset();
    state.toastError.mockReset();
  });

  it("asks a signed-in user who has not accepted, with the backend's minimum age", () => {
    signIn();
    state.status = pending;

    render(<LegalAcceptanceGate />);

    expect(
      screen.getByRole("dialog", {
        name: "Accept the Terms and Privacy Policy",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("I am at least 16 years old.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Terms of Use" })).toHaveAttribute(
      "href",
      "https://www.mcpjam.com/terms-of-use",
    );
    expect(
      screen.getByRole("link", { name: "Privacy Policy" }),
    ).toHaveAttribute("href", "https://www.mcpjam.com/privacy-policy");
    expect(
      screen.getByRole("button", { name: "Accept and continue" }),
    ).toBeDisabled();
  });

  it("records the versions shown and closes once the status reports acceptance", async () => {
    signIn();
    state.status = pending;
    state.accept.mockImplementation(async () => {
      state.status = { ...pending, needsAcceptance: false };
      return { alreadyAccepted: false };
    });
    const user = userEvent.setup();
    const { rerender } = render(<LegalAcceptanceGate />);

    await user.click(screen.getByLabelText("I am at least 16 years old."));
    await user.click(
      screen.getByRole("button", { name: "Accept and continue" }),
    );

    expect(state.accept).toHaveBeenCalledWith({
      termsVersion: "2026-01-29",
      privacyVersion: "2026-01-31",
      ageConfirmed: true,
    });
    rerender(<LegalAcceptanceGate />);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("stays closed for a user who has already accepted", () => {
    signIn();
    state.status = { ...pending, needsAcceptance: false };

    render(<LegalAcceptanceGate />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never asks the backend for a guest with a Convex identity", () => {
    state.convexAuthenticated = true;
    state.dbUserReady = true;
    state.status = pending;

    render(<LegalAcceptanceGate />);

    expect(state.statusRequests).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never asks the backend when there is no Convex identity", () => {
    state.workosUser = { id: "user_1" };
    state.status = pending;

    render(<LegalAcceptanceGate />);

    expect(state.statusRequests).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets the user in when the status query fails", () => {
    signIn();
    state.status = new Error(
      "[CONVEX Q(legalAcceptance:getStatus)] Could not find public function",
    );

    render(<LegalAcceptanceGate />);

    expect(state.statusRequests).toEqual([{}]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a version refusal without reporting it, and keeps the dialog open", async () => {
    signIn();
    state.status = pending;
    state.accept.mockRejectedValue(
      new ConvexError({
        code: "CONFLICT",
        message: "The Terms or Privacy Policy changed since this page loaded.",
      }),
    );
    const user = userEvent.setup();
    render(<LegalAcceptanceGate />);

    await user.click(screen.getByLabelText("I am at least 16 years old."));
    await user.click(
      screen.getByRole("button", { name: "Accept and continue" }),
    );

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        "The Terms or Privacy Policy changed since this page loaded.",
      ),
    );
    expect(state.reportCaught).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("reports an unexpected save failure", async () => {
    signIn();
    state.status = pending;
    const failure = new Error("network down");
    state.accept.mockRejectedValue(failure);
    const user = userEvent.setup();
    render(<LegalAcceptanceGate />);

    await user.click(screen.getByLabelText("I am at least 16 years old."));
    await user.click(
      screen.getByRole("button", { name: "Accept and continue" }),
    );

    await waitFor(() =>
      expect(state.reportCaught).toHaveBeenCalledWith(failure, {
        source: "legal_acceptance_accept",
      }),
    );
    expect(state.toastError).toHaveBeenCalled();
  });
});
