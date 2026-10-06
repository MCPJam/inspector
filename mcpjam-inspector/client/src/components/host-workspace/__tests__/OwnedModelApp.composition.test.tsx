import { useEffect, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import {
  OwnedModelApp,
  OwnedModelAppPortsProvider,
  useOwnedModelAppWorkspace,
} from "../OwnedModelApp";
import {
  ContextAttachmentChip,
  ContextGroupChip,
  groupContextAttachments,
} from "../../chat-v2/chat-input/attachments/context-attachment-chip";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  host: null as WidgetHost | null,
  renderCount: 0,
  mounted: 0,
  sourceEffects: 0,
  notifications: [] as unknown[],
}));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));
const policy = {
  environment: { draftHostContext: {} },
  surface: {},
  resolvers: {
    resolveEffectiveCompatRuntime: () => ({ injected: false }),
    resolveEffectiveHostCapabilities: () => ({
      serverTools: {},
      updateModelContext: {},
      message: {},
    }),
    resolveEffectiveMcpAppsCapabilities: () => ({
      serverTools: true,
      updateModelContext: true,
      message: true,
      hostContextChanged: true,
      availableDisplayModes: ["inline", "fullscreen"],
    }),
  },
} as unknown as WidgetHost;
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => policy,
}));
// Replace only the iframe renderer. The owner, API, context controller, host
// composition, workspace publication and shared chip are real production code.
// Real bridge notification delivery is separately covered by Chromium tests.
vi.mock("@mcpjam/widget-react", () => ({
  WidgetHostProvider: ({
    value,
    children,
  }: {
    value: WidgetHost;
    children: unknown;
  }) => {
    mocks.host = value;
    return children;
  },
  MCPAppsRenderer: ({
    onCallTool,
  }: {
    onCallTool: (name: string, args: object) => Promise<unknown>;
  }) => {
    mocks.renderCount++;
    if (mocks.renderCount > 40) throw new Error("Renderer publication loop");
    useEffect(() => {
      mocks.mounted++;
      void onCallTool("fixture.load", {}).catch(() => {});
    }, []);
    const context =
      mocks.host?.environment.draftHostContext?.["openai/modelContext"];
    useEffect(() => {
      mocks.notifications.push(context);
    }, [context]);
    return <div data-testid="guest-context">{JSON.stringify(context)}</div>;
  },
}));

const token = "b".repeat(43);
const updateId = "10000000-0000-4000-8000-000000000001";
const handle = {
  instanceToken: token,
  instanceId: "original-app",
  generation: 1,
  resourceUri: "ui://part",
  widgetContent: { html: "fixture" },
  toolMetadata: {},
  toolTitle: "Parts",
  appToolsEnabled: true,
  contextEnabled: true,
  messageEnabled: true,
  contextSnapshot: { revision: 0, sequence: 0, state: null },
};
const marker = {
  instanceToken: token,
  projectId: "project",
  workspaceId: "workspace",
  hostId: "host",
  serverId: "saved-server",
};
const params = {
  content: [
    {
      type: "text",
      text: "Selected triangle",
      _meta: { "openai/title": "Triangle" },
    },
  ],
};
const sendMessage = vi.fn(async () => true);
function Workspace({
  show = true,
  workspaceId = "workspace",
}: {
  show?: boolean;
  workspaceId?: string;
}) {
  const workspace = useOwnedModelAppWorkspace(sendMessage, {
    ...marker,
    workspaceId,
    key: `actor:${workspaceId}`,
  });
  const [hidden, setHidden] = useState(false);
  return (
    <OwnedModelAppPortsProvider value={workspace.value}>
      <button onClick={() => setHidden((value) => !value)}>
        Hide or reopen
      </button>
      <output data-testid="references">
        {JSON.stringify(workspace.references)}
      </output>
      {workspace.attachments.map((item) => (
        <ContextAttachmentChip key={item.id} {...item} />
      ))}
      <div hidden={hidden}>
        {show && (
          <OwnedModelApp
            marker={marker}
            renderProps={{
              toolCallId: "original-call",
              toolName: "fixture.part",
              serverId: "saved-server",
              resourceUri: "ui://part",
              toolState: "output-available",
              chatSessionId: "thread",
            }}
          />
        )}
      </div>
    </OwnedModelAppPortsProvider>
  );
}
const reply = (value: unknown) => new Response(JSON.stringify(value));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.host = null;
  mocks.renderCount = 0;
  mocks.mounted = 0;
  mocks.sourceEffects = 0;
  mocks.notifications = [];
});

