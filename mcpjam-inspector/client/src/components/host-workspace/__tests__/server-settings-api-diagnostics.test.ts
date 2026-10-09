import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { createServerSettingsApi } from "../server-settings-api";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({ authFetch: fetch }));
const scope = {
  projectId: "project",
  hostId: "client",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
describe("settings transport diagnostics", () => {
  beforeEach(() => {
    fetch.mockReset();
    useTrafficLogStore.getState().clear();
  });
  it("logs a read tool without readOnlyHint and still discovers settings", async () => {
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          settings: { readTool: "read", updateTool: "save", title: "S" },
          diagnostics: [
            {
              level: "warning",
              code: "PLUGIN_SETTINGS_READ_NOT_READ_ONLY",
              title: "Settings read tool read is not marked read-only",
              description: "Add annotations.readOnlyHint: true.",
              serverId: "server",
            },
          ],
        }),
      ),
    );
    const api = createServerSettingsApi(scope, "server", vi.fn());
    expect(await api.discover(AbortSignal.timeout(1000))).toBe(true);
    expect(useTrafficLogStore.getState().mcpServerItems[0]).toMatchObject({
      serverId: "server",
      payload: {
        level: "warning",
        code: "PLUGIN_SETTINGS_READ_NOT_READ_ONLY",
      },
    });
  });
});
