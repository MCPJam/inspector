import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { WebApiError } from "@/lib/apis/web/base";
import type { WebAccount } from "@/lib/web-accounts/api";
import type { SaveProfileResult } from "@/lib/web-accounts/routes";
import { createWebAccountView } from "@/test/factories";
import { useWebClientPane } from "../WebClientPane";
import { WebAccountChip } from "../WebAccountChip";
import { SaveWebAccountBar } from "../SaveWebAccountBar";

const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  create: vi.fn(),
  signIn: vi.fn(),
  release: vi.fn(),
  save: vi.fn(),
  navigate: vi.fn(),
  copy: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/browser-shell/chat-handoff", () => ({
  releaseBrowserForChat: mocks.release,
  withBrowserForAgent: async (projectId: string, sessionId: string, task: () => Promise<unknown>) => {
    await mocks.release(projectId, sessionId);
    return task();
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-web-accounts", () => ({ useWebAccounts: mocks.accounts }));
vi.mock("convex/react", () => ({ useMutation: () => mocks.create }));
vi.mock("@/lib/web-accounts/routes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-accounts/routes")>()),
  startWebAccountSignIn: mocks.signIn,
  saveWebAccountProfile: mocks.save,
}));
// The hosted browser body has its own suite; here it only names its session.
vi.mock("../WebSignInBrowser", () => ({
  WebSignInBrowser: ({ chatSessionId }: { chatSessionId: string }) => (
    <div data-testid="sign-in-browser">{chatSessionId}</div>
  ),
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  navigateApp: mocks.navigate,
}));

const ready = createWebAccountView({ webAccountId: "wa-1" });
const signedOut: WebAccount = { ...ready, status: "needs_sign_in" };
/** Made, but nobody has signed it in yet: no profile, never verified. */
const neverSignedIn: WebAccount = {
  ...ready,
  status: "needs_sign_in",
  accountEmail: undefined,
  hasProfile: false,
  lastVerifiedAt: undefined,
};

/** The panel's layout: the chip in its top bar, the banner, then the body. */
function Pane(props: Parameters<typeof useWebClientPane>[0]) {
  const parts = useWebClientPane(props);
  return (
    <>
      <div>
        {parts?.chip}
        <button type="button">Close browser panel</button>
      </div>
      {parts?.banner}
      {parts?.blocker ?? <div data-testid="browser-body" />}
    </>
  );
}

function mount({
  accounts = [] as WebAccount[],
  isAdmin = false,
  loaded = true,
  local = false,
}: {
  accounts?: WebAccount[];
  isAdmin?: boolean;
  loaded?: boolean;
  local?: boolean;
} = {}) {
  mocks.accounts.mockReturnValue({ accounts, isAdmin, loaded });
  return render(
    <Pane projectId="project-1" hostId="host-1" vendor="claude" local={local} />,
  );
}

