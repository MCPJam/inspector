import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { getFunctionName } from "convex/server";
import type { WebReconnectRequest } from "@/lib/web-accounts/api";
import { createWebAccountView } from "@/test/factories";
import { WebAccountReconnectPage } from "../WebAccountReconnectPage";

const state = vi.hoisted(() => ({
  flag: true,
  isAdmin: true,
  data: {} as Record<string, unknown>,
  signIn: vi.fn(),
  save: vi.fn(),
  handback: vi.fn(),
  copy: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: state.toast }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "web-clients-enabled" ? state.flag : false,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQueries: (queries: Record<string, { query: never }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query }]) => [
        key,
        state.data[getFunctionName(query)],
      ]),
    ),
}));
vi.mock("@/hooks/useProjects", () => ({
  useCanManageProjectClients: () => ({
    canManage: state.isAdmin,
    isLoading: false,
  }),
}));
vi.mock("@/lib/web-accounts/routes", () => ({
  startWebAccountSignIn: state.signIn,
  saveWebAccountProfile: state.save,
  handBackWebReconnect: state.handback,
}));
vi.mock("../WebSignInBrowser", () => ({
  WebSignInBrowser: ({ chatSessionId }: { chatSessionId: string }) => (
    <div data-testid="sign-in-browser">{chatSessionId}</div>
  ),
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: state.copy }));

const account = createWebAccountView({
  webAccountId: "wa-1",
  status: "needs_sign_in",
});
const request: WebReconnectRequest = {
  requestId: "req-1",
  webAccountId: "wa-1",
  status: "open",
  reason: "claude.ai showed its sign-in page.",
  openedAt: 1,
  waitingRunCount: 2,
};

function visit(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/web-accounts/:webAccountId/reconnect"
          element={<WebAccountReconnectPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
const withRequest = "/web-accounts/wa-1/reconnect?request=req-1&project=project-1";

describe("WebAccountReconnectPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.flag = true;
    state.isAdmin = true;
    state.data = {
      "webClients:listWebAccounts": [account],
      "webClientReconnect:listWebReconnectRequests": [request],
    };
    state.signIn.mockResolvedValue({
      browserSessionId: "session-1",
      chatSessionId: "chat-1",
    });
  });
  afterEach(cleanup);

  it("renders nothing while the flag is off", () => {
    state.flag = false;
    visit(withRequest);
    expect(screen.queryByTestId("web-account-reconnect")).toBeNull();
  });

  it("lets an admin take over, sign in and resume the waiting runs", async () => {
    state.handback.mockResolvedValue({ status: "resumed", resumedRuns: 2 });
    visit(withRequest);
    const page = screen.getByTestId("web-account-reconnect");
    expect(page).toHaveTextContent("Sign in to claude.ai again");
    expect(page).toHaveTextContent("claude.ai showed its sign-in page.");
    expect(page).toHaveTextContent("2 runs wait for this account");
    await userEvent.click(
      screen.getByRole("button", { name: "Take over the browser" }),
    );
    expect(state.signIn).toHaveBeenCalledWith("project-1", "wa-1");
    // The pane attaches by the browser's chat; saving names the browser.
    expect(await screen.findByTestId("sign-in-browser")).toHaveTextContent(
      "chat-1",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Finish and resume runs" }),
    );
    expect(state.handback).toHaveBeenCalledWith("project-1", "req-1");
    expect(await screen.findByTestId("reconnect-outcome")).toHaveTextContent(
      "claude.ai is signed in again. 2 waiting runs resumed.",
    );
  });

  it.each([
    [
      "not_signed_in",
      "claude.ai doesn't show a signed-in account yet. Finish signing in, then try again.",
    ],
    [
      "wrong_identity",
      "The browser is signed in to another claude.ai account. Sign in as qa@example.com, then try again.",
    ],
    [
      "not_found",
      "This sign-in request no longer exists. Check the account in its client's Browser settings.",
    ],
  ] as const)("says what to do when the handback is %s", async (status, text) => {
    state.handback.mockResolvedValue({ status });
    visit(withRequest);
    await userEvent.click(
      screen.getByRole("button", { name: "Take over the browser" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Finish and resume runs" }),
    );
    expect(await screen.findByTestId("reconnect-outcome")).toHaveTextContent(
      text,
    );
  });

  it("saves the sign-in for the project when no runs wait", async () => {
    state.data["webClientReconnect:listWebReconnectRequests"] = [];
    state.save.mockResolvedValue({ ok: true, accountEmail: "qa@example.com" });
    visit("/web-accounts/wa-1/reconnect?project=project-1");
    await userEvent.click(
      screen.getByRole("button", { name: "Take over the browser" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Save for the project" }),
    );
    expect(state.save).toHaveBeenCalledWith("project-1", "wa-1", "session-1");
    expect(state.handback).not.toHaveBeenCalled();
  });

  it("hands back the account's open request when the link names none", async () => {
    state.handback.mockResolvedValue({ status: "resumed", resumedRuns: 1 });
    visit("/web-accounts/wa-1/reconnect?project=project-1");
    await userEvent.click(
      screen.getByRole("button", { name: "Take over the browser" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Finish and resume runs" }),
    );
    expect(state.handback).toHaveBeenCalledWith("project-1", "req-1");
  });

  it("tells a member who can finish it and offers a link for an admin", async () => {
    state.isAdmin = false;
    state.copy.mockResolvedValue(true);
    visit(withRequest);
    expect(screen.getByTestId("web-account-reconnect")).toHaveTextContent(
      "A project admin, by signing in here.",
    );
    expect(
      screen.queryByRole("button", { name: "Take over the browser" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Copy link for an admin" }),
    );
    await waitFor(() =>
      expect(state.toast.success).toHaveBeenCalledWith(
        "Link copied. Send it to a project admin.",
      ),
    );
  });

  it("says the browser couldn't open, and keeps Take over", async () => {
    state.signIn.mockRejectedValue(new Error("unavailable"));
    visit(withRequest);
    await userEvent.click(
      screen.getByRole("button", { name: "Take over the browser" }),
    );
    expect(await screen.findByTestId("reconnect-outcome")).toHaveTextContent(
      "Couldn't open a browser to sign in to claude.ai. Try again.",
    );
    expect(
      screen.getByRole("button", { name: "Take over the browser" }),
    ).toBeEnabled();
  });

  it("shows a closed request's result without actions", () => {
    state.data["webClientReconnect:listWebReconnectRequests"] = [
      { ...request, status: "resolved", resolvedAt: 2 },
    ];
    visit(withRequest);
    expect(screen.getByTestId("web-account-reconnect")).toHaveTextContent(
      "This account was signed in again, and its waiting runs resumed.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when the account isn't in the project", () => {
    state.data["webClients:listWebAccounts"] = [];
    visit(withRequest);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't find this web account in the project. Ask a project admin for a new link.",
    );
  });
});
