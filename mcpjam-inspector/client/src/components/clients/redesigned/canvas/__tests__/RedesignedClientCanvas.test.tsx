import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { HOST_MATRIX_NODE_ID } from "../../types";
import { RedesignedClientCanvas } from "../RedesignedClientCanvas";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

function renderCanvas(opts: {
  draft?: ReturnType<typeof emptyHostConfigInputV2>;
  hostName?: string;
}) {
  const viewModel = buildRedesignedHostCanvas(
    {
      hostName: opts.hostName ?? "Test host",
      draft: opts.draft ?? emptyHostConfigInputV2(),
      savedSnapshotId: "snap",
      isDirty: false,
      projectServers: [],
    },
    [],
  );
  return render(
    <ReactFlowProvider>
      <div style={{ width: 900, height: 700 }}>
        <RedesignedClientCanvas
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

describe("RedesignedClientCanvas", () => {
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

  it("renders the client capability rows and apps extension banner", () => {
    const { container } = renderCanvas({});
    const node = container.querySelector(
      `.react-flow__node[data-id="${HOST_MATRIX_NODE_ID}"]`,
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    const scope = within(node as HTMLElement);
    expect(scope.getByText("Client capabilities")).toBeInTheDocument();
    // The paper redesign nests Apps Extension caps under a "View iframe"
    // frame whose subtitle still names the extension. Match by substring.
    expect(scope.getByText(/Apps extension/)).toBeInTheDocument();
    expect(scope.getByText("roots")).toBeInTheDocument();
    expect(scope.getByText("openLinks")).toBeInTheDocument();
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
    // Off caps in the View frame carry the `hp-view-cap--off` class which
    // applies a dashed border + strike-through via CSS. Asserting the
    // semantic class beats asserting a Tailwind utility name that the
    // redesign no longer uses.
    expect(
      (node as HTMLElement).querySelector(".hp-view-cap--off"),
    ).not.toBeNull();
  });
});