function GroupedWorkspace() {
  const workspace = useOwnedModelAppWorkspace(sendMessage, {
    ...marker,
    key: "actor:workspace",
  });
  return (
    <OwnedModelAppPortsProvider value={workspace.value}>
      <output data-testid="references">
        {JSON.stringify(workspace.references)}
      </output>
      {groupContextAttachments(workspace.attachments).map((entry) =>
        entry.kind === "group" ? (
          <ContextGroupChip
            key={entry.group.id}
            group={entry.group}
            items={entry.items}
          />
        ) : null,
      )}
      <OwnedModelApp
        marker={marker}
        renderProps={{
          toolCallId: "original-call",
          toolName: "fixture.part",
          serverId: "saved-server",
          resourceUri: "ui://part",
          toolState: "output-available",
          chatSessionId: "thread",
        }}
      />
    </OwnedModelAppPortsProvider>
  );
}

describe("a later send and Remove all", () => {
  it("references the App only while it has context, and Remove all clears the chip and tells the App null", async () => {
    let server: { updateId: string; content: unknown[] } | null = null;
    let revision = 0;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.endsWith("/model/open")) return reply(handle);
      if (url.endsWith("/model/call"))
        return reply({ status: "completed", result: { content: [] } });
      if (url.endsWith("/model/context")) {
        server = { updateId, content: body.params.content };
        revision++;
        return reply({
          _meta: { "openai/modelContext": { updateId } },
          snapshot: { revision, sequence: body.sequence, state: server },
        });
      }
      if (url.endsWith("/model/context/remove")) {
        const content = server!.content.filter((_, i) => i !== body.index);
        server = content.length ? { updateId: `${updateId}-${revision}`.slice(0, 36), content } : null;
        revision++;
        return reply({ revision, sequence: 1, state: server });
      }
      if (url.endsWith("/model/close")) return reply({ closed: true });
      throw new Error("Unexpected API path");
    });
    render(<GroupedWorkspace />);
    await waitFor(() => expect(mocks.host).not.toBeNull());
    // Nothing attached: a send carries no reference to this App.
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    await act(async () => {
      await mocks.host!.services.updateModelContext!({
        content: [
          params.content[0],
          { type: "text", text: "Inspection note" },
        ],
      });
    });
    expect(screen.getByTestId("references")).toHaveTextContent(token);
    expect(
      screen.getByRole("button", { name: "Parts context, 2 items" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove all Parts context" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove all Parts context" }),
      ).not.toBeInTheDocument(),
    );
    expect(server).toBeNull();
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    expect(mocks.notifications.at(-1)).toBeNull();
    // The next send no longer depends on this App.
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
  });
});

