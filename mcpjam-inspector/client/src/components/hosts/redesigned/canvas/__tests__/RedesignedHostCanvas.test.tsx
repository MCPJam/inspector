import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";
import { ReactFlowProvider, type Edge } from "@xyflow/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  ADD_SERVER_NODE_ID,
  BUILTIN_TOOLS_NODE_ID,
  COMPUTER_NODE_ID,
  HOST_MATRIX_NODE_ID,
  SERVERS_HUB_NODE_ID,
} from "../../types";
import {
  RedesignedHostCanvas,
  shiftReflowedBranchEdges,
} from "../RedesignedHostCanvas";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

function renderCanvas(opts: {
  draft?: ReturnType<typeof emptyHostConfigInputV2>;
  hostName?: string;
  projectServers?: Array<{
    id: string;
    name: string;
    url?: string;
  }>;
}) {
  const viewModel = buildRedesignedHostCanvas(
    {
      hostName: opts.hostName ?? "Test host",
      draft: opts.draft ?? emptyHostConfigInputV2(),
      savedSnapshotId: "snap",
      isDirty: false,
      projectServers: opts.projectServers ?? [],
    },
    [],
  );
  return render(
    <ReactFlowProvider>
      <div style={{ width: 900, height: 700 }}>
        <RedesignedHostCanvas
          viewModel={viewModel}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          onAddServer={() => {}}
        />
      </div>
    </ReactFlowProvider>,
  );
}

