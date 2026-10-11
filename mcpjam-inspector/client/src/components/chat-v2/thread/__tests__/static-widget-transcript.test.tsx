import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaticWidgetTranscript } from "../widget-presentation";
import { WidgetReplay } from "../widget-replay";
import { PartSwitch } from "../part-switch";

vi.mock("../mcp-apps/use-widget-host", () => ({
  InspectorWidgetHostProvider: () => {
    throw new Error("Live host mounted");
  },
}));
vi.mock("../mcp-apps/use-download-confirmation", () => ({
  useDownloadConfirmation: () => {
    throw new Error("Live download hook ran");
  },
}));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => {
    throw new Error("Live state hook ran");
  },
}));

describe("static transcript boundary", () => {
  it("selects the placeholder before widget hooks, host, or fetch", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const call = vi.fn();
    render(
      <StaticWidgetTranscript>
        <WidgetReplay toolName="open_view" onCallTool={call} />
      </StaticWidgetTranscript>,
    );
    expect(
      screen.getByText(/Interactive widget for open_view/),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it.each(["scope", "prop", "unknown"])(
    "selects an App placeholder before PartSwitch hooks via %s",
    (mode) => {
      const props = {
        part: {
          type: "tool-open_view",
          toolCallId: "call",
          state: "output-available",
          input: {},
          output: {},
        },
        role: "assistant",
        toolsMetadata:
          mode === "unknown"
            ? {}
            : { open_view: { ui: { resourceUri: "ui://view" } } },
        toolServerMap: {},
        onSendFollowUp: vi.fn(),
        onRequestPip: vi.fn(),
        onExitPip: vi.fn(),
        onRequestFullscreen: vi.fn(),
        onExitFullscreen: vi.fn(),
        pipWidgetId: null,
        fullscreenWidgetId: null,
        ...(mode === "prop" ? { widgetPolicy: "placeholder" } : {}),
      } as Parameters<typeof PartSwitch>[0];
      const part = <PartSwitch {...props} />;
      render(
        mode !== "prop" ? (
          <StaticWidgetTranscript>{part}</StaticWidgetTranscript>
        ) : (
          part
        ),
      );
      expect(
        screen.getByText(
          mode === "unknown"
            ? /Tool result: open_view/
            : /Interactive widget for open_view/,
        ),
      ).toBeInTheDocument();
      expect(document.querySelector("iframe")).toBeNull();
    },
  );
});
