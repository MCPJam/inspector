import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { WebAccount } from "@/lib/web-accounts/api";
import { useWebClientPane } from "../WebClientPane";
import { WebAccountChip } from "../WebAccountChip";
import { SaveWebAccountBar } from "../SaveWebAccountBar";

const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  navigate: vi.fn(),
  copy: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-web-accounts", () => ({ useWebAccounts: mocks.accounts }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  navigateApp: mocks.navigate,
}));

const ready: WebAccount = {
  webAccountId: "wa-1",
  vendor: "claude",
  accountEmail: "qa@example.com",
  status: "ready",
  isDefault: true,
  allowLocalRuns: false,
};
const signedOut: WebAccount = { ...ready, status: "needs_sign_in" };

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
  pendingSignIn,
}: {
  accounts?: WebAccount[];
  isAdmin?: boolean;
  loaded?: boolean;
  local?: boolean;
  pendingSignIn?: { accountEmail: string; onSave: () => Promise<void> };
} = {}) {
  mocks.accounts.mockReturnValue({ accounts, isAdmin, loaded });
  return render(
    <Pane
      projectId="project-1"
      hostId="host-1"
      vendor="claude"
      local={local}
      pendingSignIn={pendingSignIn}
    />,
  );
}

describe("useWebClientPane", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("adds nothing for a client that isn't a web client", () => {
    mocks.accounts.mockReturnValue({
      accounts: [],
      isAdmin: false,
      loaded: true,
    });
    render(
      <Pane
        projectId="project-1"
        hostId="host-1"
        vendor={undefined}
        local={false}
      />,
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
    expect(blocked).toHaveTextContent("only a project admin can add one");
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

  it("starts no browser until an admin starts signing in", async () => {
    mount({ isAdmin: true });
    expect(screen.queryByTestId("browser-body")).toBeNull();
    expect(screen.getByTestId("web-pane-sign-in")).toHaveTextContent(
      "Sign in to claude.ai with your team's test account",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Start signing in" }),
    );
    expect(screen.getByTestId("browser-body")).toBeInTheDocument();
    expect(
      screen.getByText(/Sign in to claude.ai in the browser below/),
    ).toBeInTheDocument();
  });

  it("asks an admin to sign in again as the signed-out account", () => {
    mount({ isAdmin: true, accounts: [signedOut] });
    expect(screen.getByTestId("web-pane-sign-in")).toHaveTextContent(
      "Sign in to claude.ai as qa@example.com",
    );
    expect(
      screen.getByRole("button", { name: "Sign in again" }),
    ).toBeInTheDocument();
  });

  it("waits for the account list before choosing a view", () => {
    mount({ loaded: false });
    expect(screen.getByRole("status")).toHaveTextContent("Loading accounts…");
  });

  it("runs on this computer's browser with the person's own sign-in", () => {
    mount({ local: true });
    expect(screen.getByTestId("browser-body")).toBeInTheDocument();
    expect(screen.getByTestId("web-account-chip")).toHaveTextContent(
      "Your own sign-inThis computer",
    );
  });

  it("offers to save an admin's sign-in and saves nothing on its own", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount({
      isAdmin: true,
      pendingSignIn: { accountEmail: "qa@example.com", onSave },
    });
    expect(screen.getByTestId("save-web-account-bar")).toHaveTextContent(
      "Signed in as qa@example.com",
    );
    expect(onSave).not.toHaveBeenCalled();
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
});

describe("SaveWebAccountBar", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("saves for the project only when asked", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SaveWebAccountBar
        vendor="claude"
        accountEmail="qa@example.com"
        onSave={onSave}
      />,
    );
    expect(screen.getByTestId("save-web-account-bar")).toHaveTextContent(
      "Save it so members' runs on Claude web can use this claude.ai account.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save for the project" }),
    );
    expect(onSave).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "qa@example.com saved for the project.",
      ),
    );
  });

  it("says the save didn't happen and keeps the button", async () => {
    render(
      <SaveWebAccountBar
        vendor="claude"
        accountEmail="qa@example.com"
        onSave={vi.fn().mockRejectedValue(new Error("network"))}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save for the project" }),
    );
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Couldn't save the account. Try again.",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Save for the project" }),
    ).toBeEnabled();
  });
});