describe("useWebClientPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ webAccountId: "wa-new" });
    mocks.signIn.mockResolvedValue({
      browserSessionId: "session-1",
      chatSessionId: "chat-1",
    });
  });
  afterEach(cleanup);

  it("adds nothing for a client that isn't a web client", () => {
    mocks.accounts.mockReturnValue({ accounts: [], isAdmin: false, loaded: true });
    render(
      <Pane projectId="project-1" hostId="host-1" vendor={undefined} local={false} />,
    );
    expect(screen.getByTestId("browser-body")).toBeInTheDocument();
    expect(screen.queryByTestId("web-account-chip")).toBeNull();
  });

  it("shows the run's browser and its account once the project has one", () => {
    mount({ accounts: [ready] });
    expect(screen.getByTestId("browser-body")).toBeInTheDocument();
    expect(screen.getByTestId("web-account-chip")).toHaveTextContent(
      "qa@example.com",
    );
    expect(
      screen.getByRole("button", { name: "Close browser panel" }),
    ).toBeInTheDocument();
  });

  it("starts no browser for a member without an account, and hands them a link for an admin", async () => {
    mocks.copy.mockResolvedValue(true);
    mount();
    expect(screen.queryByTestId("browser-body")).toBeNull();
    const blocked = screen.getByTestId("web-pane-blocked");
    expect(blocked).toHaveTextContent(
      "This project has no Claude web account yet",
    );
    expect(blocked).toHaveTextContent("Ask a project admin to sign in");
    await userEvent.click(
      screen.getByRole("button", { name: "Copy link for an admin" }),
    );
    expect(mocks.copy).toHaveBeenCalledWith(
      `${window.location.origin}/hosts/host-1?hostTab=browser`,
    );
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "Link copied. Send it to a project admin.",
      ),
    );
  });

  it("tells a member the default account needs sign-in", () => {
    mount({ accounts: [signedOut] });
    expect(screen.getByTestId("web-pane-blocked")).toHaveTextContent(
      "qa@example.com needs sign-in",
    );
    expect(screen.getByTestId("web-account-chip")).toHaveTextContent(
      "Needs sign-in",
    );
  });

  it("makes a project's first account, then opens its sign-in browser", async () => {
    mount({ isAdmin: true });
    expect(screen.queryByTestId("browser-body")).toBeNull();
    expect(screen.getByTestId("web-pane-sign-in")).toHaveTextContent(
      "Sign in to claude.ai with your team's test account",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Start signing in" }),
    );
    expect(mocks.create).toHaveBeenCalledWith({
      projectId: "project-1",
      vendor: "claude",
      label: "Claude web account",
    });
    expect(mocks.signIn).toHaveBeenCalledWith("project-1", "wa-new");
    // The pane attaches by the browser's chat; saving names the browser.
    expect(await screen.findByTestId("sign-in-browser")).toHaveTextContent(
      "chat-1",
    );
    expect(screen.getByTestId("save-web-account-bar")).toBeInTheDocument();
  });

  it("signs the signed-out account in again, without making another", async () => {
    mount({ isAdmin: true, accounts: [signedOut] });
    expect(screen.getByTestId("web-pane-sign-in")).toHaveTextContent(
      "Sign in to claude.ai as qa@example.com",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.signIn).toHaveBeenCalledWith("project-1", "wa-1");
  });

  it("doesn't say the site signed out an account nobody has signed in yet", async () => {
    mount({ isAdmin: true, accounts: [neverSignedIn] });
    const pane = screen.getByTestId("web-pane-sign-in");
    expect(pane).toHaveTextContent("Sign in here, then save the account");
    expect(pane).not.toHaveTextContent("signed this account out");
    await userEvent.click(
      screen.getByRole("button", { name: "Start signing in" }),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.signIn).toHaveBeenCalledWith("project-1", "wa-1");
  });

  it("asks a member for an admin's first sign-in, not a sign-in again", () => {
    mount({ accounts: [neverSignedIn] });
    const pane = screen.getByTestId("web-pane-blocked");
    expect(pane).toHaveTextContent(
      "Ask a project admin to sign in to claude.ai with this account.",
    );
    expect(pane).not.toHaveTextContent("signed this account out");
  });

  it("saves the signed-in browser and goes back to the run's browser", async () => {
    mocks.save.mockResolvedValue({ ok: true, accountEmail: "qa@example.com" });
    mount({ isAdmin: true, accounts: [signedOut] });
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Save for the project" }),
    );
    expect(mocks.release).toHaveBeenCalledWith("project-1", "chat-1");
    expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]);
    expect(mocks.save).toHaveBeenCalledWith("project-1", "wa-1", "session-1");
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "qa@example.com saved for the project.",
      ),
    );
    expect(screen.queryByTestId("sign-in-browser")).toBeNull();
  });

  it("keeps the sign-in open and lets the admin retry a failed handback", async () => {
    mocks.release.mockRejectedValueOnce(new Error("disconnected"));
    mocks.save.mockResolvedValue({ ok: true, accountEmail: "qa@example.com" });
    mount({ isAdmin: true, accounts: [signedOut] });
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    const save = await screen.findByRole("button", { name: "Save for the project" });
    await userEvent.click(save);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByTestId("sign-in-browser")).toBeInTheDocument();
    await userEvent.click(save);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("says the browser couldn't open and keeps the button", async () => {
    mocks.signIn.mockRejectedValue(new Error("unavailable"));
    mount({ isAdmin: true, accounts: [signedOut] });
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Couldn't open a browser to sign in to claude.ai. Try again.",
      ),
    );
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
  });

  it("shows the route's own refusal when the sign-in browser can't open", async () => {
    const refusal =
      "Only a project admin can sign in a web account. Ask an admin to sign it in.";
    mocks.signIn.mockRejectedValue(new WebApiError(403, refusal, refusal));
    mount({ isAdmin: true, accounts: [signedOut] });
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(refusal),
    );
  });

  it("shows the route's own refusal when the save can't go through", async () => {
    const refusal =
      "This web account is not in the project. Refresh the list, then try again.";
    mocks.save.mockRejectedValueOnce(new WebApiError(404, refusal, refusal));
    mount({ isAdmin: true, accounts: [signedOut] });
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in again" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Save for the project" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.getByTestId("sign-in-browser")).toBeInTheDocument();
  });

  it("waits for the account list before choosing a view", () => {
    mount({ loaded: false });
    expect(screen.getByRole("status")).toHaveTextContent("Loading accounts…");
    // Not "No account yet": the project may well have one.
    expect(screen.getByTestId("web-account-chip")).toHaveTextContent(
      "Loading account…",
    );
  });

  it("runs on this computer's browser with the person's own sign-in", () => {
    mount({ local: true });
    expect(screen.getByTestId("browser-body")).toBeInTheDocument();
    expect(screen.getByTestId("web-account-chip")).toHaveTextContent(
      "Your own sign-inThis computer",
    );
  });
});

