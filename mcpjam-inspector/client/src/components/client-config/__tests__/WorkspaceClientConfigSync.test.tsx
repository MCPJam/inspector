import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceClientConfigSync } from "../WorkspaceClientConfigSync";
import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/host-context-store";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

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
      connectionDefaultsError: null,
      clientCapabilitiesError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedConfig: undefined,
      isAwaitingRemoteEcho: false,
    });
    useHostContextStore.setState({
      activeWorkspaceId: null,
      defaultHostContext: {},
      savedHostContext: undefined,
      draftHostContext: {},
      hostContextText: "{}",
      hostContextError: null,
      isSaving: false,
      isDirty: false,
      pendingWorkspaceId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    });
    useUIPlaygroundStore.getState().reset();
  });

  it("refreshes unsaved workspace defaults when playground context changes", async () => {
    const view = render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <WorkspaceClientConfigSync activeWorkspaceId="ws-1" />
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
        displayMode: "inline",
      });
      expect(
        useHostContextStore.getState().defaultHostContext,
      ).not.toHaveProperty("theme");
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
        <WorkspaceClientConfigSync activeWorkspaceId="ws-1" />
      </PreferencesStoreProvider>,
    );

    await waitFor(() => {
      expect(useHostContextStore.getState().defaultHostContext).toEqual(
        expect.objectContaining({
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
      expect(
        useHostContextStore.getState().defaultHostContext,
      ).not.toHaveProperty("theme");
      expect(useHostContextStore.getState().draftHostContext).toEqual(
        useHostContextStore.getState().defaultHostContext,
      );
    });
  });
});
