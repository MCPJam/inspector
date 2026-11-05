import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { MCPAppsRendererSurface } from "@mcpjam/widget-react";
const f = vi.hoisted(() => ({
  fetch: vi.fn(),
  upload: vi.fn(),
  failed: vi.fn(),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: f.fetch }));
vi.mock("@/lib/apis/web/base", () => ({
  webPost: f.upload,
  WebApiError: class extends Error {},
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: vi.fn() }),
  useQuery: (name: string) =>
    name === "users:getCurrentUser" ? { _id: "actor" } : [],
}));
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({
    environment: { draftHostContext: {} },
    surface: {},
    services: {},
    resolvers: {
      resolveEffectiveHostCapabilities: () => ({ serverTools: {} }),
      resolveEffectiveMcpAppsCapabilities: () => ({ serverTools: true }),
    },
  }),
}));
vi.mock("@mcpjam/widget-react", async (original) => ({
  ...(await original<object>()),
  WidgetHostProvider: ({ children }: { children: ReactNode }) => children,
  MCPAppsRendererSurface: function Child({
    onCallTool,
  }: ComponentProps<typeof MCPAppsRendererSurface>) {
    const [result, setResult] = useState("");
    return (
      <>
        <button
          onClick={() => {
            void onCallTool?.("review", {})
              .then((value) => setResult(JSON.stringify(value)))
              .catch(f.failed);
          }}
        >
          Ask Settings form
        </button>
        <output data-testid="settings-mrtr-result">{result}</output>
      </>
    );
  },
}));
import { ServerSettingsPanel } from "../ServerSettingsPanel";
import { settingsFixture } from "@/shared/__tests__/plugin-settings-fixture";
import { __resetComposerFormStore } from "../../elicitation/composer-form-store";
import { __resetHostedMrtrHostElection } from "../../elicitation/HostedMrtrHost";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
afterEach(() => {
  cleanup();
  __resetComposerFormStore();
  __resetHostedMrtrHostElection();
  useHostedMrtrStore.getState().__reset();
  vi.resetAllMocks();
});
it.each([false, true])(
  "answers or closes the actual Settings MRTR composition, closed=%s",
  async (close) => {
    const calls: Record<string, unknown>[] = [];
    f.upload.mockResolvedValue({ ok: true, storageId: "private-receipt" });
    f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/renew")) return Response.json({});
      if (url.endsWith("/open") && !url.includes("/app/"))
        return Response.json({
          instanceToken: "a".repeat(43),
          instanceId: "instance",
          generation: 1,
        });
      if (url.endsWith("/read"))
        return Response.json({
          status: "completed",
          result: { content: [], structuredContent: settingsFixture() },
        });
      if (url.endsWith("/actions"))
        return Response.json({
          actions: [{ name: "reset", kind: "app", title: "Preferences App" }],
        });
      if (url.endsWith("/app/open"))
        return Response.json({
          childToken: "b".repeat(43),
          resourceUri: "ui://settings",
          widgetContent: { html: "" },
          appToolsEnabled: true,
        });
      if (url.endsWith("/action"))
        return Response.json({ status: "completed", result: { content: [] } });
      if (url.endsWith("/app/call")) {
        calls.push(body);
        if (body.resume)
          return Response.json({
            status: "completed",
            result: { content: [{ type: "text", text: "answered" }] },
          });
        return Response.json({
          status: "input_required",
          continuationId: "settings-form",
          version: 1,
          serverId: "s",
          method: "tools/call",
          round: 1,
          expiresAt: Date.now() + 300000,
          negotiatedEra: "2026-07-28",
          pluginFormProfile: {
            fileResources: false,
            origin: "mcp-app",
            userResources: false,
            previews: false,
          },
          inputRequests: [
            {
              key: "form",
              mode: "form",
              message: "Confirm preferences",
              requestedSchema: {
                type: "object",
                properties: {
                  enabled: {
                    type: "boolean",
                    title: "Enabled",
                    default: false,
                  },
                  count: { type: "integer", title: "Count", default: 0 },
                },
                required: ["enabled", "count"],
              },
            },
          ],
        });
      }
      if (url.endsWith("/close")) return Response.json({ ok: true });
      throw new Error(`Unexpected ${url}`);
    });
    const view = render(
      <ServerSettingsPanel
        scope={{
          projectId: "p",
          hostId: "h",
          threadId: "t",
          pluginWorkspace: { version: 1, workspaceId: "parent" },
        }}
        serverId="s"
        serverName="Settings"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Preferences App" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask Settings form" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("settings-form-slot")).toHaveTextContent(
        "Confirm preferences",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    if (close) {
      view.unmount();
      await waitFor(() =>
        expect(useHostedMrtrStore.getState().rounds).toHaveLength(0),
      );
      expect(calls).toHaveLength(1);
      expect(f.failed).toHaveBeenCalledOnce();
      expect(f.upload.mock.calls.some(([url]) => url.endsWith("/cancel"))).toBe(
        true,
      );
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(screen.getByTestId("settings-mrtr-result")).toHaveTextContent(
          "answered",
        ),
      );
      expect(f.upload.mock.calls[0][1]).toEqual({
        form: { action: "accept", content: { enabled: false, count: 0 } },
      });
      expect(calls).toHaveLength(2);
      expect(calls[1].operationId).toBe(calls[0].operationId);
      expect(calls[1].resume).toEqual({
        continuationId: "settings-form",
        round: 1,
        responsesBlobId: "private-receipt",
      });
      expect(useHostedMrtrStore.getState().rounds).toHaveLength(0);
    }
  },
);
