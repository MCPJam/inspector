import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  addTokenToUrl: vi.fn((url: string) => url),
}));

import { webPost, WebApiError } from "../base";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

describe("web/base hosted rpc logs", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    useTrafficLogStore.getState().clear();
  });

  it("strips hosted rpc logs from successful JSON responses and ingests them", async () => {
    authFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          value: 123,
          _rpcLogs: [
            {
              serverId: "srv-1",
              serverName: "Notion",
              direction: "send",
              timestamp: "2026-04-10T12:00:00.000Z",
              message: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await webPost<
      { request: boolean },
      { ok: boolean; value: number }
    >("/api/web/tools/list", { request: true });

    expect(result).toEqual({ ok: true, value: 123 });
    expect(useTrafficLogStore.getState().mcpServerItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "srv-1",
          serverName: "Notion",
          direction: "SEND",
          method: "tools/list",
        }),
      ]),
    );
  });

  it("strips hosted rpc logs from error JSON responses before throwing", async () => {
    authFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "boom",
          _rpcLogs: [
            {
              serverId: "srv-2",
              serverName: "GitHub",
              direction: "receive",
              timestamp: "2026-04-10T12:00:00.000Z",
              message: {
                jsonrpc: "2.0",
                id: 1,
                result: { ok: false },
              },
            },
          ],
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(
      webPost<{ request: boolean }, { ok: boolean }>("/api/web/tools/list", {
        request: true,
      }),
    ).rejects.toEqual(
      expect.objectContaining<WebApiError>({
        status: 500,
        code: "INTERNAL_ERROR",
        message: "boom",
      }),
    );

    expect(useTrafficLogStore.getState().mcpServerItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "srv-2",
          serverName: "GitHub",
          direction: "RECEIVE",
          method: "result",
        }),
      ]),
    );
  });
});
