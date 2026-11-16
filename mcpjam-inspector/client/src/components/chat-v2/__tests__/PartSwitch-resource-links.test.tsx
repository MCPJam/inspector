import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PartSwitch } from "../thread/part-switch";
import { WorkspaceFileActionsProvider } from "@/components/host-workspace/file-actions";
import { createThreadAppApi } from "@/components/host-workspace/thread-app-api";
import {
  injectHostedServerMapping,
  setApiContext,
} from "@/lib/apis/web/context";

const { observeToolPart } = vi.hoisted(() => ({ observeToolPart: vi.fn() }));
vi.mock("../thread/parts/tool-part", async (importOriginal) => {
  const { ToolPart } =
    await importOriginal<typeof import("../thread/parts/tool-part")>();
  return {
    ToolPart: (props: ComponentProps<typeof ToolPart>) => {
      observeToolPart(props);
      return <ToolPart {...props} />;
    },
  };
});
vi.mock("../thread/use-forwarded-widget-calls", () => ({
  useForwardedWidgetCalls: () => ({ approvals: [], call: vi.fn() }),
}));
vi.mock("../thread/widget-replay", () => ({ WidgetReplay: () => null }));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    projects: { default: { sharedProjectId: "project-1" } },
    activeProjectId: "default",
    selectedServer: "local-alias",
    servers: { "local-alias": {} },
  }),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));
vi.mock("@/lib/mcp-ui/mcp-apps-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp-ui/mcp-apps-utils")>()),
  detectUIType: () => null,
}));
vi.mock("@/components/ui/json-editor", () => ({ JsonEditor: () => null }));
vi.mock("../thread/parts/text-part", () => ({ TextPart: () => null }));

const resourceUri = "fixture-file://parts/triangle.stl";
const viewer = {
  kind: "file" as const,
  title: "CAD Viewer",
  toolName: "cad.open",
  resourceUri,
};
const props: ComponentProps<typeof PartSwitch> = {
  role: "assistant",
  part: {
    type: "dynamic-tool",
    toolName: "qa.sample",
    toolCallId: "resource-call",
    state: "output-available",
    input: {},
    output: {
      content: [
        { type: "resource_link", name: "triangle.stl", uri: resourceUri },
      ],
    },
    resultProviderMetadata: { mcpjam: { serverId: "saved-id" } },
  },
  toolsMetadata: {},
  toolServerMap: { "qa.sample": "saved-id" },
  onSendFollowUp: vi.fn(),
  pipWidgetId: null,
  fullscreenWidgetId: null,
  onRequestPip: vi.fn(),
  onExitPip: vi.fn(),
  onRequestFullscreen: vi.fn(),
  onExitFullscreen: vi.fn(),
};

function workspace(serverIds: string[]) {
  const api = createThreadAppApi({
    projectId: "project-1",
    hostId: "host-1",
    threadId: "chat-1",
    pluginWorkspace: { version: 1, workspaceId: "workspace-1" },
  });
  const discoverFile = vi
    .spyOn(api, "discoverFile")
    .mockResolvedValue([viewer]);
  const open = vi.fn(async () => {});
  return { value: { api, serverIds, open }, discoverFile, open };
}

afterEach(() => {
  setApiContext(null);
  vi.clearAllMocks();
});

describe("PartSwitch resource provenance", () => {
  it.each([false, true])(
    "opens the saved server's resource when a local alias exists: %s",
    async (local) => {
      if (local) injectHostedServerMapping("local-alias", "saved-id");
      const owner = workspace(["saved-id"]);
      render(
        <WorkspaceFileActionsProvider value={owner.value}>
          <PartSwitch {...props} />
        </WorkspaceFileActionsProvider>,
      );
      expect(observeToolPart.mock.calls.at(-1)?.[0].serverId).toBe(
        local ? "local-alias" : "saved-id",
      );
      expect(owner.discoverFile).not.toHaveBeenCalled();
      await userEvent.click(
        screen.getByRole("button", { name: "triangle.stl" }),
      );
      await waitFor(() =>
        expect(owner.open).toHaveBeenCalledWith("saved-id", viewer),
      );
      expect(owner.discoverFile).toHaveBeenCalledWith(
        "saved-id",
        resourceUri,
        expect.any(AbortSignal),
      );
    },
  );

  it("does not borrow another saved server's file authority", () => {
    injectHostedServerMapping("local-alias", "saved-id");
    const owner = workspace(["another-saved-id"]);
    render(
      <WorkspaceFileActionsProvider value={owner.value}>
        <PartSwitch {...props} />
      </WorkspaceFileActionsProvider>,
    );
    expect(screen.queryByRole("button", { name: "triangle.stl" })).toBeNull();
    expect(owner.discoverFile).not.toHaveBeenCalled();
    expect(owner.open).not.toHaveBeenCalled();
  });
});