describe("RedesignedHostCanvas", () => {
  it("renders the host matrix node with the display name", () => {
    const { container } = renderCanvas({ hostName: "Claude" });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    );
    expect(node).not.toBeNull();
    expect(
      within(node as HTMLElement).getByText("Claude"),
    ).toBeInTheDocument();
  });

  it("shows timeout on the identity subtitle beside client metadata", () => {
    const { container } = renderCanvas({});
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const sub = (node as HTMLElement).querySelector(".hp-host-sub");
    expect(sub).not.toBeNull();
    expect(sub!.textContent).toMatch(/Timeout/);
    expect(sub!.textContent).toMatch(/10s/);
    expect((node as HTMLElement).querySelector(".hp-agents")).toBeNull();
  });

  it("renders advertised client capabilities and the apps extension banner", () => {
    const { container } = renderCanvas({});
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const scope = within(node as HTMLElement);
    expect(scope.getByText("Client capabilities")).toBeInTheDocument();
    const caps = node!.querySelector(".hp-caps");
    expect(caps).not.toBeNull();
    const capScope = within(caps as HTMLElement);
    expect(capScope.getByText("extensions")).toBeInTheDocument();
    expect(capScope.queryByText("roots")).toBeNull();
    expect(capScope.queryByText("sampling")).toBeNull();
    expect(scope.getByText("View iframe")).toBeInTheDocument();
    expect(scope.getByText("uiInitialize")).toBeInTheDocument();
    expect(scope.queryByText(/no view loaded/i)).toBeNull();
    expect(scope.queryByText("ui/initialize")).toBeNull();
    expect(scope.getByText("openLinks")).toBeInTheDocument();
    expect(node!.querySelector(".hp-policy-tag")).toBeNull();
    expect(node!.querySelector(".hp-sandbox-sub")).toBeNull();
    expect(node!.querySelector(".hp-view-empty-label")).toBeNull();
  });

  it("does not show 'from preset' on injected-globals chips at the host preset default", () => {
    const { container } = renderCanvas({
      draft: emptyHostConfigInputV2({ hostStyle: "chatgpt" }),
    });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const injected = node!.querySelector(".hp-view-injected");
    expect(injected).not.toBeNull();
    expect(injected!.textContent).not.toMatch(/from preset/i);
    const injectedScope = within(injected as HTMLElement);
    expect(injectedScope.getByText("window.openai")).toBeInTheDocument();
    expect(injectedScope.getByText("MCP Apps")).toBeInTheDocument();
    expect(injectedScope.queryByText("overridden")).toBeNull();
  });

  it("adds a client capability chip when that cap is enabled on the host", () => {
    const base = emptyHostConfigInputV2();
    const { container } = renderCanvas({
      draft: emptyHostConfigInputV2({
        clientCapabilities: {
          ...base.clientCapabilities,
          roots: { listChanged: true },
        },
      }),
    });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const caps = node!.querySelector(".hp-caps");
    expect(caps).not.toBeNull();
    expect(within(caps as HTMLElement).getByText("roots")).toBeInTheDocument();
  });

  it("does not show required/optional chips on canvas server cards", () => {
    const { container } = renderCanvas({
      projectServers: [
        { id: "s1", name: "bench", url: "https://example.com" },
      ],
    });
    const card = container.querySelector(
      `.react-flow__node[data-id="server-card:s1"]`,
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(within(card!).queryByText(/^required$/i)).toBeNull();
    expect(within(card!).queryByText(/^optional$/i)).toBeNull();
  });

  it("styles the servers hub with neutral card chrome like server rows", () => {
    const { container } = renderCanvas({});
    const hub = container.querySelector(
      `.react-flow__node[data-id="${SERVERS_HUB_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(hub).not.toBeNull();
    const shell = hub!.firstElementChild as HTMLElement;
    expect(shell.className).toMatch(/\bborder-border\/70\b/);
    expect(shell.className).toMatch(/\bbg-card\/95\b/);
    expect(shell.className).not.toMatch(/diagram-server/);
  });

  it("does not duplicate extensions in a legacy Extensions footer strip", () => {
    const { container } = renderCanvas({});
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const scope = within(node as HTMLElement);
    expect(scope.queryByText(/^Extensions ·/)).toBeNull();
    expect(node!.querySelector(".hp-footer")).toBeNull();
  });

  it("strikes through apps caps the resolved blob omits", () => {
    const draft = emptyHostConfigInputV2({
      hostCapabilitiesOverride: { openLinks: {} },
    });
    const { container } = renderCanvas({ draft });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const hostCapsSection = [...node!.querySelectorAll(".hp-section")].find(
      (el) =>
        el
          .querySelector(".hp-section-title")
          ?.textContent?.includes("Host capabilities"),
    ) as HTMLElement | undefined;
    expect(hostCapsSection).toBeDefined();
    const strikethroughNames = [
      ...hostCapsSection!.querySelectorAll("button.hp-cap--off .hp-cap-name"),
    ].map((el) => el.textContent);
    expect(strikethroughNames).toContain("serverTools");
    const openLinksBtn = [...hostCapsSection!.querySelectorAll("button.hp-cap")].find(
      (b) => b.querySelector(".hp-cap-name")?.textContent === "openLinks",
    );
    expect(openLinksBtn).toBeDefined();
    expect(openLinksBtn!.className).not.toMatch(/\bhp-cap--off\b/);
  });

  it("shows Mistral host capabilities from the standard MCP Apps client extension", () => {
    const draft = emptyHostConfigInputV2({
      hostStyle: "mistral",
      hostCapabilitiesOverride: {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
      },
    });
    const { container } = renderCanvas({ draft });
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const scope = within(node as HTMLElement);

    expect(scope.getByText("Client capabilities")).toBeInTheDocument();
    expect(scope.getByText("extensions")).toBeInTheDocument();
    expect(scope.getByText("io.modelcontextprotocol/ui")).toBeInTheDocument();
    expect(scope.getByText("Host capabilities")).toBeInTheDocument();
    expect(scope.getByText("openLinks")).toBeInTheDocument();
    expect(scope.getByText("serverTools")).toBeInTheDocument();
  });

  it("renders both Project Computers islands when the feature is enabled", () => {
    const draft = emptyHostConfigInputV2();
    draft.builtInToolIds = ["web_search"];
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Claude",
        draft,
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
        computersEnabled: true,
        builtInToolCatalog: [
          {
            id: "web_search",
            displayLabel: "Web Search",
            description: "Search the web",
            category: "search",
            billable: true,
          },
        ],
      },
      [],
    );
    const { container } = render(
      <ReactFlowProvider>
        <div style={{ width: 1200, height: 700 }}>
          <RedesignedHostCanvas
            viewModel={viewModel}
            selectedNodeId={null}
            onSelectNode={() => {}}
            onClearSelection={() => {}}
            onAddServer={() => {}}
          />
        </div>
      </ReactFlowProvider>,
    );
    const builtin = container.querySelector(
      `.react-flow__node[data-id="${BUILTIN_TOOLS_NODE_ID}"]`,
    );
    const computer = container.querySelector(
      `.react-flow__node[data-id="${COMPUTER_NODE_ID}"]`,
    );
    expect(builtin).not.toBeNull();
    expect(computer).not.toBeNull();
    expect(
      within(builtin as HTMLElement).getByText("Web Search"),
    ).toBeInTheDocument();
    // No computer attached in the draft → ghost affordance.
    expect(
      within(computer as HTMLElement).getByText("+ Computer"),
    ).toBeInTheDocument();
  });
});

/**
 * Read-only mode — the surface the chatbox and environment canvas embeds ride
 * on. Rendered identically to the editable canvas but inert: no add affordance,
 * and every click is a single "take me to a writable editor" gesture rather
 * than a selection.
 */
describe("read-only mode", () => {
  function renderReadOnly(opts: {
    readOnly?: boolean;
    onRequestEdit?: () => void;
    onSelectNode?: (id: string) => void;
    onClearSelection?: () => void;
  }) {
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Test host",
        draft: emptyHostConfigInputV2(),
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [{ id: "s1", name: "bench", url: "https://x.test" }],
      },
      [],
    );
    return render(
      <ReactFlowProvider>
        <div style={{ width: 900, height: 700 }}>
          <RedesignedHostCanvas
            viewModel={viewModel}
            selectedNodeId={null}
            onSelectNode={opts.onSelectNode ?? (() => {})}
            onClearSelection={opts.onClearSelection ?? (() => {})}
            onAddServer={() => {}}
            readOnly={opts.readOnly ?? true}
            onRequestEdit={opts.onRequestEdit}
          />
        </div>
      </ReactFlowProvider>,
    );
  }

  it("filters the add-server pill out of the view model", () => {
    const { container } = renderReadOnly({});
    expect(
      container.querySelector(
        `.react-flow__node[data-id="${ADD_SERVER_NODE_ID}"]`,
      ),
    ).toBeNull();
    // The rest of the graph still renders — this is a summary, not a stub.
    expect(
      container.querySelector(`.react-flow__node[data-id="server-card:s1"]`),
    ).not.toBeNull();
  });

  it("keeps the add-server pill when NOT read-only (the control)", () => {
    const { container } = renderReadOnly({ readOnly: false });
    expect(
      container.querySelector(
        `.react-flow__node[data-id="${ADD_SERVER_NODE_ID}"]`,
      ),
    ).not.toBeNull();
  });

  it("routes a node click to onRequestEdit instead of onSelectNode", () => {
    const onRequestEdit = vi.fn();
    const onSelectNode = vi.fn();
    const { container } = renderReadOnly({ onRequestEdit, onSelectNode });

    const card = container.querySelector(
      `.react-flow__node[data-id="server-card:s1"]`,
    ) as HTMLElement;
    fireEvent.click(card);

    expect(onRequestEdit).toHaveBeenCalledTimes(1);
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  it("routes a pane click to onRequestEdit instead of onClearSelection", () => {
    const onRequestEdit = vi.fn();
    const onClearSelection = vi.fn();
    const { container } = renderReadOnly({ onRequestEdit, onClearSelection });

    fireEvent.click(container.querySelector(".react-flow__pane") as HTMLElement);

    expect(onRequestEdit).toHaveBeenCalledTimes(1);
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it("still clears selection on a pane click when NOT read-only (the control)", () => {
    const onRequestEdit = vi.fn();
    const onClearSelection = vi.fn();
    const { container } = renderReadOnly({
      readOnly: false,
      onRequestEdit,
      onClearSelection,
    });

    fireEvent.click(container.querySelector(".react-flow__pane") as HTMLElement);

    expect(onClearSelection).toHaveBeenCalledTimes(1);
    expect(onRequestEdit).not.toHaveBeenCalled();
  });
});

describe("shiftReflowedBranchEdges", () => {
  const islandEdge: Edge = {
    id: "host-to-computer",
    source: HOST_MATRIX_NODE_ID,
    target: COMPUTER_NODE_ID,
    type: "hostBranch",
    data: {
      fixedSourceX: 580,
      fixedSourceY: 54,
      fixedTargetX: 640,
      fixedTargetY: 54,
    },
  };
  const serverEdge: Edge = {
    id: "hub-to-server-x",
    source: SERVERS_HUB_NODE_ID,
    target: "server-card:x",
    type: "hostBranch",
    data: {
      fixedSourceX: 100,
      fixedSourceY: 200,
      fixedTargetX: 120,
      fixedTargetY: 300,
    },
  };
  const trunkEdge: Edge = {
    id: "host-matrix-to-hub",
    source: HOST_MATRIX_NODE_ID,
    target: SERVERS_HUB_NODE_ID,
    type: "hostTrunk",
  };

  it("is a no-op when dy is 0 (returns the same array reference)", () => {
    const edges = [islandEdge, serverEdge];
    expect(shiftReflowedBranchEdges(edges, 0)).toBe(edges);
  });

  it("shifts the servers-block branch edges down by dy", () => {
    const [shifted] = shiftReflowedBranchEdges([serverEdge], 40);
    expect(shifted.data).toMatchObject({
      fixedSourceY: 240,
      fixedTargetY: 340,
      // X is untouched.
      fixedSourceX: 100,
      fixedTargetX: 120,
    });
  });

  it("leaves island edges (sourced from the matrix) pinned in place", () => {
    const [shifted] = shiftReflowedBranchEdges([islandEdge], 40);
    // Same reference back, endpoints unchanged — the regression guard.
    expect(shifted).toBe(islandEdge);
    expect(shifted.data).toMatchObject({ fixedSourceY: 54, fixedTargetY: 54 });
  });

  it("ignores non-hostBranch edges (the measured-position trunk)", () => {
    const [shifted] = shiftReflowedBranchEdges([trunkEdge], 40);
    expect(shifted).toBe(trunkEdge);
  });
});
