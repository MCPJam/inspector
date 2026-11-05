import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  f,
  host,
  appFor,
  open,
  settingsSurface,
} from "./settings-display-mode.test-support";

it("removes fullscreen controls when the actual guest declares inline only", async () => {
  f.app = appFor(["inline", "fullscreen"], "fullscreen");
  const { guest, frame } = await open(true, {
    availableDisplayModes: ["inline"],
  });
  await waitFor(() =>
    expect(guest.getHostContext()).toMatchObject({
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    }),
  );
  expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
  expect(screen.getByTitle("Settings guest")).toBe(frame);
  expect(f.iframeMounts).toBe(1);
  expect(f.app.call).not.toHaveBeenCalled();
});
it("refuses an empty post-initialize display intersection without replaying the App", async () => {
  f.app = appFor(["inline", "fullscreen"], "inline");
  await open(true, { availableDisplayModes: ["pip"] });
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/display mode/i),
  );
  expect(f.iframeMounts).toBe(1);
  expect(f.openCount).toBe(1);
  expect(f.app.call).not.toHaveBeenCalled();
});
it("updates theme and locale on the live bridge while retaining the guest", async () => {
  f.app = appFor(["inline", "fullscreen"], "inline");
  f.host = {
    ...host,
    environment: {
      ...host.environment,
      themeMode: "dark",
      draftHostContext: {
        ...host.environment.draftHostContext,
        theme: "dark",
        locale: "fr-FR",
      },
    },
  };
  const { guest, frame, view } = await open();
  expect(guest.getHostContext()).toMatchObject({
    theme: "dark",
    locale: "fr-FR",
  });
  f.host = {
    ...host,
    environment: {
      ...host.environment,
      themeMode: "light",
      draftHostContext: {
        ...host.environment.draftHostContext,
        theme: "light",
        locale: "en-GB",
      },
    },
  };
  view.rerender(settingsSurface());
  await waitFor(() =>
    expect(guest.getHostContext()).toMatchObject({
      theme: "light",
      locale: "en-GB",
    }),
  );
  expect(screen.getByTitle("Settings guest")).toBe(frame);
  expect(f.iframeMounts).toBe(1);
  expect(f.app.call).not.toHaveBeenCalled();
});
it("narrows the live host policy to inline without replacing the guest", async () => {
  f.app = appFor(["inline", "fullscreen"], "fullscreen");
  const { guest, frame, view } = await open();
  expect(guest.getHostContext()?.displayMode).toBe("fullscreen");
  f.host = {
    ...host,
    environment: {
      ...host.environment,
      draftHostContext: { availableDisplayModes: ["inline"] },
    },
    resolvers: {
      ...host.resolvers,
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...host.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        availableDisplayModes: ["inline"],
      }),
    },
  };
  view.rerender(settingsSurface());
  await waitFor(() =>
    expect(guest.getHostContext()).toMatchObject({
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    }),
  );
  expect(screen.getByTitle("Settings guest")).toBe(frame);
  expect(f.iframeMounts).toBe(1);
  expect(f.app.call).not.toHaveBeenCalled();
});
it("allows both modes for preference-only metadata while Display modes is enabled", async () => {
  f.app = appFor(["inline", "fullscreen"]);
  f.app.widgetContent.resourceDisplayHints = {
    preferredDisplayMode: "fullscreen",
  };
  f.host = { ...host, surface: { ...host.surface, openAIDisplayModes: true } };
  const { guest } = await open();
  expect(guest.getHostContext()).toMatchObject({
    displayMode: "fullscreen",
    availableDisplayModes: ["inline", "fullscreen"],
  });
  screen.getByRole("button", { name: "Exit full screen" }).click();
  await waitFor(() =>
    expect(guest.getHostContext()?.displayMode).toBe("inline"),
  );
});
it("keeps preference-only metadata fullscreen-only when Display modes is disabled", async () => {
  f.app = appFor(["inline", "fullscreen"]);
  f.app.widgetContent.resourceDisplayHints = {
    preferredDisplayMode: "fullscreen",
  };
  f.host = { ...host, surface: { ...host.surface, openAIDisplayModes: false } };
  const { guest } = await open();
  expect(guest.getHostContext()).toMatchObject({
    displayMode: "fullscreen",
    availableDisplayModes: ["fullscreen"],
  });
  expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
});
it("starts disabled-policy Apps inline when both modes are available without a preference", async () => {
  f.app = appFor(["inline", "fullscreen"]);
  f.host = { ...host, surface: { ...host.surface, openAIDisplayModes: false } };
  const { guest } = await open();
  expect(guest.getHostContext()).toMatchObject({
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
  });
});
it("does not remount a refused App when the host policy is restored", async () => {
  f.app = appFor(["inline", "fullscreen"], "fullscreen");
  const { view } = await open(true, { availableDisplayModes: ["fullscreen"] });
  f.host = {
    ...host,
    environment: {
      ...host.environment,
      draftHostContext: { availableDisplayModes: ["inline"] },
    },
    resolvers: {
      ...host.resolvers,
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...host.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        availableDisplayModes: ["inline"],
      }),
    },
  };
  view.rerender(settingsSurface());
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/display mode/i),
  );
  f.host = undefined;
  view.rerender(settingsSurface());
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/display mode/i),
  );
  expect(f.iframeMounts).toBe(1);
  expect(f.openCount).toBe(1);
  expect(f.app.call).not.toHaveBeenCalled();
});
