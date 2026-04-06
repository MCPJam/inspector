import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import { EvalExportModal } from "../eval-export-modal";

const mockCapture = vi.fn();
const mockExportServerApi = vi.fn();
const mockDownloadTextFile = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: mockCapture }),
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
      screen.getByText(/only available when the suite targets exactly one MCP server/i),
    ).toBeInTheDocument();
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
      'describe("Demo Suite"',
    );
  });

  it("loads the live agent prompt and enables the prompt tab", async () => {
    const user = userEvent.setup();

    renderWithProviders(<EvalExportModal {...baseProps} />);

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Prompt for agent" }),
      ).not.toBeDisabled(),
    );

    await user.click(screen.getByRole("tab", { name: "Prompt for agent" }));

    expect(mockExportServerApi).toHaveBeenCalledWith("weather");
    expect(screen.getByText(/MCP Server Brief: weather/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy prompt for agent" }),
    ).toBeInTheDocument();
  });
});
