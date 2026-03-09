import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  managerConfigsMock,
  getToolsForAiSdkMock,
  getInitializationInfoMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  managerConfigsMock: vi.fn(),
  getToolsForAiSdkMock: vi.fn(),
  getInitializationInfoMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", () => ({
  MCPClientManager: vi.fn().mockImplementation((configs: unknown) => {
    managerConfigsMock(configs);
    return {
      getToolsForAiSdk: getToolsForAiSdkMock,
      getInitializationInfo: getInitializationInfoMock,
      disconnectAllServers: disconnectAllServersMock,
    };
  }),
}));

import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";
import {
  initGuestTokenSecret,
  issueGuestToken,
} from "../../../services/guest-token.js";

describe("web routes — guest OAuth validation", () => {
  beforeEach(() => {
    initGuestTokenSecret();
    managerConfigsMock.mockReset();
    getToolsForAiSdkMock.mockReset();
    getInitializationInfoMock.mockReset();
    disconnectAllServersMock.mockReset();

    getToolsForAiSdkMock.mockResolvedValue({});
    getInitializationInfoMock.mockReturnValue({
      serverVersion: { title: "T" },
    });
    disconnectAllServersMock.mockResolvedValue(undefined);
  });

  it("uses the explicit oauthAccessToken over stale guest Authorization headers", async () => {
    const { app } = createWebTestApp();
    const { token } = issueGuestToken();

    const response = await postJson(
      app,
      "/api/web/servers/validate",
      {
        serverUrl: "https://example.com/mcp",
        serverHeaders: {
          Authorization: "Bearer stale-token",
          "X-Trace": "abc",
        },
        oauthAccessToken: "fresh-token",
      },
      token,
    );

    const { status, data } = await expectJson<{
      success: boolean;
      status: string;
    }>(response);

    expect(status).toBe(200);
    expect(data).toEqual({
      success: true,
      status: "connected",
      initInfo: { serverVersion: { title: "T" } },
    });
    expect(managerConfigsMock).toHaveBeenCalledWith({
      __guest__: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer fresh-token",
            "X-Trace": "abc",
          },
        },
        timeout: expect.any(Number),
      },
    });
  });
});
