import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionAccountsSection } from "../ConnectionAccountsSection";
const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  update: vi.fn(),
  sharing: vi.fn(),
  setSharing: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-hosted-oauth-connections", () => ({
  useHostedOAuthConnections: mocks.hook,
}));
vi.mock("@/lib/apis/web/oauth-connections", () => ({
  updateOAuthConnection: mocks.update,
}));
vi.mock("@/hooks/use-sign-in-sharing", () => ({
  useSignInSharing: mocks.sharing,
}));

// Radix menus read pointer capture, which jsdom does not implement.
const installPointerCaptureMocks = () => {
  for (const name of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
  ])
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: vi.fn(() => false),
    });
};

const rows = [
  {
    connectionId: "a",
    isDefault: true,
    profile: { id: "opaque-a", email: "same@example.com" },
  },
  {
    connectionId: "b",
    isDefault: false,
    label: "Side",
    profile: { id: "opaque-b", email: "same@example.com" },
  },
];
const mount = (props = {}) =>
  render(
    <ConnectionAccountsSection
      projectId="p"
      serverId="s"
      enabled
      onAuthenticate={vi.fn()}
      onSwitch={vi.fn()}
      {...props}
    />,
  );

describe("ConnectionAccountsSection", () => {
  beforeEach(() => {
    installPointerCaptureMocks();
    vi.clearAllMocks();
    mocks.hook.mockReturnValue({
      connections: rows,
      shared: false,
      loaded: true,
    });
    mocks.sharing.mockReturnValue({
      isAdmin: false,
      canShare: false,
      setSharing: mocks.setSharing,
    });
  });
  afterEach(cleanup);

  it("names a renamed account by its new name, with the server's email under it", () => {
    mount();
    // The unnamed account is its email; the renamed one is "Side", and its
    // caption still says which login it is, so the two never read the same.
    expect(screen.getAllByText("same@example.com")).toHaveLength(2);
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("Side")).toBeTruthy();
    expect(screen.queryByText("opaque-a")).toBeNull();
  });

  it("keeps each unnamed account's number when the default moves (PUR-111)", () => {
    const unnamed = (defaultId: string) => [
      { connectionId: "a", accountNumber: 1, isDefault: defaultId === "a" },
      { connectionId: "b", accountNumber: 2, isDefault: defaultId === "b" },
    ];
    const names = () =>
      screen
        .getAllByRole("button", { name: /^Manage / })
        .map((button) => button.getAttribute("aria-label"));
    mocks.hook.mockReturnValue({
      connections: unnamed("a"),
      shared: false,
      loaded: true,
    });
    const { unmount } = mount();
    expect(names()).toEqual(["Manage Account 1: Default", "Manage Account 2"]);
    unmount();

    mocks.hook.mockReturnValue({
      connections: unnamed("b"),
      shared: false,
      loaded: true,
    });
    mount();
    expect(names()).toEqual(["Manage Account 1", "Manage Account 2: Default"]);
  });

  it("names accounts by their stored numbers after one is removed", () => {
    mocks.hook.mockReturnValue({
      connections: [
        { connectionId: "b", accountNumber: 2, isDefault: true },
        { connectionId: "c", accountNumber: 3, isDefault: false },
      ],
      shared: false,
      loaded: true,
    });
    mount();
    expect(screen.getByText("Account 2")).toBeTruthy();
    expect(screen.getByText("Account 3")).toBeTruthy();
    expect(screen.queryByText("Account 1")).toBeNull();
  });

  it("distinguishes two accounts that share an email", () => {
    mocks.hook.mockReturnValue({
      connections: [
        {
          connectionId: "a",
          isDefault: true,
          profile: { id: "x", email: "same@example.com", name: "Acme Corp" },
        },
        {
          connectionId: "b",
          isDefault: false,
          profile: { id: "y", email: "same@example.com", name: "Side Project" },
        },
      ],
      shared: false,
      loaded: true,
    });
    mount();
    // The address cannot tell them apart, so the caption has to.
    expect(screen.getAllByText("same@example.com")).toHaveLength(2);
    expect(screen.getByText("Acme Corp · Default")).toBeTruthy();
    expect(screen.getByText("Side Project")).toBeTruthy();
  });

  it("captions a stale account as needing reconnection, keeping its name", () => {
    mocks.hook.mockReturnValue({
      connections: [{ ...rows[1], needsReauth: true, label: "Side" }],
      shared: false,
      loaded: true,
    });
    mount();
    expect(screen.getByText("Side")).toBeTruthy();
    expect(screen.getByText("Needs reconnect")).toBeTruthy();
    expect(screen.queryByText("same@example.com")).toBeNull();
  });

  it("captions a shared or uploaded account with its token's expiry, or says it is unknown", () => {
    const now = Date.now();
    mocks.hook.mockReturnValue({
      connections: [
        {
          connectionId: "jwt",
          isDefault: true,
          label: "test-automation-1",
          hostedOnly: true,
          expiresAt: now + 3_600_000,
        },
        {
          connectionId: "opaque",
          isDefault: false,
          label: "test-automation-2",
          hostedOnly: true,
        },
        {
          connectionId: "old",
          isDefault: false,
          label: "test-automation-3",
          hostedOnly: true,
          expiresAt: now - 60_000,
        },
        // A person's own sign-in renews itself, so no expiry is shown.
        { connectionId: "mine", isDefault: false, label: "Mine" },
      ],
      shared: true,
      loaded: true,
    });
    mount();
    expect(screen.getByText(/^Default · Expires /)).toBeTruthy();
    expect(screen.getByText("Expiry unknown")).toBeTruthy();
    expect(screen.getByText(/^Expired /)).toBeTruthy();
    expect(screen.getAllByText(/Expir/)).toHaveLength(3);
  });

  it("renames from the menu rather than a permanently open field", async () => {
    const user = userEvent.setup();
    mocks.update.mockResolvedValue(undefined);
    mount();
    const label = "Name for Side: same@example.com";
    expect(screen.queryByLabelText(label)).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Manage Side: same@example.com" }),
    );
    // `findBy` on BOTH hops. Radix mounts the menu content in a portal a tick
    // after the trigger click, and mounts the rename field a tick after the
    // menu closes and returns focus — so either synchronous query can lose the
    // race on a loaded CI runner while passing every time locally.
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByLabelText(label);
    await user.clear(input);
    await user.type(input, "Personal");
    await user.tab();
    expect(mocks.update).toHaveBeenCalledWith(
      "p",
      "s",
      "b",
      "label",
      "Personal",
    );
  });

  it("offers the default switch only on an account that is not already it", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      screen.getByRole("button", { name: "Manage Side: same@example.com" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Set as default" }),
    ).toBeTruthy();
    cleanup();
    mocks.hook.mockReturnValue({
      connections: [rows[0]],
      shared: false,
      loaded: true,
    });
    mount();
    await user.click(
      screen.getByRole("button", { name: "Manage same@example.com: Default" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Set as default" }),
    ).toBeNull();
  });

  it("starts an explicit add flow", async () => {
    const user = userEvent.setup();
    const auth = vi.fn();
    mount({ onAuthenticate: auth });
    await user.click(
      screen.getByRole("button", { name: /Connect another account/ }),
    );
    expect(auth).toHaveBeenCalledWith({ kind: "add" });
  });

  it("counts only live accounts toward the limit of eight", () => {
    const accounts = (count: number, needsReauth = false) =>
      Array.from({ length: count }, (_, i) => ({
        connectionId: `${needsReauth ? "stale" : "live"}-${i}`,
        isDefault: i === 0 && !needsReauth,
        label: `${needsReauth ? "Stale" : "Live"} ${i}`,
        ...(needsReauth ? { needsReauth: true } : {}),
      }));
    const addButton = () =>
      screen.getByRole("button", {
        name: /Connect another account/,
      }) as HTMLButtonElement;

    mocks.hook.mockReturnValue({
      connections: [...accounts(7), ...accounts(3, true)],
      shared: false,
      loaded: true,
    });
    const { unmount } = mount();
    expect(addButton().disabled).toBe(false);
    unmount();

    mocks.hook.mockReturnValue({
      connections: accounts(8),
      shared: false,
      loaded: true,
    });
    mount();
    expect(addButton().disabled).toBe(true);
  });

  it("reconnects an account that needs it in place, by its own id", async () => {
    const user = userEvent.setup();
    const auth = vi.fn();
    mocks.hook.mockReturnValue({
      connections: [rows[0], { ...rows[1], needsReauth: true }],
      shared: false,
      loaded: true,
    });
    mount({ onAuthenticate: auth });
    await user.click(screen.getByRole("button", { name: "Manage Side" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Reconnect" }),
    );
    expect(auth).toHaveBeenCalledWith({ kind: "replace", credentialId: "b" });
  });

  describe("on a server shared with the project", () => {
    const project = [
      { connectionId: "p1", isDefault: true, label: "test-automation-1" },
      {
        connectionId: "p2",
        isDefault: false,
        label: "test-automation-2",
        needsReauth: true,
      },
    ];
    beforeEach(() => {
      mocks.hook.mockReturnValue({
        connections: project,
        shared: true,
        loaded: true,
      });
    });

    it("shows a member the project accounts read-only", () => {
      mount();
      expect(screen.getByText("Project accounts")).toBeTruthy();
      expect(
        screen.getByText(/^Shared with the project\. Your hosted runs can act/),
      ).toBeTruthy();
      // Named by what the admin called them: they carry no profile.
      expect(screen.getByText("test-automation-1")).toBeTruthy();
      expect(screen.getByText("Needs reconnect")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Connect another account/ }),
      ).toBeNull();
    });

    it("lets an admin manage them, reconnect one in place and connect another", async () => {
      const user = userEvent.setup();
      const auth = vi.fn();
      mocks.sharing.mockReturnValue({
        isAdmin: true,
        canShare: false,
        setSharing: mocks.setSharing,
      });
      mount({ onAuthenticate: auth });
      // With the eval flag off there is no share switch, but an admin still
      // gets Allow local runs, which doesn't wait for that flag.
      expect(
        screen.getByRole("switch", { name: "Allow local runs" }),
      ).toBeTruthy();
      expect(screen.queryByText(/ask a project admin to turn on/)).toBeNull();
      await user.click(
        screen.getByRole("button", { name: /Connect another account/ }),
      );
      expect(auth).toHaveBeenLastCalledWith({ kind: "add" });
      await user.click(
        screen.getByRole("button", { name: "Manage test-automation-2" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Reconnect" }),
      );
      expect(auth).toHaveBeenLastCalledWith({
        kind: "replace",
        credentialId: "p2",
      });
    });

    it("gives an admin both switches when the eval flag is on", () => {
      mocks.sharing.mockReturnValue({
        isAdmin: true,
        canShare: true,
        setSharing: mocks.setSharing,
      });
      mount();
      expect(
        screen.getByRole("switch", { name: "Shared with the project" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("switch", { name: "Allow local runs" }),
      ).toBeTruthy();
    });

    it.each([
      [
        true,
        /^Shared with the project\. Your runs, including your local app's/,
      ],
      [false, /ask a project admin to turn on Allow local runs\.$/],
    ])(
      "shows a member no switch, and whether local runs are allowed (%s)",
      (localDeliveryAllowed, copy) => {
        mocks.hook.mockReturnValue({
          connections: project,
          shared: true,
          loaded: true,
          localDeliveryAllowed,
        });
        mocks.sharing.mockReturnValue({
          isAdmin: false,
          canShare: false,
          setSharing: mocks.setSharing,
        });
        mount();
        expect(screen.getByText(copy)).toBeTruthy();
        expect(screen.queryByRole("switch")).toBeNull();
      },
    );

    it.each([
      [
        true,
        "No project accounts yet. Connect one so members' runs can use it.",
      ],
      [false, "No project accounts yet. Ask a project admin to connect one."],
    ])("says what to do when there are none (admin: %s)", (isAdmin, copy) => {
      mocks.hook.mockReturnValue({
        connections: [],
        shared: true,
        loaded: true,
      });
      mocks.sharing.mockReturnValue({
        isAdmin,
        canShare: false,
        setSharing: mocks.setSharing,
      });
      mount();
      expect(screen.getByText(copy)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Connect an account" }) !== null,
      ).toBe(isAdmin);
    });
  });

  describe("the share control", () => {
    it.each([
      ["a member", { isAdmin: false, canShare: false }, true, false],
      [
        "an admin who cannot share",
        { isAdmin: true, canShare: false },
        true,
        false,
      ],
      [
        "an admin before the list answers",
        { isAdmin: true, canShare: true },
        false,
        false,
      ],
      ["an admin who can share", { isAdmin: true, canShare: true }, true, true],
    ])("for %s", (_label, role, loaded, shown) => {
      mocks.hook.mockReturnValue({ connections: rows, shared: false, loaded });
      mocks.sharing.mockReturnValue({ ...role, setSharing: mocks.setSharing });
      mount();
      expect(screen.queryByRole("switch") !== null).toBe(shown);
    });

    it("says the server is shared once, in the switch, for an admin who has it", () => {
      mocks.hook.mockReturnValue({
        connections: rows,
        shared: true,
        loaded: true,
      });
      mocks.sharing.mockReturnValue({
        isAdmin: true,
        canShare: true,
        setSharing: mocks.setSharing,
      });
      mount();
      expect(
        screen.getByRole("switch", { name: "Shared with the project" }),
      ).toBeChecked();
      expect(screen.queryByText(/Your hosted runs can act/)).toBeNull();
    });

    it("shares the sign-in, then reconnects the server on its new accounts", async () => {
      const user = userEvent.setup();
      const onSwitch = vi.fn();
      mocks.setSharing.mockResolvedValue(undefined);
      mocks.sharing.mockReturnValue({
        isAdmin: true,
        canShare: true,
        setSharing: mocks.setSharing,
      });
      mount({ onSwitch });
      await user.click(
        screen.getByRole("switch", { name: "Share sign-in with the project" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Share sign-in" }),
      );
      expect(mocks.setSharing).toHaveBeenCalledWith("shared");
      expect(onSwitch).toHaveBeenCalledOnce();
    });

    it("reports a failed reconnect on its own, not as a failed sharing change", async () => {
      const user = userEvent.setup();
      const onSwitch = vi.fn().mockRejectedValue(new Error("connect failed"));
      mocks.setSharing.mockResolvedValue(undefined);
      mocks.sharing.mockReturnValue({
        isAdmin: true,
        canShare: true,
        setSharing: mocks.setSharing,
      });
      mount({ onSwitch });
      await user.click(
        screen.getByRole("switch", { name: "Share sign-in with the project" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Share sign-in" }),
      );
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Sharing changed, but the server could not reconnect. Reconnect it to use the new accounts.",
      );
      expect(mocks.toast.success).toHaveBeenCalledWith(
        "Sign-in shared with the project.",
      );
    });
  });

  it("offers to load the accounts again after they failed to load", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.hook.mockReturnValue({
      connections: [],
      shared: false,
      loaded: false,
      error: "Could not load accounts",
      refetch,
    });
    mount();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load accounts",
    );
    await user.click(screen.getByRole("button", { name: "Reload accounts" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});