describe("inline App and composer composition", () => {
  it("publishes/removes real context with stable ownership and no repeated load effect", async () => {
    let finishRemoval!: (response: Response) => void;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.instanceToken).toBe(token);
      if (url.endsWith("/model/open")) return reply(handle);
      if (url.endsWith("/model/call")) {
        mocks.sourceEffects++;
        return reply({ status: "completed", result: { content: [] } });
      }
      if (url.endsWith("/model/context")) {
        expect(body.sequence).toBeGreaterThanOrEqual(1);
        expect(body.params).toEqual(
          body.sequence === 2
            ? { content: [], structuredContent: { fixture: true, value: 42 } }
            : params,
        );
        return reply({
          _meta: { "openai/modelContext": { updateId } },
          snapshot: {
            revision: body.sequence * 2 - 1,
            sequence: body.sequence,
            state: { updateId, ...body.params },
          },
        });
      }
      if (url.endsWith("/model/context/remove")) {
        expect(body.updateId).toBe(updateId);
        expect(body.index).toBe(0);
        return new Promise<Response>((resolve) => {
          finishRemoval = resolve;
        });
      }
      if (url.endsWith("/model/close")) return reply({ closed: true });
      throw new Error("Unexpected API path");
    });
    const view = render(<Workspace />);
    await waitFor(() => expect(mocks.sourceEffects).toBe(1));
    const update = mocks.host!.services.updateModelContext!;
    await act(async () => {
      await update(params);
    });
    expect(
      screen.getByRole("button", { name: "Remove Triangle" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("references")).toHaveTextContent(token);
    expect(screen.getByTestId("guest-context")).toHaveTextContent(updateId);
    const ownedUpdate = mocks.host!.services.updateModelContext;
    for (let index = 0; index < 4; index++)
      fireEvent.click(screen.getByText("Hide or reopen"));
    view.rerender(<Workspace />);
    expect(mocks.host!.services.updateModelContext).toBe(ownedUpdate);
    expect(mocks.sourceEffects).toBe(1);
    expect(mocks.mounted).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove Triangle" }));
    await waitFor(() => expect(finishRemoval).toBeTypeOf("function"));
    expect(
      screen.getByRole("button", { name: "Remove Triangle" }),
    ).toBeDisabled();
    expect(screen.getByTestId("guest-context")).toHaveTextContent(updateId);
    await act(async () => {
      finishRemoval(reply({ revision: 2, sequence: 1, state: null }));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove Triangle" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    expect(mocks.notifications.at(-1)).toBeNull();
    expect(mocks.sourceEffects).toBe(1);
    // Structured state also uses the same removable composer chip and the
    // existing authenticated removal/notification protocol.
    const structured = {
      content: [],
      structuredContent: { fixture: true, value: 42 },
    };
    await act(async () => {
      await update(structured);
    });
    expect(
      screen.getByRole("button", { name: "Remove App context" }),
    ).toBeInTheDocument();
    const previousRemoval = finishRemoval;
    fireEvent.click(screen.getByRole("button", { name: "Remove App context" }));
    await waitFor(() => expect(finishRemoval).not.toBe(previousRemoval));
    await act(async () => {
      finishRemoval(reply({ revision: 4, sequence: 2, state: null }));
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove App context" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("guest-context")).toHaveTextContent("null");
    expect(mocks.sourceEffects).toBe(1);
    // Keep the old leaf mounted deliberately: scope change must fence it before
    // passive cleanup, and returning cannot revive its former publications.
    await act(async () => {
      await update(params);
    });
    expect(
      screen.getByRole("button", { name: "Remove Triangle" }),
    ).toBeInTheDocument();
    view.rerender(<Workspace workspaceId="new-workspace" />);
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    expect(
      screen.queryByRole("button", { name: "Remove Triangle" }),
    ).not.toBeInTheDocument();
    view.rerender(<Workspace />);
    expect(screen.getByTestId("references")).toHaveTextContent("[]");
    expect(
      screen.queryByRole("button", { name: "Remove Triangle" }),
    ).not.toBeInTheDocument();
    expect(mocks.sourceEffects).toBe(1);
    view.rerender(<Workspace show={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("references")).toHaveTextContent("[]"),
    );
    await waitFor(() =>
      expect(
        mocks.fetch.mock.calls.some(([url]) =>
          String(url).endsWith("/model/close"),
        ),
      ).toBe(true),
    );
    await expect(update(params)).rejects.toThrow();
    expect(mocks.sourceEffects).toBe(1);
    expect(mocks.renderCount).toBeLessThan(40);
  });
});
