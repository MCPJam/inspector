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
