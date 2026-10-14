import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import { EvalExportModal } from "../eval-export-modal";

const mockCapture = vi.fn();
const mockExportServerApi = vi.fn();
const mockDownloadTextFile = vi.fn();

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => mockCapture(...args),
}));

vi.mock("@/lib/apis/mcp-export-api", () => ({
  exportServerApi: (...args: unknown[]) => mockExportServerApi(...args),
}));

vi.mock("@/lib/download-text-file", () => ({
  downloadTextFile: (...args: unknown[]) => mockDownloadTextFile(...args),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const singleServerEntries = {
  weather: {
    name: "weather",
    config: { url: "https://weather.example.com/mcp" },
    connectionStatus: "connected",
    lastConnectionTime: new Date(),
    retryCount: 0,
  },
};

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  scope: "suite" as const,
  suite: {
    name: "Demo Suite",
    description: "Exported for tests",
    source: "sdk" as const,
    environment: { servers: ["weather"] },
  },
  cases: [
    {
      id: "case-1",
      title: "Weather lookup",
      query: "What is the weather in Paris?",
      runs: 1,
      isNegativeTest: false,
      expectedToolCalls: [
        { toolName: "get_weather", arguments: { city: "Paris" } },
      ],
      promptTurns: [
        {
          id: "turn-1",
          prompt: "What is the weather in Paris?",
          expectedToolCalls: [
            { toolName: "get_weather", arguments: { city: "Paris" } },
          ],
        },
      ],
    },
  ],
  serverEntries: singleServerEntries,
};

describe("EvalExportModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportServerApi.mockResolvedValue({
      serverId: "weather",
      exportedAt: "2026-04-05T00:00:00.000Z",
      tools: [],
      resources: [],
      prompts: [],
    });
  });

  it("shows an explicit disabled-state message when prompt export is unavailable", () => {
    renderWithProviders(
      <EvalExportModal
        {...baseProps}
        suite={{
          ...baseProps.suite,
          environment: { servers: ["weather", "calendar"] },
        }}
        serverEntries={{
          ...singleServerEntries,
          calendar: {
            name: "calendar",
            config: { url: "https://calendar.example.com/mcp" },
            connectionStatus: "connected",
            lastConnectionTime: new Date(),
            retryCount: 0,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("tab", { name: "Prompt for agent" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        /only available when the suite targets exactly one MCP server/i,
      ),
    ).toBeInTheDocument();
  });

  it("finds a server the suite attached through a host", async () => {
    renderWithProviders(
      <EvalExportModal
        {...baseProps}
        suite={{
          ...baseProps.suite,
          // How a suite carries its server once it picks one through a host:
          // the legacy flat list stays empty, and reading only that reported
          // a configured suite as having no server at all.
          environment: { servers: [] },
          hostAttachments: [
            { namedHostId: "host-1", resolvedServerNames: ["weather"] },
          ],
        }}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Prompt for agent" }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByText(/does not have a server configured yet/i),
    ).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Prompt for agent" }));
    await waitFor(() =>
      expect(mockExportServerApi).toHaveBeenCalledWith("weather"),
    );
  });

  it("downloads the generated SDK test file", async () => {
    const user = userEvent.setup();

    renderWithProviders(<EvalExportModal {...baseProps} />);

    await user.click(
      screen.getByRole("button", {
        name: /download demo-suite\.eval\.test\.ts/i,
      }),
    );

    expect(mockDownloadTextFile).toHaveBeenCalledTimes(1);
    expect(mockDownloadTextFile.mock.calls[0]?.[0]).toBe(
      "demo-suite.eval.test.ts",
    );
    expect(mockDownloadTextFile.mock.calls[0]?.[1]).toContain(
      'SUITE_NAME = "Demo Suite"',
    );
    expect(mockExportServerApi).not.toHaveBeenCalled();
  });

  it("loads live capabilities only when the prompt tab is selected", async () => {
    const user = userEvent.setup();

    renderWithProviders(<EvalExportModal {...baseProps} />);
    expect(mockExportServerApi).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Prompt for agent" }),
      ).not.toBeDisabled(),
    );

    await user.click(screen.getByRole("tab", { name: "Prompt for agent" }));

    await screen.findByText(/MCP Server Brief: weather/);
    expect(mockExportServerApi).toHaveBeenCalledWith("weather");
    expect(screen.getByText(/MCP Server Brief: weather/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy prompt for agent" }),
    ).toBeInTheDocument();
  });

  it("downloads the agent prompt as markdown", async () => {
    const user = userEvent.setup();

    renderWithProviders(<EvalExportModal {...baseProps} />);

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Prompt for agent" }),
      ).not.toBeDisabled(),
    );

    await user.click(screen.getByRole("tab", { name: "Prompt for agent" }));

    await screen.findByText(/MCP Server Brief: weather/);
    await user.click(
      screen.getByRole("button", {
        name: /download demo-suite\.agent-prompt\.md/i,
      }),
    );

    expect(mockDownloadTextFile).toHaveBeenCalledWith(
      "demo-suite.agent-prompt.md",
      expect.stringContaining("MCP Server Brief: weather"),
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "eval_export_modal_downloaded",
      expect.objectContaining({ tab: "prompt_for_agent" }),
    );
  });

  it("keeps SDK export available after a live capability failure and retries the prompt", async () => {
    mockExportServerApi.mockRejectedValueOnce(
      new Error("MCP server returned HTTP 404 (export failed with 424)"),
    );
    const user = userEvent.setup();
    renderWithProviders(<EvalExportModal {...baseProps} />);

    expect(mockExportServerApi).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Prompt for agent" }));
    await screen.findByText("Agent prompt failed. Retry below.");
    expect(
      screen.getByText(/MCP server returned HTTP 404/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/For connection errors, check the MCP server URL/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Prompt for agent" }),
    ).toHaveAttribute("aria-selected", "true");

    await user.click(
      screen.getByRole("button", { name: "Retry agent prompt" }),
    );
    await screen.findByText(/MCP Server Brief: weather/);
    expect(mockExportServerApi).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("tab", { name: "SDK code" }));
    expect(
      screen.queryByText("Agent prompt failed. Retry below."),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: /download demo-suite\.eval\.test\.ts/i,
      }),
    );
    expect(mockDownloadTextFile).toHaveBeenCalledWith(
      "demo-suite.eval.test.ts",
      expect.stringContaining("get_weather"),
    );
    expect(mockExportServerApi).toHaveBeenCalledTimes(2);
  });

  it("ignores a capability response after switching back to SDK code", async () => {
    let rejectExport!: (error: Error) => void;
    mockExportServerApi.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectExport = reject;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<EvalExportModal {...baseProps} />);
    await user.click(screen.getByRole("tab", { name: "Prompt for agent" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking live server capabilities",
    );
    await user.click(screen.getByRole("tab", { name: "SDK code" }));
    rejectExport(new Error("HTTP 404"));
    await user.click(
      screen.getByRole("button", {
        name: /download demo-suite\.eval\.test\.ts/i,
      }),
    );
    expect(
      screen.queryByText("Agent prompt failed. Retry below."),
    ).not.toBeInTheDocument();
    expect(mockDownloadTextFile).toHaveBeenCalledTimes(1);
  });

  it("downloads SDK code after a capability failure even with missing local server details", async () => {
    mockExportServerApi.mockRejectedValue(new Error("HTTP 404"));
    const user = userEvent.setup();
    renderWithProviders(<EvalExportModal {...baseProps} serverEntries={{}} />);
    await user.click(screen.getByRole("tab", { name: "Prompt for agent" }));
    await screen.findByText("Agent prompt failed. Retry below.");
    await user.click(screen.getByRole("tab", { name: "SDK code" }));
    expect(
      screen.getByText("Local server details are incomplete"),
    ).toBeInTheDocument();
    expect(screen.queryByText("HTTP 404")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: /download demo-suite\.eval\.test\.ts/i,
      }),
    );
    expect(mockDownloadTextFile).toHaveBeenCalledWith(
      "demo-suite.eval.test.ts",
      expect.stringContaining("<replace-with-server-url>"),
    );
    expect(mockExportServerApi).toHaveBeenCalledTimes(1);
  });

  it.each([{ servers: [] }, { servers: ["weather", "calendar"] }])(
    "returns to SDK code if the prompt's single-server requirement changes to $servers",
    async ({ servers }) => {
      const user = userEvent.setup();
      const { rerender } = renderWithProviders(
        <EvalExportModal {...baseProps} />,
      );
      await user.click(screen.getByRole("tab", { name: "Prompt for agent" }));
      await screen.findByText(/MCP Server Brief: weather/);

      rerender(
        <EvalExportModal
          {...baseProps}
          suite={{ ...baseProps.suite, environment: { servers } }}
        />,
      );

      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "SDK code" })).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      );
      expect(screen.getByRole("tab", { name: "Prompt for agent" })).toBeDisabled();
      expect(mockExportServerApi).toHaveBeenCalledTimes(1);
    },
  );
});
