import { useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceClientConfigSync } from "../WorkspaceClientConfigSync";
import { useClientConfigStore } from "@/stores/client-config-store";
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

describe("WorkspaceClientConfigSync", () => {
  beforeEach(() => {
    localStorage.clear();
    useClientConfigStore.setState({
      activeWorkspaceId: null,
      defaultConfig: null,
      savedConfig: undefined,
      draftConfig: null,
      connectionDefaultsText: "{}",
      clientCapabilitiesText: "{}",
      hostContextText: "{}",
      connectionDefaultsError: null,
      clientCapabilitiesError: null,
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useUIPlaygroundStore.getState().reset();
  });

  it("refreshes unsaved workspace defaults when theme and playground context change", async () => {
    const view = render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <ThemeModeUpdater themeMode="light" />
        <WorkspaceClientConfigSync activeWorkspaceId="ws-1" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(
        useClientConfigStore.getState().defaultConfig?.hostContext,
      ).toMatchObject({
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
        <WorkspaceClientConfigSync activeWorkspaceId="ws-1" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(
        useClientConfigStore.getState().defaultConfig?.hostContext,
      ).toEqual(
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
      expect(useClientConfigStore.getState().draftConfig).toEqual(
        useClientConfigStore.getState().defaultConfig,
      );
    });
  });
});
