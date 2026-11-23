import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { WebAccount } from "@/lib/web-accounts/api";
import { createWebAccountView } from "@/test/factories";
import { useWebClientPane } from "../WebClientPane";
import { WebAccountChip } from "../WebAccountChip";

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

const ready = createWebAccountView({ webAccountId: "wa-1" });
const signedOut: WebAccount = { ...ready, status: "needs_sign_in" };

/** The panel's layout: the chip in its top bar, then the body. */
function Pane(props: Parameters<typeof useWebClientPane>[0]) {
  const parts = useWebClientPane(props);
  return (
    <>
      <div>
        {parts?.chip}
        <button type="button">Close browser panel</button>
      </div>
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

  it("tells an admin the project has no account, with no sign-in it can't finish", () => {
    mount({ isAdmin: true });
    expect(screen.queryByTestId("browser-body")).toBeNull();
    const pane = screen.getByTestId("web-pane-sign-in");
    expect(pane).toHaveTextContent(
      "This project has no Claude web account yet",
    );
    expect(pane).toHaveTextContent(
      "Runs on Claude web can't start until the project has a signed-in claude.ai account.",
    );
    // Signing in needs the runtime that opens the vendor's sign-in page.
    expect(within(pane).queryByRole("button")).toBeNull();
    expect(pane).not.toHaveTextContent(/below/);
  });

  it("tells an admin which account needs sign-in", () => {
    mount({ isAdmin: true, accounts: [signedOut] });
    expect(screen.getByTestId("web-pane-sign-in")).toHaveTextContent(
      "qa@example.com needs sign-in",
    );
    expect(
      within(screen.getByTestId("web-pane-sign-in")).queryByRole("button"),
    ).toBeNull();
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
