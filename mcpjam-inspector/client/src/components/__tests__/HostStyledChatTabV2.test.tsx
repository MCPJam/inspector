import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostStyledChatTabV2 } from "../HostStyledChatTabV2";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { HOST_STYLE_KEY } from "@/stores/preferences/preferences-store";

const mockChatTabV2 = vi.hoisted(() => vi.fn());

vi.mock("../ChatTabV2", async () => {
  const { useSandboxHostStyle, useSandboxHostTheme } =
    await import("@/contexts/sandbox-host-style-context");

  return {
    ChatTabV2: (props: {
      hostStyle?: string;
      showHostStyleSelector?: boolean;
      onHostStyleChange?: (hostStyle: "claude" | "chatgpt") => void;
    }) => {
      mockChatTabV2(props);
      const hostStyle = useSandboxHostStyle();
      const hostTheme = useSandboxHostTheme();

      return (
        <div
          data-testid="wrapped-chat-tab"
          data-context-host-style={hostStyle ?? ""}
          data-context-host-theme={hostTheme ?? ""}
        >
          <span data-testid="wrapped-chat-prop-host-style">
            {props.hostStyle ?? ""}
          </span>
          <span data-testid="wrapped-chat-prop-selector">
            {props.showHostStyleSelector ? "true" : "false"}
          </span>
          <button
            type="button"
            onClick={() => props.onHostStyleChange?.("chatgpt")}
          >
            Switch host style
          </button>
        </div>
      );
    },
  };
});

function renderWithPreferences(hostStyle?: "claude" | "chatgpt") {
  if (hostStyle) {
    localStorage.setItem(HOST_STYLE_KEY, hostStyle);
  }

  return render(
    <PreferencesStoreProvider themeMode="dark" themePreset="default">
      <HostStyledChatTabV2
        connectedOrConnectingServerConfigs={{} as any}
        selectedServerNames={[]}
        showHostStyleSelector={true}
      />
    </PreferencesStoreProvider>,
  );
}

describe("HostStyledChatTabV2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("wraps ChatTabV2 with the shared host-style shell and selector props", () => {
    renderWithPreferences("claude");

    expect(screen.getByTestId("wrapped-chat-tab")).toHaveAttribute(
      "data-context-host-style",
      "claude",
    );
    expect(screen.getByTestId("wrapped-chat-tab")).toHaveAttribute(
      "data-context-host-theme",
      "dark",
    );
    expect(
      screen.getByTestId("wrapped-chat-prop-host-style"),
    ).toHaveTextContent("claude");
    expect(screen.getByTestId("wrapped-chat-prop-selector")).toHaveTextContent(
      "true",
    );

    const shell = screen.getByTestId("wrapped-chat-tab").parentElement;
    expect(shell).toHaveAttribute("data-host-style", "claude");
    expect(shell?.className).toContain("sandbox-host-shell");
    expect(shell?.className).toContain("dark");
    expect(shell?.getAttribute("style")).toContain("--background");
  });

  it("updates and persists the shared host style when ChatTabV2 changes it", () => {
    const firstRender = renderWithPreferences("claude");

    fireEvent.click(screen.getByRole("button", { name: "Switch host style" }));

    expect(screen.getByTestId("wrapped-chat-tab")).toHaveAttribute(
      "data-context-host-style",
      "chatgpt",
    );
    expect(
      screen.getByTestId("wrapped-chat-prop-host-style"),
    ).toHaveTextContent("chatgpt");
    expect(localStorage.getItem(HOST_STYLE_KEY)).toBe("chatgpt");

    firstRender.unmount();

    renderWithPreferences();

    expect(screen.getByTestId("wrapped-chat-tab")).toHaveAttribute(
      "data-context-host-style",
      "chatgpt",
    );
  });
});
