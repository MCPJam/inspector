import { beforeEach, describe, expect, it, vi } from "vitest";

const listHostedPromptsMock = vi.fn();
const listHostedPromptsMultiMock = vi.fn();
const resolveHostedServerIdMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/prompts-api", () => ({
  getHostedPrompt: vi.fn(),
  listHostedPrompts: (...args: unknown[]) => listHostedPromptsMock(...args),
  listHostedPromptsMulti: (...args: unknown[]) =>
    listHostedPromptsMultiMock(...args),
}));

vi.mock("@/lib/apis/web/context", () => ({
  resolveHostedServerId: (...args: unknown[]) =>
    resolveHostedServerIdMock(...args),
}));

import { listPromptsForServers } from "../mcp-prompts-api";

describe("mcp-prompts-api hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the batch hosted path for hosted guests", async () => {
    listHostedPromptsMultiMock.mockResolvedValueOnce({
      prompts: {
        "srv-excalidraw": [{ name: "draw" }],
        "srv-other": [{ name: "animate" }],
      },
    });
    resolveHostedServerIdMock
      .mockReturnValueOnce("srv-excalidraw")
      .mockReturnValueOnce("srv-other");

    const result = await listPromptsForServers([
      "Excalidraw (App)",
      "Other Server",
    ]);

    expect(listHostedPromptsMultiMock).toHaveBeenCalledWith({
      serverNamesOrIds: ["Excalidraw (App)", "Other Server"],
    });
    expect(listHostedPromptsMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      prompts: {
        "Excalidraw (App)": [{ name: "draw" }],
        "Other Server": [{ name: "animate" }],
      },
      errors: undefined,
    });
  });

  it("keeps the batch hosted path for authenticated hosted projects", async () => {
    listHostedPromptsMultiMock.mockResolvedValueOnce({
      prompts: { "srv-excalidraw": [{ name: "draw" }] },
    });
    resolveHostedServerIdMock.mockReturnValue("srv-excalidraw");

    const result = await listPromptsForServers(["Excalidraw (App)"]);

    expect(listHostedPromptsMultiMock).toHaveBeenCalledWith({
      serverNamesOrIds: ["Excalidraw (App)"],
    });
    expect(result).toEqual({
      prompts: { "Excalidraw (App)": [{ name: "draw" }] },
      errors: undefined,
    });
  });
});
