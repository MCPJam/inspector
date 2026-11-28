import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import type { WebAccount } from "@/lib/web-accounts/api";
import { createWebAccountView } from "@/test/factories";
import { WebAccountsSettings } from "../WebAccountsSettings";

const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  navigate: vi.fn(),
  savePreviewed: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-web-accounts", () => ({ useWebAccounts: mocks.accounts }));
vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    mocks.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return mocks.mutations[name];
  },
}));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  navigateApp: mocks.navigate,
}));
vi.mock("@/lib/previewed-client-storage", () => ({
  savePreviewedHostId: mocks.savePreviewed,
}));

// Radix menus read pointer capture, which jsdom does not implement.
for (const name of [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
])
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    value: vi.fn(() => false),
  });

const qa = createWebAccountView({ webAccountId: "wa-qa" });
const evals = createWebAccountView({
  webAccountId: "wa-evals",
  label: "Evals bot",
  accountEmail: "evals@example.com",
  status: "needs_sign_in",
  isDefault: false,
});

function mount(isAdmin: boolean, accounts: WebAccount[] = [qa, evals]) {
  mocks.accounts.mockReturnValue({ accounts, loaded: true, isAdmin });
  render(
    <WebAccountsSettings
      projectId="project-1"
      hostId="host-1"
      vendor="claude"
    />,
  );
}

const call = (name: string) => mocks.mutations[`webClients:${name}`];

describe("WebAccountsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutations = {};
  });
  afterEach(cleanup);

  it("lists the client's accounts in sign-in words, never token words", async () => {
    const user = userEvent.setup();
    mount(true);
    expect(
      screen.getByText("The claude.ai accounts this client's runs sign in as."),
    ).toBeInTheDocument();
    expect(screen.getByText("QA team")).toBeInTheDocument();
    expect(screen.getByText("qa@example.com · Default")).toBeInTheDocument();
    expect(screen.getByText("Needs sign-in")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/token|Needs reconnect/i);

    await user.click(screen.getByRole("button", { name: /^Manage Evals bot/ }));
    expect(
      await screen.findByRole("menuitem", { name: "Sign in again" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Reconnect" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "MCPJam will remove this account and its saved sign-in.",
    );
    await user.click(screen.getByRole("button", { name: "Remove account" }));
    await waitFor(() =>
      expect(call("removeWebAccount")).toHaveBeenCalledWith({
        webAccountId: "wa-evals",
      }),
    );
  });

  it("lets an admin allow local runs for every account, in a client's words", async () => {
    const user = userEvent.setup();
    mount(true);
    await user.click(screen.getByRole("switch", { name: "Allow local runs" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Allow local runs for this client?");
    expect(dialog).toHaveTextContent("saved sign-ins");
    expect(dialog.textContent).not.toMatch(/token|server/i);
    await user.click(screen.getByRole("button", { name: "Allow local runs" }));
    await waitFor(() =>
      expect(call("setWebAccountAllowLocalRuns")).toHaveBeenCalledTimes(2),
    );
    expect(call("setWebAccountAllowLocalRuns")).toHaveBeenCalledWith({
      webAccountId: "wa-qa",
      allowLocalRuns: true,
    });
  });

  it("tells an admin when only some accounts allow local runs, and keeps the notes for all and none", () => {
    const notes = {
      some: "Some of these accounts' saved sign-ins can be used by members' local apps. Stop turns all of them off.",
      all: "Members' local apps can use these accounts' saved sign-ins.",
      none: "Members' hosted runs use these accounts. Turn this on so their local apps can too.",
    };
    const states: Array<[keyof typeof notes, WebAccount[]]> = [
      ["some", [{ ...qa, allowLocalRuns: true }, evals]],
      [
        "all",
        [
          { ...qa, allowLocalRuns: true },
          { ...evals, allowLocalRuns: true },
        ],
      ],
      ["none", [qa, evals]],
    ];
    for (const [state, accounts] of states) {
      mount(true, accounts);
      const toggle = screen.getByRole("switch", { name: "Allow local runs" });
      // Mixed stays on, so Stop is one step away.
      if (state === "none") expect(toggle).not.toBeChecked();
      else expect(toggle).toBeChecked();
      for (const [other, note] of Object.entries(notes))
        if (other === state) expect(screen.getByText(note)).toBeInTheDocument();
        else expect(screen.queryByText(note)).toBeNull();
      cleanup();
    }
  });

  it("lets an admin stop local runs while only some accounts allow them", async () => {
    const user = userEvent.setup();
    mount(true, [{ ...qa, allowLocalRuns: true }, evals]);
    const toggle = screen.getByRole("switch", { name: "Allow local runs" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "Stop local runs for this client?",
    );
    await user.click(screen.getByRole("button", { name: "Stop local runs" }));
    await waitFor(() =>
      expect(call("setWebAccountAllowLocalRuns")).toHaveBeenCalledTimes(2),
    );
    for (const webAccountId of ["wa-qa", "wa-evals"])
      expect(call("setWebAccountAllowLocalRuns")).toHaveBeenCalledWith({
        webAccountId,
        allowLocalRuns: false,
      });
  });

  it("sends an admin to the playground's pane to sign in", async () => {
    const user = userEvent.setup();
    mount(true, []);
    await user.click(
      screen.getByRole("button", { name: "Connect an account" }),
    );
    expect(mocks.savePreviewed).toHaveBeenCalledWith("project-1", "host-1");
    expect(mocks.navigate).toHaveBeenCalledWith("/playground");
  });

  it("signs a chosen account in again on its own page, not the default's", async () => {
    const user = userEvent.setup();
    mount(true);
    await user.click(screen.getByRole("button", { name: /^Manage Evals bot/ }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Sign in again" }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/web-accounts/wa-evals/reconnect?project=project-1",
    );
    expect(mocks.savePreviewed).not.toHaveBeenCalled();
  });

  it("sets the default and renames through the web account functions", async () => {
    const user = userEvent.setup();
    mount(true, [qa, { ...evals, status: "ready" }]);
    await user.click(screen.getByRole("button", { name: /^Manage Evals bot/ }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Set as default" }),
    );
    await waitFor(() =>
      expect(call("setDefaultWebAccount")).toHaveBeenCalledWith({
        webAccountId: "wa-evals",
      }),
    );
  });

  it("shows a member the list without menus or the local runs switch", () => {
    mount(false);
    expect(screen.getByText("QA team")).toBeInTheDocument();
    expect(screen.getByText("qa@example.com · Default")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Connect another account")).toBeNull();
    expect(
      screen.getByText(/ask a project admin to turn on Allow local runs/),
    ).toBeInTheDocument();
  });

  it("tells a member their local app can use the accounts only when every one allows it", () => {
    mount(false, [{ ...qa, allowLocalRuns: true }, evals]);
    expect(
      screen.getByText(/ask a project admin to turn on Allow local runs/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/including your local app's/)).toBeNull();
    // The mixed note names Stop, which only an admin's switch offers.
    expect(screen.queryByText(/Some of these accounts/)).toBeNull();
    cleanup();
    mount(false, [
      { ...qa, allowLocalRuns: true },
      { ...evals, allowLocalRuns: true },
    ]);
    expect(screen.getByText(/including your local app's/)).toBeInTheDocument();
  });
});