describe("WebAccountChip", () => {
  afterEach(cleanup);

  it("opens the client's Browser settings", async () => {
    render(<WebAccountChip vendor="chatgpt" hostId="host-1" account={ready} />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "ChatGPT web account: qa@example.com. Open Browser settings",
      }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/hosts/host-1?hostTab=browser",
    );
  });

  it("says when the project has no account", () => {
    render(<WebAccountChip vendor="claude" hostId="host-1" />);
    expect(screen.getByTestId("web-account-chip")).toHaveTextContent(
      "No account yet",
    );
  });

  it("claims nothing about the account until the list loads", () => {
    render(<WebAccountChip vendor="claude" hostId="host-1" loaded={false} />);
    const chip = screen.getByRole("button", {
      name: "Claude web account loading. Open Browser settings",
    });
    expect(chip).toHaveTextContent("Loading account…");
    expect(chip).not.toHaveTextContent("No account yet");
  });
});

describe("SaveWebAccountBar", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const save = async (
    onSave: () => Promise<SaveProfileResult>,
    expectedEmail?: string,
  ) => {
    render(
      <SaveWebAccountBar
        vendor="claude"
        expectedEmail={expectedEmail}
        onSave={onSave}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save for the project" }),
    );
  };

  it("names the account it saved", async () => {
    await save(() => Promise.resolve({ ok: true, accountEmail: "qa@example.com" }));
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "qa@example.com saved for the project.",
      ),
    );
  });

  it.each([
    [
      "not_signed_in",
      "claude.ai doesn't show a signed-in account yet. Finish signing in, then save again.",
    ],
    [
      "wrong_account",
      "The browser is signed in to another claude.ai account. Sign in as qa@example.com, then save again.",
    ],
    [
      "version_conflict",
      "Someone saved this account first. Check it in Browser settings, and sign in again only if it still needs it.",
    ],
  ] as const)("says what to do when the save is refused: %s", async (reason, text) => {
    await save(() => Promise.resolve({ ok: false, reason }), "qa@example.com");
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(
      screen.getByRole("button", { name: "Save for the project" }),
    ).toBeEnabled();
  });

  it("shows the retry instruction when the server kept the browser open", async () => {
    const message = "Couldn’t capture this browser profile. Keep the browser open and save again.";
    await save(() => Promise.reject(new WebApiError(503, "WEB_ACCOUNT_PROFILE_RETRY", message)));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Save for the project" })).toBeEnabled();
  });

  it("says the save didn't happen when the request fails", async () => {
    await save(() => Promise.reject(new Error("network")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The account wasn't saved because the request didn't finish.",
    );
  });
});
