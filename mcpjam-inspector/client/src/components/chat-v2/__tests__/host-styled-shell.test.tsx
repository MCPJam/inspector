import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HostStyledShell } from "../host-styled-shell";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { useActiveHostCapsResolver } from "@/contexts/active-host-client-capabilities-context";
import { useScenarioHostCapabilitiesOverride } from "@/contexts/scenario-client-capabilities-override-context";
import {
  useScenarioChatUiOverride,
  useScenarioHostStyle,
  useScenarioHostTheme,
} from "@/contexts/scenario-client-style-context";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { getScenarioShellStyle } from "@/lib/scenario-client-style";
import type { HostSnapshot } from "@/lib/host-snapshot";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

vi.mock("@/lib/host-compat/use-host-catalog", () => ({
  useHostCatalog: () => ({ catalog: null }),
}));

function Probe() {
  const values = {
    style: useScenarioHostStyle(),
    theme: useScenarioHostTheme(),
    chatUi: useScenarioChatUiOverride(),
    capabilities: useScenarioHostCapabilitiesOverride(),
    profile: useActiveMcpProfile(),
    clientCapabilities: useActiveHostCapsResolver()(),
  };
  return <output data-testid="host-values">{JSON.stringify(values)}</output>;
}

describe("HostStyledShell", () => {
  it("provides the full snapshot and saved client capabilities", () => {
    const snapshot = {
      hostStyle: "claude",
      chatUiOverride: { label: "Support client" },
      hostCapabilitiesOverride: { tools: {} },
      mcpProfile: { version: 1 },
    } as HostSnapshot;
    const clientCapabilities = { extensions: { "test/saved-capability": {} } };
    const { container } = render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <HostStyledShell
          hostSnapshot={snapshot}
          activeHost={{ clientCapabilities } as HostConfigDtoV2}
          className="h-full"
        >
          <Probe />
        </HostStyledShell>
      </PreferencesStoreProvider>,
    );
    expect(
      JSON.parse(screen.getByTestId("host-values").textContent!),
    ).toMatchObject({
      style: "claude",
      theme: "light",
      chatUi: snapshot.chatUiOverride,
      capabilities: snapshot.hostCapabilitiesOverride,
      profile: snapshot.mcpProfile,
      clientCapabilities,
    });
    const shell = container.querySelector<HTMLElement>(
      "[data-host-style='claude']",
    )!;
    expect(shell).toHaveClass(
      "scenario-host-shell",
      "app-theme-scope",
      "h-full",
    );
    expect(shell).not.toHaveClass("overflow-hidden");
    expect(shell.style.getPropertyValue("--background")).toBe(
      getScenarioShellStyle("claude", "light")["--background"],
    );
  });

  it.each([undefined, null, "light", "dark"] as const)(
    "resolves theme %s consistently with preference dark",
    (themeMode) => {
      const { container } = render(
        <PreferencesStoreProvider themeMode="dark" themePreset="default">
          <HostStyledShell
            hostSnapshot={{ hostStyle: "chatgpt" }}
            activeHost={null}
            themeMode={themeMode}
          >
            <Probe />
          </HostStyledShell>
        </PreferencesStoreProvider>,
      );
      const effective = themeMode ?? "dark";
      const shell = container.querySelector<HTMLElement>("[data-host-style]")!;
      expect(shell.classList.contains("dark")).toBe(effective === "dark");
      expect(
        JSON.parse(screen.getByTestId("host-values").textContent!).theme,
      ).toBe(themeMode === null ? null : effective);
      expect(shell.style.getPropertyValue("--background")).toBe(
        getScenarioShellStyle("chatgpt", effective)["--background"],
      );
    },
  );

  it("clears inherited overrides for an explicit generic shell", () => {
    render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <HostStyledShell
          hostSnapshot={{
            hostStyle: "claude",
            chatUiOverride: { label: "Outer" },
          }}
          activeHost={null}
        >
          <HostStyledShell hostSnapshot={null} activeHost={null}>
            <Probe />
          </HostStyledShell>
        </HostStyledShell>
      </PreferencesStoreProvider>,
    );
    expect(
      JSON.parse(screen.getByTestId("host-values").textContent!),
    ).toMatchObject({ style: "mcpjam" });
    expect(
      JSON.parse(screen.getByTestId("host-values").textContent!).chatUi,
    ).toBeUndefined();
  });
});
