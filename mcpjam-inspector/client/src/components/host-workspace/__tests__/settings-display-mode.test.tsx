import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { NativeSettingsController } from "@/shared/plugin-settings-controller";
import { settingsFixture } from "@/shared/__tests__/plugin-settings-fixture";
import type { ServerSettingsApp } from "../server-settings-api";
import {
  f,
  appFor,
  open,
  SettingsHarness,
  connectGuest,
  settingsSurface,
} from "./settings-display-mode.test-support";
it.each(["inline", "fullscreen"] as const)(
  "negotiates a %s-only Settings App before the real bridge initializes",
  async (mode) => {
    f.app = appFor([mode]);
    const { guest } = await open();
    expect(guest.getHostContext()).toMatchObject({
      displayMode: mode,
      availableDisplayModes: [mode],
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const parent = screen.getByTestId("plugin-server-detail-modal");
    if (mode === "fullscreen") {
      expect(parent.style.height).toBe("100dvh");
      expect(getComputedStyle(parent).translate).toBe("none");
    } else {
      expect(parent.style.height).not.toBe("100dvh");
      expect(parent.style.translate).toBe("");
    }
  },
);
it("keeps the real guest and child through preferred fullscreen and inline transitions", async () => {
  f.app = appFor(["inline", "fullscreen"], "fullscreen");
  const { guest, frame } = await open();
  expect(guest.getHostContext()?.displayMode).toBe("fullscreen");
  fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
  await waitFor(() =>
    expect(guest.getHostContext()?.displayMode).toBe("inline"),
  );
  expect(
    screen.getByTestId("plugin-server-detail-modal").style.translate,
  ).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
  await waitFor(() =>
    expect(guest.getHostContext()?.displayMode).toBe("fullscreen"),
  );
  expect(
    getComputedStyle(screen.getByTestId("plugin-server-detail-modal")).translate,
  ).toBe("none");
  expect(screen.getByTitle("Settings guest")).toBe(frame);
  expect(f.iframeMounts).toBe(1);
  expect(f.openCount).toBe(1);
  expect(f.app.call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close App" }));
  await waitFor(() => expect(screen.queryByTitle("Settings guest")).toBeNull());
  expect(f.app.close).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox", { name: "Settings draft" })).toHaveValue(
    "keep draft",
  );
});
it("uses one workspace dialog and retains its pending form through display changes", async () => {
  f.app = appFor(["inline", "fullscreen"], "inline");
  const { view, frame } = await open(false);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  f.rows = [
    {
      rendezvousId: "form",
      serverId: "server",
      serverName: "CAD",
      mode: "form",
      formDialect: "openai",
      pluginWorkspaceId: "settings-private",
      message: "Review",
      expiresAt: Date.now() + 60000,
      requestedSchema: {
        type: "object",
        properties: { note: { type: "string" } },
      },
    },
  ];
  view.rerender(<SettingsHarness />);
  const input = await screen.findByRole("textbox", { name: /note/i });
  fireEvent.change(input, { target: { value: "pending draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: /note/i })).toBe(input);
  expect(input).toHaveValue("pending draft");
  expect(screen.getByTitle("Settings guest")).toBe(frame);
  expect(f.iframeMounts).toBe(1);
});

it.each([true, false])(
  "keeps a pending Settings form open on Escape and distinguishes cancellation (parent %s)",
  async (parent) => {
    f.app = appFor(["inline", "fullscreen"]);
    f.mutate.mockResolvedValue({ ok: true });
    const { view, frame } = await open(parent);
    f.rows = [{
      rendezvousId: "form",
      serverId: "server",
      serverName: "CAD",
      mode: "form",
      formDialect: "openai",
      pluginWorkspaceId: "settings-private",
      message: "Review",
      expiresAt: Date.now() + 60000,
      requestedSchema: {
        type: "object",
        properties: { note: { type: "string" } },
      },
    }];
    view.rerender(settingsSurface(parent));
    const input = await screen.findByRole("textbox", { name: /note/i });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    input.focus();
    await userEvent.keyboard("{Escape}");
    expect(frame).toBeInTheDocument();
    expect(input).toBeInTheDocument();
    expect(f.app.close).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel form" }));
    await waitFor(() => expect(f.mutate).toHaveBeenCalledWith(
      "elicitations:respondToElicitation",
      { rendezvousId: "form", action: "cancel" },
    ));
    expect(f.app.close).not.toHaveBeenCalled();
    f.rows = [];
    view.rerender(settingsSurface(parent));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel form" })).toBeNull(),
    );
    screen.getByRole("button", { name: "Close App" }).focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(f.app.close).toHaveBeenCalledOnce());
    if (parent)
      expect(screen.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    else expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it("returns keyboard focus to the Settings action inside the reused parent dialog", async () => {
  f.app = appFor(["inline", "fullscreen"], "fullscreen");
  await open();
  screen.getByRole("button", { name: "Close App" }).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByTitle("Settings guest")).toBeNull());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open Settings App" }),
    ).toHaveFocus(),
  );
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Settings draft" })).toHaveValue(
    "keep draft",
  );
});
it("returns to the original action after opening asynchronously disabled it", async () => {
  f.realSettingsView = true;
  f.app = appFor(["fullscreen"]);
  let finishOpen!: (app: ServerSettingsApp) => void;
  const appReady = new Promise<ServerSettingsApp>((resolve) => {
    finishOpen = resolve;
  });
  const controller = new NativeSettingsController(settingsFixture(), {
    read: async () => settingsFixture(),
    update: async () => ({ values: settingsFixture().values }),
  });
  f.openSession.mockResolvedValue({
    controller,
    close: vi.fn(async () => {}),
    actions: [{ name: "reset", title: "Parts Library", kind: "app" }],
    openApp: () => appReady,
  });
  render(settingsSurface());
  const opener = await screen.findByRole("button", { name: "Parts Library" });
  opener.focus();
  fireEvent.click(opener);
  expect(opener).toBeDisabled();
  // Browsers remove focus when the pending action disables its button.
  screen.getByTestId("plugin-server-detail-modal").focus();
  expect(opener).not.toHaveFocus();
  await act(async () => finishOpen(f.app!));
  await connectGuest();
  screen.getByRole("button", { name: "Close App" }).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(opener).toHaveFocus());
  expect(opener).toBeEnabled();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
it("adopts the guest's fullscreen-only capability without a second iframe or call", async () => {
  f.app = appFor(["inline", "fullscreen"], "inline");
  const { guest, frame } = await open(true, {
    availableDisplayModes: ["fullscreen"],
  });
  await waitFor(() =>
    expect(guest.getHostContext()).toMatchObject({
      displayMode: "fullscreen",
      availableDisplayModes: ["fullscreen"],
    }),
  );
  expect(screen.getByTestId("plugin-server-detail-modal").style.height).toBe(
    "100dvh",
  );
  expect(screen.getByTitle("Settings guest")).toBe(frame);
  expect(f.iframeMounts).toBe(1);
  expect(f.app.call).not.toHaveBeenCalled();
});
