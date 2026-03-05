import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpApiPresets } from "@/test/mocks/mcp-api";
import { storePresets } from "@/test/mocks/stores";
import {
  applyClientRuntimePresets,
  clientRuntimeMocks,
} from "@/test/mocks/client-runtime";
import { resolveFilePart } from "../openai-widget-state-messages";

vi.mock("@/lib/session-token", () => ({
  authFetch: clientRuntimeMocks.authFetchMock,
}));

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return clientRuntimeMocks.hostedMode;
  },
}));

vi.mock("@/hooks/use-app-state", () => ({
  useAppState: clientRuntimeMocks.useAppStateMock,
}));

vi.mock("@/state/mcp-api", () => clientRuntimeMocks.mcpApiMock);

describe("resolveFilePart (hosted mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyClientRuntimePresets({
      hostedMode: true,
      mcpApi: mcpApiPresets.allSuccess(),
      appState: storePresets.empty(),
    });
  });

  it("tries hosted web fallback when the primary endpoint throws", async () => {
    const fileId = "file_550e8400-e29b-41d4-a716-446655440000";
    clientRuntimeMocks.authFetchMock
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["fallback"], { type: "image/png" }),
      });

    const part = await resolveFilePart(fileId);

    expect(clientRuntimeMocks.authFetchMock).toHaveBeenCalledTimes(2);
    expect(clientRuntimeMocks.authFetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/apps/chatgpt-apps/file/${fileId}`,
    );
    expect(clientRuntimeMocks.authFetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/web/apps/chatgpt-apps/file/${fileId}`,
    );
    expect(part).toMatchObject({
      type: "file",
      mediaType: "image/png",
    });
    expect((part as { url: string }).url.startsWith("data:image/png;")).toBe(
      true,
    );
  });
});
