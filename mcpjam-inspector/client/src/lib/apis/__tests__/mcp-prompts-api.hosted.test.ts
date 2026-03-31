import { beforeEach, describe, expect, it, vi } from "vitest";

const listHostedPromptsMock = vi.fn();
const listHostedPromptsMultiMock = vi.fn();
const resolveHostedServerIdMock = vi.fn();
const isGuestModeMock = vi.fn(() => false);

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
  isGuestMode: () => isGuestModeMock(),
  resolveHostedServerId: (...args: unknown[]) =>
    resolveHostedServerIdMock(...args),
}));

import { listPromptsForServers } from "../mcp-prompts-api";

describe("mcp-prompts-api hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGuestModeMock.mockReturnValue(false);
  });

  it("lists prompts per server directly for hosted guests", async () => {
    isGuestModeMock.mockReturnValue(true);
    listHostedPromptsMock
      .mockResolvedValueOnce({ prompts: [{ name: "draw" }] })
      .mockResolvedValueOnce({ prompts: [{ name: "animate" }] });

    const result = await listPromptsForServers([
      "Excalidraw (App)",
      "Other Server",
    ]);

    expect(listHostedPromptsMock).toHaveBeenNthCalledWith(1, {
      serverNameOrId: "Excalidraw (App)",
    });
    expect(listHostedPromptsMock).toHaveBeenNthCalledWith(2, {
      serverNameOrId: "Other Server",
    });
    expect(listHostedPromptsMultiMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      prompts: {
        "Excalidraw (App)": [{ name: "draw" }],
        "Other Server": [{ name: "animate" }],
      },
      errors: undefined,
    });
  });

  it("keeps the batch hosted path for authenticated hosted workspaces", async () => {
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
