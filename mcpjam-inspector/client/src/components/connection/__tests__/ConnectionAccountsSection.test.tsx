import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionAccountsSection } from "../ConnectionAccountsSection";
const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  update: vi.fn(),
  flag: vi.fn(),
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
    mocks.hook.mockReturnValue({ connections: rows, shared: false });
    mocks.flag.mockReturnValue(true);
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
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    // `findBy`, not `getBy`: the field mounts after Radix closes the menu and
    // restores focus, so a synchronous query races that and fails under CI
    // load.
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
    mocks.hook.mockReturnValue({ connections: [rows[0]], shared: false });
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

  it.each([
    ["a shared server", { connections: rows.slice(0, 1), shared: true }, true],
    ["the rollout flag", { connections: rows, shared: false }, false],
  ])(
    "hides add behind %s while still managing what exists",
    (_label, state, flag) => {
      mocks.hook.mockReturnValue(state);
      mocks.flag.mockReturnValue(flag);
      mount();
      expect(
        screen.queryByRole("button", { name: /Connect another account/ }),
      ).toBeNull();
      // A de-flagged org must still see and take down what it has.
      expect(screen.getAllByText("same@example.com").length).toBeGreaterThan(0);
    },
  );
});
