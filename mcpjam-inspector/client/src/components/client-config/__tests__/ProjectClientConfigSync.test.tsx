import { useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectClientConfigSync } from "../ProjectClientConfigSync";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/client-context-store";
import {
  PreferencesStoreProvider,
  usePreferencesStore,
} from "@/stores/preferences/preferences-provider";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

function ThemeModeUpdater({ themeMode }: { themeMode: "light" | "dark" }) {
  const setThemeMode = usePreferencesStore((state) => state.setThemeMode);

  useEffect(() => {
    setThemeMode(themeMode);
  }, [setThemeMode, themeMode]);

  return null;
}

describe("ProjectClientConfigSync", () => {
  beforeEach(() => {
    localStorage.clear();
    useClientConfigStore.setState({
      activeProjectId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      connectionDefaultsError: null,
      clientCapabilitiesError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeProjectId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
    useUIPlaygroundStore.getState().reset();
  });

  it("defaults safe-area insets to what the selected host declares", async () => {
    // Claude reports a uniform 12px inset; the playground's own default is the
    // "none" preset, all zeros. Seeding from the playground alone made every
    // emulated host look like it reports nothing, which is why Claude's
    // measured 12px never reached the editor.
    render(
      <PreferencesStoreProvider
        themeMode="light"
        themePreset="default"
        hostStyle="claude"
      >
        <ProjectClientConfigSync activeProjectId="ws-safe-area-claude" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(useHostContextStore.getState().defaultHostContext).toMatchObject({
        safeAreaInsets: { top: 12, right: 12, bottom: 12, left: 12 },
      });
    });
  });

  it("falls back to zeros for a host that declares no insets", async () => {
    // Slackbot omits `hostContext.safeAreaInsets` entirely, so a widget there
    // reads `undefined`. Zeros are the honest emulation of that.
    render(
      <PreferencesStoreProvider
        themeMode="light"
        themePreset="default"
        hostStyle="slack"
      >
        <ProjectClientConfigSync activeProjectId="ws-safe-area-slack" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(useHostContextStore.getState().defaultHostContext).toMatchObject({
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      });
    });
  });

  it("lets a chosen device preset override the host's insets", async () => {
    // The presets are a phone simulator. Once the user picks one it wins over
    // the host declaration — otherwise Claude could never be viewed with a
    // notch, which is the whole point of the control.
    render(
      <PreferencesStoreProvider
        themeMode="light"
        themePreset="default"
        hostStyle="claude"
      >
        <ProjectClientConfigSync activeProjectId="ws-safe-area-preset" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(useHostContextStore.getState().defaultHostContext).toMatchObject({
        safeAreaInsets: { top: 12, right: 12, bottom: 12, left: 12 },
      });
    });

    act(() => {
      useUIPlaygroundStore.getState().setSafeAreaPreset("iphone-notch");
    });

    await waitFor(() => {
      const insets = (
        useHostContextStore.getState().defaultHostContext as {
          safeAreaInsets?: { top: number };
        }
      ).safeAreaInsets;
      expect(insets?.top).not.toBe(12);
    });
  });

  it("refreshes unsaved project defaults when theme and playground context change", async () => {
    const view = render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <ThemeModeUpdater themeMode="light" />
        <ProjectClientConfigSync activeProjectId="ws-1" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(useClientConfigStore.getState().defaultConfig).toMatchObject({
        version: 1,
        connectionDefaults: {
          headers: {},
          requestTimeout: 10000,
        },
      });
      expect(useHostContextStore.getState().defaultHostContext).toMatchObject({
        theme: "light",
        displayMode: "inline",
      });
    });

    act(() => {
      useUIPlaygroundStore.getState().updateGlobal("displayMode", "fullscreen");
      useUIPlaygroundStore.getState().updateGlobal("locale", "fr-CA");
      useUIPlaygroundStore
        .getState()
        .updateGlobal("timeZone", "America/Toronto");
      useUIPlaygroundStore.getState().setCapabilities({
        hover: false,
        touch: true,
      });
      useUIPlaygroundStore.getState().setSafeAreaInsets({
        top: 44,
        right: 8,
        bottom: 12,
        left: 6,
      });
    });

    view.rerender(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <ThemeModeUpdater themeMode="dark" />
        <ProjectClientConfigSync activeProjectId="ws-1" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(useHostContextStore.getState().defaultHostContext).toEqual(
        expect.objectContaining({
          theme: "dark",
          displayMode: "fullscreen",
          locale: "fr-CA",
          timeZone: "America/Toronto",
          deviceCapabilities: {
            hover: false,
            touch: true,
          },
          safeAreaInsets: {
            top: 44,
            right: 8,
            bottom: 12,
            left: 6,
          },
        }),
      );
      expect(useHostContextStore.getState().draftHostContext).toEqual(
        useHostContextStore.getState().defaultHostContext,
      );
    });
  });
});
