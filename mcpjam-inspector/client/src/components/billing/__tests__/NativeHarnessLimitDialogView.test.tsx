import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NativeHarnessLimitDialogView,
  nativeHarnessLimitDescription,
  type NativeHarnessLimitDialogViewProps,
} from "../NativeHarnessLimitDialogView";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const OWNER = { email: "dana@acme.test", name: "Dana Ruiz" };

const handlers = {
  onUpgrade: vi.fn(),
  onSwitch: vi.fn(),
  onDismiss: vi.fn(),
};

function renderView(overrides: Partial<NativeHarnessLimitDialogViewProps> = {}) {
  return render(
    <NativeHarnessLimitDialogView
      granted={20}
      canUpgrade
      requestRecipients={[OWNER]}
      organizationId="org_1"
      organizationName="Acme Robotics"
      teamName="Pro"
      {...handlers}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  for (const handler of Object.values(handlers)) handler.mockReset();
});

describe("nativeHarnessLimitDescription", () => {
  it("offers the switch with the project's count", () => {
    expect(nativeHarnessLimitDescription(20, 3)).toBe(
      "Your organization has used its 20 free native harness turns. Upgrade to keep using native harnesses across MCPJam, or switch 3 clients in this project to MCPJam Harness.",
    );
    expect(nativeHarnessLimitDescription(20, 1)).toContain(
      "switch 1 client in this project",
    );
  });

  it("offers only the upgrade when there is nothing to switch", () => {
    expect(nativeHarnessLimitDescription(20, 0)).toBe(
      "Your organization has used its 20 free native harness turns. Upgrade to keep using native harnesses across MCPJam.",
    );
  });
});

describe("NativeHarnessLimitDialogView", () => {
  it("gives a billing manager Upgrade and Not now", async () => {
    renderView();

    expect(
      screen.getByRole("heading", { name: "Keep using native harnesses" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("request-upgrade-mail")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(handlers.onUpgrade).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(handlers.onDismiss).toHaveBeenCalled();
  });

  it("gives everyone else the request to the owners, drafted for this limit", () => {
    renderView({ canUpgrade: false });

    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    const request = screen.getByTestId("request-upgrade-mail");
    expect(request).toHaveTextContent("Request upgrade");
    expect(decodeURIComponent(request.getAttribute("href")!)).toContain(
      "used its free native harness turns",
    );
  });

  it("offers a project admin the switch, singular for one client", async () => {
    const { rerender } = renderView({ switchCount: 3 });

    expect(
      screen.getByTestId("native-harness-limit-description"),
    ).toHaveTextContent("or switch 3 clients in this project to MCPJam Harness.");
    await userEvent.click(
      screen.getByRole("button", { name: "Switch 3 clients to MCPJam Harness" }),
    );
    expect(handlers.onSwitch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();

    rerender(
      <NativeHarnessLimitDialogView
        granted={20}
        canUpgrade={false}
        requestRecipients={[OWNER]}
        organizationName="Acme Robotics"
        teamName="Pro"
        switchCount={1}
        {...handlers}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Switch 1 client to MCPJam Harness" }),
    ).toBeInTheDocument();
  });

  it("starts on the upgrade action, never on the bulk switch", async () => {
    renderView({ canUpgrade: false, switchCount: 3 });

    await waitFor(() =>
      expect(screen.getByTestId("request-upgrade-mail")).toHaveFocus(),
    );
  });

  it("starts on the dialog itself when there is no one to ask", async () => {
    renderView({ canUpgrade: false, requestRecipients: [], switchCount: 3 });

    expect(screen.queryByTestId("request-upgrade-mail")).toBeNull();
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
    expect(
      screen.getByRole("button", { name: "Switch 3 clients to MCPJam Harness" }),
    ).not.toHaveFocus();
  });

  it("offers no switch without a handler, whatever the count", () => {
    renderView({ switchCount: 3, onSwitch: undefined });

    expect(screen.queryByRole("button", { name: /^Switch/ })).toBeNull();
    expect(
      screen.getByTestId("native-harness-limit-description"),
    ).not.toHaveTextContent("switch");
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  it("holds the switch while one is running", () => {
    renderView({ switchCount: 2, isSwitching: true });

    expect(
      screen.getByRole("button", { name: "Switch 2 clients to MCPJam Harness" }),
    ).toBeDisabled();
  });
});
