import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
import { APPS_NODE_ID, BEHAVIOR_NODE_ID, PROTOCOL_NODE_ID } from "../../types";
import { RedesignedHostCanvas } from "../RedesignedHostCanvas";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

describe("RedesignedHostCanvas", () => {
  it("renders Agent as the behavior sub-node title without a secondary eyebrow", () => {
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Test",
        draft: emptyHostConfigInputV2(),
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );

    const { container } = render(
      <ReactFlowProvider>
        <div style={{ width: 400, height: 400 }}>
          <RedesignedHostCanvas
            viewModel={viewModel}
            selectedNodeId={BEHAVIOR_NODE_ID}
            onSelectNode={() => {}}
            onClearSelection={() => {}}
            onAddServer={() => {}}
          />
        </div>
      </ReactFlowProvider>,
    );

    const behaviorNode = container.querySelector(
      `.react-flow__node[data-id="${BEHAVIOR_NODE_ID}"]`,
    );
    expect(behaviorNode).not.toBeNull();

    const header = behaviorNode?.querySelector(".host-redesign-subnode > div");
    expect(header).not.toBeNull();
    const headerEl = header as HTMLElement;

    expect(within(headerEl).getByText("Agent")).toBeInTheDocument();
    const titleCol = headerEl.querySelector(".flex.min-w-0.flex-col");
    expect(titleCol?.querySelectorAll("span")).toHaveLength(1);

    expect(
      headerEl.className.includes("_5%") &&
        headerEl.className.includes("var(--primary)"),
    ).toBe(false);
  });

  it("renders a minimal MCP Protocol sub-node header without wire eyebrow", () => {
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Test",
        draft: emptyHostConfigInputV2(),
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );

    const { container } = render(
      <ReactFlowProvider>
        <div style={{ width: 400, height: 400 }}>
          <RedesignedHostCanvas
            viewModel={viewModel}
            selectedNodeId={PROTOCOL_NODE_ID}
            onSelectNode={() => {}}
            onClearSelection={() => {}}
            onAddServer={() => {}}
          />
        </div>
      </ReactFlowProvider>,
    );

    const protocolNode = container.querySelector(
      `.react-flow__node[data-id="${PROTOCOL_NODE_ID}"]`,
    );
    expect(protocolNode).not.toBeNull();

    const header = protocolNode?.querySelector(".host-redesign-subnode > div");
    expect(header).not.toBeNull();
    const headerEl = header as HTMLElement;

    expect(within(headerEl).getByText("MCP Protocol")).toBeInTheDocument();
    expect(within(headerEl).queryByText(/^wire$/i)).toBeNull();
  });

  it("renders a minimal Apps Extension sub-node header without SEP-1865 eyebrow or info tint", () => {
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "Test",
        draft: emptyHostConfigInputV2(),
        savedSnapshotId: "snap",
        isDirty: false,
        projectServers: [],
      },
      [],
    );

    const { container } = render(
      <ReactFlowProvider>
        <div style={{ width: 400, height: 400 }}>
          <RedesignedHostCanvas
            viewModel={viewModel}
            selectedNodeId={APPS_NODE_ID}
            onSelectNode={() => {}}
            onClearSelection={() => {}}
            onAddServer={() => {}}
          />
        </div>
      </ReactFlowProvider>,
    );

    const appsNode = container.querySelector(
      `.react-flow__node[data-id="${APPS_NODE_ID}"]`,
    );
    expect(appsNode).not.toBeNull();

    const header = appsNode?.querySelector(".host-redesign-subnode > div");
    expect(header).not.toBeNull();
    const headerEl = header as HTMLElement;

    expect(within(headerEl).getByText("Apps Extension")).toBeInTheDocument();
    expect(within(headerEl).queryByText(/SEP-1865/)).toBeNull();
    expect(headerEl.className.includes("var(--info")).toBe(false);
  });
});
