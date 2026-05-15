import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
import {
  AGENT_IDENTITY_NODE_ID,
  APPS_HUB_NODE_ID,
  PROTOCOL_HUB_NODE_ID,
  appsCapLeafNodeId,
  protocolLeafNodeId,
} from "../../types";
import { RedesignedHostCanvas } from "../RedesignedHostCanvas";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

function renderCanvas(viewModelOpts: {
  draft?: ReturnType<typeof emptyHostConfigInputV2>;
  hostName?: string;
}) {
  const viewModel = buildRedesignedHostCanvas(
    {
      hostName: viewModelOpts.hostName ?? "Test",
      draft: viewModelOpts.draft ?? emptyHostConfigInputV2(),
      savedSnapshotId: "snap",
      isDirty: false,
      projectServers: [],
    },
    [],
  );
  return render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
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
  it("renders the Agent identity card with the section title", () => {
    const { container } = renderCanvas({});
    const agentNode = container.querySelector(
      `.react-flow__node[data-id="${AGENT_IDENTITY_NODE_ID}"]`,
    );
    expect(agentNode).not.toBeNull();
    expect(within(agentNode as HTMLElement).getByText("Agent")).toBeInTheDocument();
  });

  it("renders the Protocol hub puck with title and a subtitle slot", () => {
    const { container } = renderCanvas({});
    const hub = container.querySelector(
      `.react-flow__node[data-id="${PROTOCOL_HUB_NODE_ID}"]`,
    );
    expect(hub).not.toBeNull();
    expect(within(hub as HTMLElement).getByText("MCP Protocol")).toBeInTheDocument();
    // Subtitle defaults to "SDK defaults" + ctx count for an empty draft.
    expect(
      within(hub as HTMLElement).getByText(/SDK defaults/),
    ).toBeInTheDocument();
  });

  it("renders the Apps hub puck with title", () => {
    const { container } = renderCanvas({});
    const hub = container.querySelector(
      `.react-flow__node[data-id="${APPS_HUB_NODE_ID}"]`,
    );
    expect(hub).not.toBeNull();
    expect(
      within(hub as HTMLElement).getByText("Apps Extension"),
    ).toBeInTheDocument();
  });

  it("renders an apps cap leaf with the canonical capability label", () => {
    const { container } = renderCanvas({});
    const leaf = container.querySelector(
      `.react-flow__node[data-id="${appsCapLeafNodeId("openLinks")}"]`,
    );
    expect(leaf).not.toBeNull();
    expect(
      within(leaf as HTMLElement).getByText("openLinks"),
    ).toBeInTheDocument();
  });

  it("strikes through cap leaves when the resolved blob omits them", () => {
    // Override that explicitly leaves out updateModelContext.
    const draft = emptyHostConfigInputV2({
      hostCapabilitiesOverride: {
        openLinks: {},
        logging: {},
      },
    });
    const { container } = renderCanvas({ draft });
    const updateLeaf = container.querySelector(
      `.react-flow__node[data-id="${appsCapLeafNodeId("updateModelContext")}"]`,
    );
    expect(updateLeaf).not.toBeNull();
    // The name span carries `line-through` when on=false.
    const nameSpan = (updateLeaf as HTMLElement).querySelector(
      ".line-through",
    );
    expect(nameSpan).not.toBeNull();
  });

  it("renders the always-emitted hostContext and timeout protocol leaves", () => {
    const { container } = renderCanvas({});
    expect(
      container.querySelector(
        `.react-flow__node[data-id="${protocolLeafNodeId("hostContext")}"]`,
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        `.react-flow__node[data-id="${protocolLeafNodeId("timeout")}"]`,
      ),
    ).not.toBeNull();
  });
});
