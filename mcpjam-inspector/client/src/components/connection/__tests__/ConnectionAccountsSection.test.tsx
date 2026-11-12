import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionAccountsSection } from "../ConnectionAccountsSection";
const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  update: vi.fn(),
  flag: vi.fn(),
  sharing: vi.fn(),
  setSharing: vi.fn(),
}));
vi.mock("@/hooks/use-hosted-oauth-connections", () => ({
  useHostedOAuthConnections: mocks.hook,
}));
vi.mock("@/hooks/useMultiAccountConnectionsEnabled", () => ({
  useMultiAccountConnectionsEnabled: mocks.flag,
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
    mocks.flag.mockReturnValue(true);
    mocks.sharing.mockReturnValue({
      isAdmin: false,
      canShare: false,
      setSharing: mocks.setSharing,
    });
  });
  afterEach(cleanup);

  it("names each account once, and captions it with what the user called it", () => {
    mount();
    // Both accounts share an email, so the address identifies each row and the
    // caption carries the DIFFERENT fact. It used to carry the same one twice.
    expect(screen.getAllByText("same@example.com")).toHaveLength(2);
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("Side")).toBeTruthy();
    expect(screen.queryByText("opaque-a")).toBeNull();
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

  it("captions a stale account as needing reconnection instead of a label", () => {
    mocks.hook.mockReturnValue({
      connections: [{ ...rows[1], needsReauth: true, label: "Side" }],
      shared: false,
      loaded: true,
    });
    mount();
    expect(screen.getByText("Needs reconnect")).toBeTruthy();
    expect(screen.queryByText("Side")).toBeNull();
  });

  it("renames from the menu rather than a permanently open field", async () => {
    const user = userEvent.setup();
    mocks.update.mockResolvedValue(undefined);
    mount();
    const label = "Name for same@example.com: Side";
    expect(screen.queryByLabelText(label)).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Manage same@example.com: Side" }),
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
      screen.getByRole("button", { name: "Manage same@example.com: Side" }),
    );
    expect(screen.getByRole("menuitem", { name: "Set as default" })).toBeTruthy();
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
    expect(screen.queryByRole("menuitem", { name: "Set as default" })).toBeNull();
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

  it("hides add behind the rollout flag while still managing what exists", () => {
    mocks.flag.mockReturnValue(false);
    mount();
    expect(
      screen.queryByRole("button", { name: /Connect another account/ }),
    ).toBeNull();
    // A de-flagged org must still see and take down what it has.
    expect(
      screen.getByRole("button", { name: "Manage same@example.com: Side" }),
    ).toBeTruthy();
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
    await user.click(
      screen.getByRole("button", { name: "Manage same@example.com" }),
    );
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
      // With the flag off there is no switch, so the note says it is shared.
      expect(screen.getByText(/Your hosted runs can act/)).toBeTruthy();
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

    it.each([
      [
        true,
        "No project accounts yet. Connect one so members' hosted runs can use it.",
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
        "an admin while the flag is off",
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
      [
        "an admin while the flag is on",
        { isAdmin: true, canShare: true },
        true,
        true,
      ],
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
  });
});
