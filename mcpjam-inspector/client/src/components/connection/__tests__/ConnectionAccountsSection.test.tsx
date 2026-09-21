import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectionAccountsSection } from "../ConnectionAccountsSection";
const mocks = vi.hoisted(() => ({ hook: vi.fn(), update: vi.fn() }));
vi.mock("@/hooks/use-hosted-oauth-connections", () => ({
  useHostedOAuthConnections: mocks.hook,
}));
vi.mock("@/lib/apis/web/oauth-connections", () => ({
  updateOAuthConnection: mocks.update,
}));
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
    needsReauth: true,
    profile: { id: "opaque-b", email: "same@example.com" },
  },
];
describe("ConnectionAccountsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hook.mockReturnValue({ connections: rows, shared: false });
  });
  afterEach(cleanup);
  it("shows separate same-email rows and reconnect state without exposing profile IDs", () => {
    render(
      <ConnectionAccountsSection
        projectId="p"
        serverId="s"
        enabled
        onAuthenticate={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("2 accounts"));
    expect(screen.getAllByText("same@example.com")).toHaveLength(2);
    expect(screen.getByText("Needs reconnect")).toBeTruthy();
    expect(screen.queryByText("opaque-a")).toBeNull();
  });
  it("starts an explicit add flow", () => {
    const auth = vi.fn();
    render(
      <ConnectionAccountsSection
        projectId="p"
        serverId="s"
        enabled
        onAuthenticate={auth}
        onSwitch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("2 accounts"));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect another account" }),
    );
    expect(auth).toHaveBeenCalledWith({ kind: "add" });
  });
  it("does not offer add for a shared server", () => {
    mocks.hook.mockReturnValue({ connections: rows.slice(0, 1), shared: true });
    render(
      <ConnectionAccountsSection
        projectId="p"
        serverId="s"
        enabled
        onAuthenticate={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("1 account"));
    expect(
      screen.queryByRole("button", { name: "Connect another account" }),
    ).toBeNull();
  });
  it("writes a label against exactly the selected row", () => {
    mocks.update.mockResolvedValue(undefined);
    render(
      <ConnectionAccountsSection
        projectId="p"
        serverId="s"
        enabled
        onAuthenticate={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("2 accounts"));
    const input = screen.getByLabelText("Label for Side");
    fireEvent.change(input, { target: { value: "Personal" } });
    fireEvent.blur(input);
    expect(mocks.update).toHaveBeenCalledWith(
      "p",
      "s",
      "b",
      "label",
      "Personal",
    );
  });
});
